// Strumento "verifica_disponibilita" per Claude: controlla i dati, interroga WuBook e
// restituisce un risultato compatto da leggere al chiamante. Non prenota nulla.
const { formatInTimeZone } = require('date-fns-tz');
const { WuBookFormatoError } = require('./wubook');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
const MAX_NOTTI = 30;
const MAX_GIORNI_IN_ANTICIPO = 540;
const TASSA_EURO = 2.3;
const TASSA_MAX_NOTTI = 3;

const DEFINIZIONE = {
  name: 'verifica_disponibilita',
  description:
    'Verifica in tempo reale sul motore di prenotazione del Nazareth Residence le camere libere e il prezzo totale ' +
    'del soggiorno per UNA camera, colazione inclusa. Usalo ogni volta che il chiamante chiede prezzi o disponibilità, ' +
    'solo quando conosci data di arrivo, partenza o numero di notti e numero di persone. Non prenota e non blocca camere. ' +
    'Per un gruppo che userebbe più camere chiamalo una volta per camera con le persone di quella camera (al massimo quattro camere).',
  input_schema: {
    type: 'object',
    properties: {
      arrivo: { type: 'string', description: 'Data di arrivo nel formato AAAA-MM-GG, calcolata rispetto alla data di oggi.' },
      partenza: { type: 'string', description: 'Data di partenza nel formato AAAA-MM-GG. In alternativa indica notti.' },
      notti: { type: 'integer', description: 'Numero di notti, se il chiamante non dice la data di partenza.' },
      adulti: { type: 'integer', description: 'Numero di adulti nella camera.' },
      bambini: { type: 'integer', description: 'Numero di bambini nella camera (0 se nessuno).' },
    },
    required: ['arrivo', 'adulti'],
  },
};

const ISO = /^\d{4}-\d{2}-\d{2}$/;

function giorniTra(daIso, aIso) {
  return Math.round((Date.parse(`${aIso}T00:00:00Z`) - Date.parse(`${daIso}T00:00:00Z`)) / 86400000);
}

function aggiungiGiorni(iso, giorni) {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + giorni * 86400000).toISOString().slice(0, 10);
}

function dataValida(iso) {
  if (!ISO.test(iso ?? '')) return false;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso;
}

/** Controlla l'input del modello: { errore } oppure { arrivo, partenza, notti, adulti, bambini }. */
function validaInput(input, oggi) {
  const { arrivo } = input ?? {};
  if (!dataValida(arrivo)) return { errore: 'Data di arrivo mancante o non valida: chiedila al chiamante.' };
  if (arrivo < oggi) return { errore: `La data di arrivo ${arrivo} è nel passato (oggi è ${oggi}): chiedi conferma della data.` };
  if (giorniTra(oggi, arrivo) > MAX_GIORNI_IN_ANTICIPO) return { errore: 'Data di arrivo troppo lontana: rimanda al sito.' };

  let partenza = input.partenza;
  if (partenza != null && partenza !== '') {
    if (!dataValida(partenza)) return { errore: 'Data di partenza non valida: chiedila al chiamante.' };
  } else if (Number.isInteger(input.notti) && input.notti > 0) {
    partenza = aggiungiGiorni(arrivo, input.notti);
  } else {
    return { errore: 'Manca la data di partenza o il numero di notti: chiedilo al chiamante.' };
  }
  const notti = giorniTra(arrivo, partenza);
  if (notti < 1) return { errore: 'La partenza deve essere dopo l\'arrivo: chiedi conferma delle date.' };
  if (notti > MAX_NOTTI) return { errore: `Soggiorno di ${notti} notti: per soggiorni così lunghi rimanda al sito o a WhatsApp.` };

  const adulti = Number(input.adulti);
  const bambini = input.bambini == null ? 0 : Number(input.bambini);
  if (!Number.isInteger(adulti) || adulti < 1 || adulti > 10) return { errore: 'Numero di adulti mancante o non valido: chiedilo.' };
  if (!Number.isInteger(bambini) || bambini < 0 || bambini > 10) return { errore: 'Numero di bambini non valido: chiedilo.' };

  return { arrivo, partenza, notti, adulti, bambini };
}

function nota({ notti, persone, bambini }) {
  const nottiTassa = Math.min(notti, TASSA_MAX_NOTTI);
  const tassaMax = (TASSA_EURO * persone * nottiTassa).toFixed(2).replace('.', ',');
  return [
    'Prezzi totali per l\'intero soggiorno e per una camera, colazione inclusa, dal sito in questo momento: possono cambiare.',
    `Tassa di soggiorno esclusa: 2,30 euro a persona a notte, per al massimo 3 notti, esenti i minori di 16 anni (per questo soggiorno al massimo ${tassaMax} euro).`,
    bambini ? 'I bambini sono contati come ospiti della camera: eventuali riduzioni per bambini vanno verificate sul sito.' : null,
    'Non hai prenotato né bloccato nulla.',
  ].filter(Boolean).join(' ');
}

/**
 * Esecutore dello strumento.
 * @returns {Promise<{ contenuto: string, errore: boolean, esito: string }>}
 */
function creaStrumentoDisponibilita({ wubook, now = () => Date.now(), log = () => {} }) {
  async function esegui(input, { chiamataId } = {}) {
    const oggi = formatInTimeZone(new Date(now()), TIMEZONE, 'yyyy-MM-dd');
    const dati = validaInput(input, oggi);
    if (dati.errore) {
      log(chiamataId, 'verifica_disponibilita', { esito: 'input_non_valido' });
      return { contenuto: JSON.stringify({ esito: 'dati_mancanti', istruzione: dati.errore }), errore: true, esito: 'input_non_valido' };
    }

    const persone = dati.adulti + dati.bambini;
    const inizio = now();
    try {
      const { inv, daCache } = await wubook.inventario(dati.arrivo, dati.partenza);
      const { offerte, capienzaMassima } = wubook.calcolaOfferte(inv, { persone });
      const base = {
        arrivo: dati.arrivo,
        partenza: dati.partenza,
        notti: dati.notti,
        ospiti_nella_camera: { adulti: dati.adulti, bambini: dati.bambini },
      };

      let risultato;
      if (offerte.length) {
        risultato = {
          esito: 'disponibile',
          ...base,
          camere: offerte.map((o) => ({ tipologia: o.tipologia, prezzo_totale_euro: o.prezzoTotale, ultima_camera: o.ultimaCamera })),
          nota: nota({ notti: dati.notti, persone, bambini: dati.bambini }),
        };
      } else if (persone > capienzaMassima && capienzaMassima > 0) {
        risultato = {
          esito: 'troppe_persone_per_una_camera',
          ...base,
          istruzione: `Nessuna camera ospita ${persone} persone: se il chiamante è d'accordo, verifica più camere dividendo le persone (al massimo quattro camere).`,
        };
      } else {
        risultato = {
          esito: 'nessuna_disponibilita',
          ...base,
          istruzione: 'Nessuna camera disponibile sul sito per queste date e questo numero di persone. Suggerisci altre date o rimanda al sito o a WhatsApp.',
        };
      }
      log(chiamataId, 'verifica_disponibilita', { esito: risultato.esito, ms: now() - inizio, cache: daCache, notti: dati.notti });
      return { contenuto: JSON.stringify(risultato), errore: false, esito: risultato.esito };
    } catch (error) {
      const esito = error instanceof WuBookFormatoError ? 'formato_cambiato' : 'non_raggiungibile';
      log(chiamataId, 'verifica_disponibilita', { esito, ms: now() - inizio, tipo: error.name, messaggio: String(error.message).slice(0, 200) });
      return {
        contenuto: JSON.stringify({
          esito: 'verifica_non_riuscita',
          istruzione: 'In questo momento non è possibile verificare prezzi e disponibilità. Dillo al chiamante e rimanda al sito o a WhatsApp; se possibile, offri la richiamata. Non dare prezzi.',
        }),
        errore: true,
        esito,
      };
    }
  }

  return { definizione: DEFINIZIONE, esegui };
}

module.exports = { creaStrumentoDisponibilita, validaInput, DEFINIZIONE };
