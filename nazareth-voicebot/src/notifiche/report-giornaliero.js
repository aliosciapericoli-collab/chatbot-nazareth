// Report del mattino a chi gestisce il bot: statistiche delle chiamate del giorno prima,
// domande a cui il bot non ha saputo rispondere, analisi delle richieste dei clienti e un
// prompt pronto da incollare in Claude Code per completare la base di conoscenza.
//
// Il bot non si "addestra" da solo: le risposte nuove le decide chi gestisce la struttura,
// poi Claude Code le aggiunge a knowledge/nazareth.md. Così il bot non impara mai cose
// sbagliate dette dai chiamanti.
const { formatInTimeZone, fromZonedTime } = require('date-fns-tz');
const { NOMI_ARGOMENTI } = require('../centralino/argomenti');

const TIMEZONE_PREDEFINITA = 'Europe/Rome';
const ORA_PREDEFINITA = 7;
const FINESTRA_SENZA_ARCHIVIO_ORE = 2;
const OGGETTO = 'Vocalba – report del';
const REPO = 'aliosciapericoli-collab/chatbot-nazareth';
const BRANCH_PREDEFINITO = 'claude/charming-shannon-7pom25';

// Stesse etichette della dashboard.
const ESITI = {
  congedo: 'conclusa con saluto',
  reception: 'passata alla reception',
  silenzio: 'nessuna risposta',
  limite_turni: 'troppe domande',
  chiusa_dal_chiamante: 'ha riagganciato',
  annullata: 'annullata',
  ripiego: 'errore, dati i contatti',
};

/** Giorno di ieri (ora di Roma) con inizio e fine in UTC. */
function periodoIeri(adesso = new Date(), timezone = TIMEZONE_PREDEFINITA) {
  const oggi = formatInTimeZone(adesso, timezone, 'yyyy-MM-dd');
  const a = fromZonedTime(`${oggi}T00:00:00`, timezone);
  const giorno = formatInTimeZone(new Date(a.getTime() - 12 * 3600000), timezone, 'yyyy-MM-dd');
  const da = fromZonedTime(`${giorno}T00:00:00`, timezone);
  return { giorno, da, a };
}

function conta(valori) {
  const mappa = new Map();
  for (const v of valori) mappa.set(v, (mappa.get(v) ?? 0) + 1);
  return [...mappa.entries()].sort((x, y) => y[1] - x[1]);
}

function euro(n) {
  return `${Math.round(n)} euro`;
}

/**
 * Raccoglie i dati del giorno. Con l'archivio attivo ci sono esiti, argomenti, preventivi e
 * frasi dei clienti; senza, solo il registro Twilio e le domande senza risposta dall'ultimo riavvio.
 */
async function raccogliDati({ archivio, registroTwilio, mancantiRecenti, periodo }) {
  const { da, a } = periodo;
  if (archivio?.attivo) {
    const d = await archivio.datiPeriodo({ da, a });
    return { completo: true, ...d };
  }
  let chiamate = [];
  if (registroTwilio?.disponibile) {
    const registro = await registroTwilio.chiamateRecenti({ giorni: 2 });
    chiamate = registro
      .filter((c) => (!c.direction || c.direction === 'inbound') && !c.parentCallSid && c.startTime)
      .filter((c) => new Date(c.startTime) >= da && new Date(c.startTime) < a)
      .map((c) => ({
        durataSec: Number(c.duration) || 0,
        costo: c.price == null || c.price === '' ? null : Math.abs(Number(c.price)),
        valuta: c.priceUnit || null,
      }));
  }
  const mancanti = (mancantiRecenti?.() ?? [])
    .filter((m) => new Date(m.ts) >= da && new Date(m.ts) < a)
    .reverse();
  return { completo: false, chiamate, mancanti, frasiClienti: [] };
}

/** Numeri del giorno, calcolati dai dati raccolti. Funzione pura. */
function calcolaStatistiche(dati) {
  const c = dati.chiamate;
  const minuti = Math.round(c.reduce((t, x) => t + (x.durataSec || 0), 0) / 60);
  const tariffate = c.filter((x) => x.costo != null);
  const stat = {
    chiamate: c.length,
    minuti,
    costo: tariffate.reduce((t, x) => t + x.costo, 0),
    valuta: tariffate[0]?.valuta ?? null,
    mancanti: dati.mancanti.length,
  };
  if (!dati.completo) return stat;
  return {
    ...stat,
    conAssistente: c.filter((x) => x.ingresso === 'reception_chiusa' || x.ingresso === 'reception_non_disponibile').length,
    esiti: conta(c.map((x) => x.esito).filter(Boolean)),
    argomenti: conta(c.flatMap((x) => x.argomenti ?? [])),
    preventivi: c.filter((x) => x.preventivo != null).map((x) => x.preventivo),
    richiamate: c.filter((x) => x.richiamata).length,
  };
}

/** Prompt da incollare in Claude Code per aggiungere le risposte mancanti. Funzione pura. */
function componiPromptClaudeCode({ mancanti, branch = BRANCH_PREDEFINITO }) {
  const domande = [...new Set(mancanti.map((m) => m.domanda.trim()).filter(Boolean))];
  if (!domande.length) return null;
  return [
    `Lavora nel repo ${REPO}, cartella nazareth-voicebot, branch ${branch}.`,
    'Obiettivo: completare la base di conoscenza del voicebot telefonico del Nazareth con le domande',
    'dei clienti a cui ieri non ha saputo rispondere.',
    '',
    '1. Leggi knowledge/nazareth.md e le regole in src/claude.js: il bot usa SOLO la base di conoscenza.',
    '2. Aggiungi a knowledge/nazareth.md, nella sezione più adatta e nello stesso stile, le risposte qui sotto.',
    '   Usa SOLO le risposte che ho scritto io, senza aggiungere dettagli. Se una risposta è rimasta',
    '   [DA COMPILARE] o vuota, non aggiungere nulla per quella domanda e segnalamelo alla fine.',
    '',
    ...domande.map((d) => `   - Domanda: "${d}"\n     Risposta: [DA COMPILARE]`),
    '',
    '3. Esegui npm test. Se passa, fai commit e push sullo stesso branch: Render ripubblica da solo.',
    '4. Controlla su Render (servizio nazareth-voicebot) che il deploy sia Live e dimmi il commit.',
  ].join('\n');
}

/** Oggetto e testo dell'email. Funzione pura. */
function componiReport({ periodo, dati, stat, analisi, cliente, branch }) {
  const giornoLeggibile = periodo.giorno.split('-').reverse().join('/');
  const righe = [`Report del receptionist virtuale${cliente ? ` di ${cliente}` : ''} – ${giornoLeggibile}`, ''];

  righe.push('NUMERI DEL GIORNO');
  if (!stat.chiamate) {
    righe.push('- Nessuna chiamata ricevuta.');
  } else {
    righe.push(`- Chiamate ricevute: ${stat.chiamate}${stat.conAssistente != null ? ` (gestite dall'assistente: ${stat.conAssistente})` : ''}`);
    righe.push(`- Minuti totali: ${stat.minuti}${stat.costo ? `, costo Twilio ${stat.costo.toFixed(2)} ${stat.valuta ?? ''}`.trimEnd() : ''}`);
  }
  if (dati.completo && stat.chiamate) {
    if (stat.esiti.length) righe.push(`- Esiti: ${stat.esiti.map(([e, n]) => `${ESITI[e] ?? e} ${n}`).join(', ')}`);
    if (stat.argomenti.length) righe.push(`- Argomenti più chiesti: ${stat.argomenti.slice(0, 6).map(([a, n]) => `${NOMI_ARGOMENTI[a] ?? a} ${n}`).join(', ')}`);
    if (stat.preventivi.length) {
      const media = stat.preventivi.reduce((t, p) => t + p, 0) / stat.preventivi.length;
      righe.push(`- Preventivi dati al telefono: ${stat.preventivi.length} (prezzo minimo medio ${euro(media)})`);
    }
    righe.push(`- Richieste di richiamata alla reception: ${stat.richiamate}`);
  }
  righe.push('');

  righe.push(`DOMANDE SENZA RISPOSTA (${stat.mancanti})`);
  if (!dati.mancanti.length) righe.push('- Nessuna: la base di conoscenza ha coperto tutto.');
  else for (const m of dati.mancanti) righe.push(`- ${formatInTimeZone(new Date(m.ts), TIMEZONE_PREDEFINITA, 'HH:mm')} – ${m.domanda}`);
  righe.push('');

  if (analisi) {
    righe.push('ANALISI DELLE RICHIESTE (Claude)', analisi.trim(), '');
  }

  const prompt = componiPromptClaudeCode({ mancanti: dati.mancanti, branch });
  if (prompt) {
    righe.push(
      'PROMPT PRONTO PER CLAUDE CODE',
      'Compila le risposte al posto di [DA COMPILARE], poi incolla tutto in Claude Code.',
      '-----8<-----',
      prompt,
      '-----8<-----',
      ''
    );
  }

  if (!dati.completo) {
    righe.push(
      'Nota: l\'archivio delle conversazioni è spento (DATABASE_URL non impostato). Esiti, argomenti,',
      'preventivi e analisi delle richieste compaiono quando l\'archivio è attivo; le domande senza',
      'risposta sono solo quelle arrivate dopo l\'ultimo riavvio del servizio.'
    );
  }

  return {
    subject: `${OGGETTO} ${giornoLeggibile}: ${stat.chiamate} chiamate, ${stat.mancanti} senza risposta`,
    text: righe.join('\n'),
  };
}

/**
 * Analisi breve delle frasi dei clienti con Claude: richieste ricorrenti e punti deboli del bot.
 * Restituisce null se non ci sono frasi o se la chiamata a Claude non riesce.
 */
async function analizzaRichieste({ client, model, frasiClienti, mancanti, timeoutMs = 30000 }) {
  if (!client || !frasiClienti?.length) return null;
  const elenco = frasiClienti.map((f) => `[${f.chiamata.slice(-4)}] ${String(f.testo).slice(0, 300)}`).join('\n');
  const senzaRisposta = mancanti.map((m) => `- ${m.domanda}`).join('\n') || '- nessuna';
  try {
    const risposta = await client.messages.create({
      model,
      max_tokens: 600,
      system: 'Analizzi le telefonate ricevute dal receptionist virtuale di un hotel. Scrivi in italiano, testo semplice senza markdown, al massimo 150 parole. Non riportare nomi, numeri di telefono o altri dati personali dei chiamanti.',
      messages: [{
        role: 'user',
        content: `Frasi dette dai clienti ieri (tra parentesi le ultime cifre dell'identificativo della chiamata):\n${elenco}\n\nDomande a cui il bot non ha saputo rispondere:\n${senzaRisposta}\n\nIn tre brevi paragrafi: 1) cosa hanno chiesto di più i clienti; 2) dove il bot sembra aver faticato (domande ripetute, frasi non capite, richieste di parlare con una persona); 3) quali informazioni conviene aggiungere alla base di conoscenza. Non inventare risposte: indica solo gli argomenti.`,
      }],
    }, { timeout: timeoutMs });
    return risposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Pianifica il report: controlla ogni minuto e lo manda una volta al giorno dopo l'ora indicata.
 * Con l'archivio attivo l'invio è segnato nel database, così un riavvio non manda doppioni.
 */
function creaReportGiornaliero({
  archivio,
  registroTwilio,
  mancantiRecenti,
  inviaEmail,
  destinatario,
  client,
  model,
  cliente,
  branch,
  ora = ORA_PREDEFINITA,
  timezone = TIMEZONE_PREDEFINITA,
  log = () => {},
  now = () => new Date(),
}) {
  const attivo = Boolean(inviaEmail && destinatario);
  let ultimoGiornoInviato = null;
  let inCorso = false;

  async function inviaPer(periodo) {
    const dati = await raccogliDati({ archivio, registroTwilio, mancantiRecenti, periodo });
    const stat = calcolaStatistiche(dati);
    const analisi = await analizzaRichieste({ client, model, frasiClienti: dati.frasiClienti, mancanti: dati.mancanti });
    const { subject, text } = componiReport({ periodo, dati, stat, analisi, cliente, branch });
    await inviaEmail({ to: destinatario, subject, text });
    return { stat };
  }

  /** Controllo periodico: non lancia mai. */
  async function controlla() {
    if (!attivo || inCorso) return false;
    const adesso = now();
    const oraAdesso = Number(formatInTimeZone(adesso, timezone, 'H'));
    if (oraAdesso < ora) return false;
    // Senza archivio l'invio è ricordato solo in memoria: fuori dalla finestra del mattino un
    // riavvio (es. un deploy nel pomeriggio) rimanderebbe il report di ieri.
    if (!archivio?.attivo && oraAdesso >= ora + FINESTRA_SENZA_ARCHIVIO_ORE) return false;
    const periodo = periodoIeri(adesso, timezone);
    if (ultimoGiornoInviato === periodo.giorno) return false;
    inCorso = true;
    try {
      if (archivio?.attivo) {
        if (await archivio.reportGiaInviato(periodo.giorno)) {
          ultimoGiornoInviato = periodo.giorno;
          return false;
        }
        if (!(await archivio.segnaReport(periodo.giorno))) {
          ultimoGiornoInviato = periodo.giorno;
          return false;
        }
      }
      ultimoGiornoInviato = periodo.giorno;
      const { stat } = await inviaPer(periodo);
      log(null, 'report_inviato', { giorno: periodo.giorno, chiamate: stat.chiamate, mancanti: stat.mancanti });
      return true;
    } catch (error) {
      log(null, 'report_non_inviato', { giorno: periodo.giorno, tipo: error.name, codice: error.code });
      return false;
    } finally {
      inCorso = false;
    }
  }

  function avvia({ ogniMs = 60 * 1000 } = {}) {
    if (!attivo) return;
    controlla();
    setInterval(controlla, ogniMs).unref();
  }

  return { attivo, controlla, avvia, inviaPer, destinatario, ora };
}

module.exports = {
  creaReportGiornaliero,
  componiReport,
  componiPromptClaudeCode,
  calcolaStatistiche,
  raccogliDati,
  periodoIeri,
  analizzaRichieste,
  OGGETTO,
};
