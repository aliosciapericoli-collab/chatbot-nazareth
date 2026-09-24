// Metriche del voicebot in memoria, alimentate dagli eventi di log del centralino.
// Nessun dato personale: solo id della chiamata (mascherato in uscita), tempi ed esiti.
// I dati si azzerano a ogni riavvio del server.
const { formatInTimeZone } = require('date-fns-tz');
const { NOMI_ARGOMENTI } = require('../centralino/argomenti');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
// Dopo questo tempo senza eventi una chiamata senza esito si considera chiusa dal chiamante.
const INATTIVITA_MS = 5 * 60 * 1000;
// Un errore più vecchio di così non segna più il servizio come in difficoltà.
const FINESTRA_SALUTE_MS = 6 * 60 * 60 * 1000;
const FINESTRA_MS = 24 * 60 * 60 * 1000;
const VERIFICHE_RIUSCITE = new Set(['disponibile', 'nessuna_disponibilita', 'troppe_persone_per_una_camera']);
const VERIFICHE_FALLITE = new Set(['non_raggiungibile', 'formato_cambiato']);

function ora(ms) {
  return Number(formatInTimeZone(new Date(ms), TIMEZONE, 'H'));
}

function mascheraId(id) {
  return id ? `…${String(id).slice(-6)}` : '—';
}

function percentile(valori, p) {
  if (valori.length === 0) return null;
  const ordinati = [...valori].sort((a, b) => a - b);
  return ordinati[Math.min(ordinati.length - 1, Math.ceil((p / 100) * ordinati.length) - 1)];
}

function media(valori) {
  return valori.length ? Math.round(valori.reduce((a, b) => a + b, 0) / valori.length) : null;
}

function creaMetriche({ maxChiamate = 500, maxErrori = 20, now = () => Date.now() } = {}) {
  const avvio = now();
  const chiamate = new Map(); // id → record, in ordine di arrivo
  const errori = [];
  const verifiche = []; // { ts, esito } delle verifiche WuBook e dei prezzi bloccati
  // Stato dei servizi esterni: ultimo esito positivo e ultimo errore.
  const salute = { claude: {}, wubook: {}, email: {} };
  // Il numero d'ordine dice quale è venuto dopo, anche a parità di orario.
  let ordine = 0;
  const segnaOk = (c) => { salute[c].ok = now(); salute[c].ordineOk = ++ordine; };
  const segnaErrore = (c) => { salute[c].errore = now(); salute[c].ordineErrore = ++ordine; };

  function record(id) {
    let r = chiamate.get(id);
    if (!r) {
      r = {
        id, inizio: now(), aggiornata: now(), ingresso: null, domande: 0, latenzeMs: [], causa: null, richiamata: null,
        argomenti: new Set(), preventivi: 0, valorePreventivo: null,
      };
      chiamate.set(id, r);
      // Tiene solo le chiamate più recenti.
      if (chiamate.size > maxChiamate) chiamate.delete(chiamate.keys().next().value);
    }
    r.aggiornata = now();
    return r;
  }

  function registra(chiamataId, evento, dettagli = {}) {
    if (!chiamataId) return;
    const r = record(chiamataId);

    switch (evento) {
      case 'assistente':
        r.ingresso = dettagli.motivo === 'chiusa' ? 'reception_chiusa' : 'reception_non_disponibile';
        break;
      case 'inoltro_reception':
        r.ingresso ??= 'inoltro_reception';
        break;
      case 'domanda':
        for (const a of dettagli.argomenti ?? []) r.argomenti.add(a);
        break;
      case 'risposta_claude':
        r.domande += 1;
        r.latenzeMs.push(dettagli.ms);
        segnaOk('claude');
        break;
      case 'errore_claude':
        segnaErrore('claude');
      // falls through
      case 'errore_centralino':
        errori.push({ ts: now(), chiamata: mascheraId(chiamataId), evento, tipo: dettagli.tipo, status: dettagli.status, messaggio: dettagli.messaggio });
        if (errori.length > maxErrori) errori.shift();
        break;
      case 'chiusura':
        r.causa = dettagli.causa;
        break;
      case 'prezzo_bloccato':
        verifiche.push({ ts: now(), esito: 'prezzo_bloccato' });
        errori.push({ ts: now(), chiamata: mascheraId(chiamataId), evento, tipo: 'prezzo_bloccato', messaggio: 'Prezzo senza verifica bloccato: il cliente è stato rimandato al sito' });
        if (errori.length > maxErrori) errori.shift();
        break;
      case 'verifica_disponibilita':
        verifiche.push({ ts: now(), esito: dettagli.esito });
        if (verifiche.length > 2000) verifiche.shift();
        if (VERIFICHE_RIUSCITE.has(dettagli.esito)) segnaOk('wubook');
        if (VERIFICHE_FALLITE.has(dettagli.esito)) segnaErrore('wubook');
        if (dettagli.esito === 'disponibile') {
          r.preventivi += 1;
          // Vale l'ultimo preventivo della chiamata: una chiamata, una possibile prenotazione.
          if (typeof dettagli.prezzoMinimo === 'number') r.valorePreventivo = dettagli.prezzoMinimo;
        }
        if (dettagli.esito === 'non_raggiungibile' || dettagli.esito === 'formato_cambiato') {
          errori.push({ ts: now(), chiamata: mascheraId(chiamataId), evento, tipo: dettagli.esito, messaggio: dettagli.messaggio || 'Verifica WuBook non riuscita' });
          if (errori.length > maxErrori) errori.shift();
        }
        break;
      case 'richiamata_richiesta':
        r.richiamata = 'in_invio';
        break;
      case 'richiamata_email_inviata':
        r.richiamata = 'email_inviata';
        segnaOk('email');
        break;
      case 'richiamata_email_non_inviata':
      case 'richiamata_email_errore':
        r.richiamata = 'email_non_inviata';
        segnaErrore('email');
        errori.push({ ts: now(), chiamata: mascheraId(chiamataId), evento, tipo: dettagli.motivo ?? dettagli.codice ?? dettagli.tipo ?? 'email', messaggio: 'Richiamata non inviata per email: controllare SMTP' });
        if (errori.length > maxErrori) errori.shift();
        break;
      default:
        break;
    }
  }

  function esito(r, adesso) {
    if (r.causa) return r.causa;
    return adesso - r.aggiornata > INATTIVITA_MS ? 'chiusa_dal_chiamante' : 'in_corso';
  }

  function statoSalute(c, adesso) {
    const { ok, errore, ordineOk = 0, ordineErrore = 0 } = salute[c];
    if (errore && adesso - errore < FINESTRA_SALUTE_MS && ordineErrore > ordineOk) {
      return { stato: 'problema', ultimoErrore: new Date(errore).toISOString() };
    }
    if (ok) return { stato: 'ok', ultimoOk: new Date(ok).toISOString() };
    return { stato: 'nessun_dato' };
  }

  function riepilogo() {
    const adesso = now();
    // Finestra mobile di 24 ore: segue il turno di notte senza azzerarsi a mezzanotte.
    const dal = adesso - FINESTRA_MS;
    const tutte = [...chiamate.values()];
    const diOggi = tutte.filter((r) => r.inizio > dal);
    const latenzeOggi = diOggi.flatMap((r) => r.latenzeMs);

    // Una barra per ora, dalla più vecchia all'ora corrente.
    const perOra = Array.from({ length: 24 }, (_, i) => ({ ora: ora(adesso - (23 - i) * 3600000), chiamate: 0 }));
    for (const r of diOggi) {
      const i = 23 - Math.floor((adesso - r.inizio) / 3600000);
      if (i >= 0 && i < 24) perOra[i].chiamate += 1;
    }

    const contaEsito = (nome) => diOggi.filter((r) => esito(r, adesso) === nome).length;

    return {
      generatoIl: new Date(adesso).toISOString(),
      datiDal: new Date(avvio).toISOString(),
      ultime24h: {
        dal: new Date(dal).toISOString(),
        chiamate: diOggi.length,
        conAssistente: diOggi.filter((r) => r.ingresso && r.ingresso !== 'inoltro_reception').length,
        inoltrateReception: diOggi.filter((r) => r.ingresso === 'inoltro_reception').length,
        domande: diOggi.reduce((tot, r) => tot + r.domande, 0),
        latenzaMediaMs: media(latenzeOggi),
        verifichePrezzi: (() => {
          const diOggiV = verifiche.filter((v) => v.ts > dal);
          const conta = (...esiti) => diOggiV.filter((v) => esiti.includes(v.esito)).length;
          return {
            riuscite: conta('disponibile', 'nessuna_disponibilita', 'troppe_persone_per_una_camera'),
            nonRiuscite: conta('non_raggiungibile', 'formato_cambiato'),
            prezziBloccati: conta('prezzo_bloccato'),
          };
        })(),
        preventivi: {
          chiamate: diOggi.filter((r) => r.preventivi > 0).length,
          valoreEuro: diOggi.reduce((tot, r) => tot + (r.valorePreventivo ?? 0), 0),
        },
        argomenti: (() => {
          const conteggi = {};
          for (const r of diOggi) for (const a of r.argomenti) conteggi[a] = (conteggi[a] ?? 0) + 1;
          return Object.entries(conteggi)
            .map(([id, chiamate]) => ({ id, nome: NOMI_ARGOMENTI[id] ?? id, chiamate }))
            .sort((a, b) => b.chiamate - a.chiamate || a.nome.localeCompare(b.nome));
        })(),
        richiamate: {
          richieste: diOggi.filter((r) => r.richiamata).length,
          emailInviate: diOggi.filter((r) => r.richiamata === 'email_inviata').length,
          emailNonInviate: diOggi.filter((r) => r.richiamata === 'email_non_inviata').length,
        },
        latenzaP95Ms: percentile(latenzeOggi, 95),
        esiti: {
          congedo: contaEsito('congedo'),
          ripiego: contaEsito('ripiego'),
          silenzio: contaEsito('silenzio'),
          limite_turni: contaEsito('limite_turni'),
          chiusa_dal_chiamante: contaEsito('chiusa_dal_chiamante'),
          in_corso: contaEsito('in_corso'),
        },
        perOra,
      },
      ultimeChiamate: tutte
        .slice(-50)
        .reverse()
        .map((r) => ({
          id: mascheraId(r.id),
          inizio: new Date(r.inizio).toISOString(),
          ingresso: r.ingresso,
          domande: r.domande,
          latenzaMediaMs: media(r.latenzeMs),
          esito: esito(r, adesso),
          richiamata: r.richiamata,
          argomenti: [...r.argomenti].map((a) => NOMI_ARGOMENTI[a] ?? a),
          preventivo: r.valorePreventivo,
        })),
      salute: {
        claude: statoSalute('claude', adesso),
        wubook: statoSalute('wubook', adesso),
        email: statoSalute('email', adesso),
      },
      errori: [...errori].reverse().map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })),
    };
  }

  return { registra, riepilogo };
}

module.exports = { creaMetriche, mascheraId };
