// Metriche del voicebot in memoria, alimentate dagli eventi di log del centralino.
// Nessun dato personale: solo id della chiamata (mascherato in uscita), tempi ed esiti.
// I dati si azzerano a ogni riavvio del server.
const { formatInTimeZone } = require('date-fns-tz');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
// Dopo questo tempo senza eventi una chiamata senza esito si considera chiusa dal chiamante.
const INATTIVITA_MS = 5 * 60 * 1000;

function giorno(ms) {
  return formatInTimeZone(new Date(ms), TIMEZONE, 'yyyy-MM-dd');
}

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

  function record(id) {
    let r = chiamate.get(id);
    if (!r) {
      r = { id, inizio: now(), aggiornata: now(), ingresso: null, domande: 0, latenzeMs: [], causa: null, richiamata: null };
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
      case 'risposta_claude':
        r.domande += 1;
        r.latenzeMs.push(dettagli.ms);
        break;
      case 'errore_claude':
      case 'errore_centralino':
        errori.push({ ts: now(), chiamata: mascheraId(chiamataId), evento, tipo: dettagli.tipo, status: dettagli.status, messaggio: dettagli.messaggio });
        if (errori.length > maxErrori) errori.shift();
        break;
      case 'chiusura':
        r.causa = dettagli.causa;
        break;
      case 'richiamata_richiesta':
        r.richiamata = 'in_invio';
        break;
      case 'richiamata_email_inviata':
        r.richiamata = 'email_inviata';
        break;
      case 'richiamata_email_non_inviata':
      case 'richiamata_email_errore':
        r.richiamata = 'email_non_inviata';
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

  function riepilogo() {
    const adesso = now();
    const oggi = giorno(adesso);
    const tutte = [...chiamate.values()];
    const diOggi = tutte.filter((r) => giorno(r.inizio) === oggi);
    const latenzeOggi = diOggi.flatMap((r) => r.latenzeMs);

    const perOra = Array.from({ length: 24 }, (_, h) => ({ ora: h, chiamate: 0 }));
    for (const r of diOggi) perOra[ora(r.inizio)].chiamate += 1;

    const contaEsito = (nome) => diOggi.filter((r) => esito(r, adesso) === nome).length;

    return {
      generatoIl: new Date(adesso).toISOString(),
      datiDal: new Date(avvio).toISOString(),
      oggi: {
        data: oggi,
        chiamate: diOggi.length,
        conAssistente: diOggi.filter((r) => r.ingresso && r.ingresso !== 'inoltro_reception').length,
        inoltrateReception: diOggi.filter((r) => r.ingresso === 'inoltro_reception').length,
        domande: diOggi.reduce((tot, r) => tot + r.domande, 0),
        latenzaMediaMs: media(latenzeOggi),
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
        })),
      errori: [...errori].reverse().map((e) => ({ ...e, ts: new Date(e.ts).toISOString() })),
    };
  }

  return { registra, riepilogo };
}

module.exports = { creaMetriche, mascheraId };
