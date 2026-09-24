// Integrazione con l'API Anthropic (Claude) per le risposte dell'assistente vocale.
const Anthropic = require('@anthropic-ai/sdk');
const { knowledgeBase } = require('./knowledge-base');

// Modello Haiku più recente secondo https://platform.claude.com/docs/en/about-claude/models/overview
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 300;

// Il modello lo aggiunge in fondo quando la conversazione è finita.
const FINE_CONVERSAZIONE = '[FINE]';
// Blocco con i dati della richiamata confermati dal chiamante; non viene letto al telefono.
const APRI_RICHIAMATA = '[RICHIAMATA]';
const CHIUDI_RICHIAMATA = '[/RICHIAMATA]';

// Istruzioni del bot. La sezione sulla richiamata c'è solo se l'email alla reception è
// configurata: senza, il bot non deve nemmeno nominarla.
function componiPrompt({ richiamata }) {
  const regoleRichiamata = `

Richiamata dalla reception:
- Quando il chiamante ha bisogno di qualcosa che non puoi dare (prezzi, disponibilità, prenotazioni, gruppi, casi particolari) oppure chiede un operatore, dopo aver risposto per quanto puoi offri: "Se vuole, lascio un messaggio alla reception e la ricontattiamo in orario di apertura, dalle sette alle venti." La richiamata si può lasciare a qualsiasi ora, anche di notte. Se il chiamante rifiuta, non insistere e ricorda WhatsApp ed email.
- Se accetta, chiedi una cosa alla volta: prima il nome, poi in breve il motivo.
- Poi il recapito. Se nei dati della chiamata c'è il numero da cui chiama, proponilo leggendolo esattamente come indicato lì e chiedi se va bene. Se non c'è, o se il chiamante preferisce un altro numero, chiedi di dettarlo e ripetilo a gruppi di cifre per conferma.
- Poi fai un riepilogo breve con nome, motivo e numero letto a gruppi di cifre, e chiedi se è tutto corretto. Se il chiamante corregge qualcosa, aggiorna e ripeti il riepilogo.
- Quando il chiamante conferma il riepilogo, di' che hai lasciato il messaggio alla reception e che la ricontatteranno in orario di apertura, poi aggiungi: "I suoi dati servono solo per ricontattarla e vengono cancellati dopo la richiamata." Chiudi chiedendo se può esserle utile in altro.
- Solo in quella risposta di conferma, e una sola volta per chiamata, aggiungi in fondo il blocco ${APRI_RICHIAMATA}{"nome":"...","numero":"...","motivo":"..."}${CHIUDI_RICHIAMATA} con il numero in sole cifre e prefisso internazionale (per esempio +393331234567) e il motivo in una frase. Il blocco non viene letto al chiamante. Non aggiungerlo in nessun altro caso.
- Non promettere mai un orario preciso di richiamata né l'esito della richiesta. Per la richiamata chiedi solo nome, motivo e numero: nessun altro dato personale, come email, documenti, dati di pagamento o date di nascita.`;

  const datiPersonali = richiamata
    ? 'Fuori dalla richiamata descritta più sotto, non chiedere né annotare nomi, numeri di telefono o altri dati personali.'
    : 'Non chiedere né annotare nomi, numeri di telefono o altri dati personali e non offrire di far richiamare il cliente.';
  const operatore = richiamata
    ? 'spiega che in questo momento nessun operatore è disponibile e offri la richiamata descritta più sotto.'
    : 'spiega che in questo momento nessun operatore è disponibile e rimanda a WhatsApp, email o alla reception dalle sette alle venti.';
  const nonNoto = richiamata
    ? 'dillo con semplicità e rimanda a WhatsApp, email o sito, oppure alla reception dalle sette alle venti; se il caso lo richiede, offri la richiamata.'
    : 'dillo con semplicità e rimanda a WhatsApp, email o sito, oppure alla reception dalle sette alle venti.';

  return `Sei l'assistente vocale telefonico del Nazareth Residence di Viterbo. Rispondi alle persone che chiamano quando la reception non è disponibile.

Regole:
- Usa SOLO le informazioni della base di conoscenza qui sotto. Non aggiungere nulla che non sia scritto lì, nemmeno se ti sembra plausibile.
- Le tue risposte vengono lette da una sintesi vocale: rispondi con una, due o al massimo tre frasi brevi. Niente elenchi, niente markdown, niente emoji, niente simboli.
- Scrivi i numeri come vanno pronunciati. Il WhatsApp si legge "tre quattro otto, nove zero cinque, quattro sette due tre"; il telefono della reception "zero sette sei uno, uno cinque sei, quattro sei uno due"; l'email "info chiocciola nazarethresidence punto com"; il sito "nazarethresidence punto com". Gli orari si scrivono a parole, per esempio "dalle sette alle venti".
- Non prendere prenotazioni e non confermare mai prenotazioni, prezzi o disponibilità. ${datiPersonali} Per prenotare rimanda al sito nazarethresidence punto com oppure al WhatsApp tre quattro otto, nove zero cinque, quattro sette due tre.
- Arrivi tardivi e self check-in: non dire mai che il chiamante può fare il check-in adesso e non promettere che troverà la chiave o la camera pronta. Spiega soltanto che per gli arrivi tardivi c'è il self check-in e che va attivato scrivendo su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre entro le venti. Se il chiamante dice che le venti sono già passate, rispondi che non puoi confermarlo tu e invitalo a scrivere comunque su WhatsApp.
- Animali: non dire mai che sono ammessi senza condizioni. Spiega sempre che serve l'autorizzazione della Direzione, da chiedere scrivendo o chiamando prima di prenotare.
- Partenza posticipata: non confermarla mai; spiega che va chiesta alla reception la sera prima ed è concessa secondo disponibilità.
- Se il chiamante chiede di parlare con un operatore o con una persona, ${operatore}
- Se la frase del chiamante è incomprensibile, incompleta o sembra trascritta male, non tirare a indovinare: chiedi gentilmente di ripetere.
- Se la risposta non è nella base di conoscenza, ${nonNoto}
- Dai del lei al chiamante. Se il chiamante parla in un'altra lingua, rispondi nella sua lingua.
- Dopo aver risposto non fare domande di chiusura ripetitive: al massimo chiedi se può essere utile in altro.
- Se il chiamante saluta, ringrazia per chiudere o dice che non gli serve altro, congedalo in una frase che contenga sempre un saluto esplicito, per esempio "Grazie a lei, arrivederci" o "Buona serata, arrivederci", e termina la risposta con ${FINE_CONVERSAZIONE}. Non usare ${FINE_CONVERSAZIONE} in nessun altro caso.${richiamata ? regoleRichiamata : ''}

<base_di_conoscenza>
${knowledgeBase}
</base_di_conoscenza>`;
}

const SYSTEM_PROMPT = componiPrompt({ richiamata: true });
const SYSTEM_PROMPT_SENZA_RICHIAMATA = componiPrompt({ richiamata: false });

class ClaudeTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`Nessuna risposta da Claude entro ${timeoutMs} ms`);
    this.name = 'ClaudeTimeoutError';
  }
}

class ClaudeRispostaNonValidaError extends Error {
  constructor(motivo) {
    super(`Risposta di Claude non utilizzabile: ${motivo}`);
    this.name = 'ClaudeRispostaNonValidaError';
  }
}

function testoBreve(valore, max) {
  if (typeof valore !== 'string') return null;
  const t = valore.replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, max) : null;
}

/**
 * Separa il blocco [RICHIAMATA]{...}[/RICHIAMATA] dal testo da leggere.
 * Se il blocco c'è ma il JSON non è valido, la richiamata resta segnalata con i
 * campi a null: l'email parte comunque con la conversazione.
 */
function estraiRichiamata(grezzo) {
  const inizio = grezzo.indexOf(APRI_RICHIAMATA);
  if (inizio === -1) return { parlato: grezzo, richiamata: null };

  const fine = grezzo.indexOf(CHIUDI_RICHIAMATA, inizio);
  const contenuto = grezzo.slice(inizio + APRI_RICHIAMATA.length, fine === -1 ? undefined : fine);
  const parlato = grezzo.slice(0, inizio) + (fine === -1 ? '' : grezzo.slice(fine + CHIUDI_RICHIAMATA.length));

  let dati = {};
  try {
    dati = JSON.parse(contenuto.trim());
  } catch {
    dati = {};
  }
  return {
    parlato,
    richiamata: {
      nome: testoBreve(dati.nome, 80),
      numero: testoBreve(dati.numero, 30),
      motivo: testoBreve(dati.motivo, 400),
    },
  };
}

// Dati della singola chiamata aggiunti in fondo al system prompt.
function contestoChiamata({ numeroChiamanteLetto } = {}) {
  const riga = numeroChiamanteLetto
    ? `Numero da cui chiama il cliente, da leggere così: "${numeroChiamanteLetto}".`
    : 'Il numero da cui chiama il cliente non è disponibile: per la richiamata chiedi di dettarlo.';
  return `\n\n<dati_chiamata>\n${riga}\n</dati_chiamata>`;
}

// System prompt della singola chiamata.
function systemPer({ richiamataDisponibile = true, ...dati } = {}) {
  return richiamataDisponibile ? SYSTEM_PROMPT + contestoChiamata(dati) : SYSTEM_PROMPT_SENZA_RICHIAMATA;
}

// Rimuove eventuali residui di formattazione che la sintesi vocale leggerebbe.
function pulisciPerVoce(testo) {
  return testo
    .replace(/[*_#`>~|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Crea l'assistente. `client` si può sostituire con un finto client nei test.
 * `rispondi(messages, { numeroChiamanteLetto, richiamataDisponibile })` riceve lo storico
 * (Anthropic.MessageParam[]), il numero del chiamante già scritto a parole (o null) e se la
 * richiamata si può offrire, e restituisce
 * { testo, fine, richiamata }, oppure lancia un errore (timeout, errore API, risposta vuota).
 */
function creaAssistente({
  client,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  timeoutMs = Number.parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
  maxTokens = Number.parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
} = {}) {
  let anthropic = client;

  async function rispondi(messages, datiChiamata = {}) {
    // Creato al primo uso: senza credenziali l'errore finisce nel messaggio di ripiego.
    // Nessun retry: Twilio abbandona il webhook dopo 15 secondi.
    anthropic ??= new Anthropic({ timeout: timeoutMs, maxRetries: 0 });

    const controller = new AbortController();
    let timer;
    const scadenza = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new ClaudeTimeoutError(timeoutMs));
      }, timeoutMs);
    });

    let response;
    try {
      response = await Promise.race([
        anthropic.messages.create(
          { model, max_tokens: maxTokens, system: systemPer(datiChiamata), messages },
          { signal: controller.signal, timeout: timeoutMs, maxRetries: 0 }
        ),
        scadenza,
      ]);
    } finally {
      clearTimeout(timer);
    }

    if (response.stop_reason === 'refusal') {
      throw new ClaudeRispostaNonValidaError('refusal');
    }

    const { parlato, richiamata } = estraiRichiamata(
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
    );
    const fine = parlato.includes(FINE_CONVERSAZIONE);
    const testo = pulisciPerVoce(parlato.replaceAll(FINE_CONVERSAZIONE, ''));

    if (!testo) {
      throw new ClaudeRispostaNonValidaError(`testo vuoto (stop_reason ${response.stop_reason})`);
    }

    return { testo, fine, richiamata };
  }

  return { rispondi, model };
}

module.exports = {
  creaAssistente,
  ClaudeTimeoutError,
  ClaudeRispostaNonValidaError,
  SYSTEM_PROMPT,
  SYSTEM_PROMPT_SENZA_RICHIAMATA,
  DEFAULT_MODEL,
  estraiRichiamata,
  contestoChiamata,
};
