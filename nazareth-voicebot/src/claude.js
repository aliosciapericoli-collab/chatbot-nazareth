// Integrazione con l'API Anthropic (Claude) per le risposte dell'assistente vocale.
const Anthropic = require('@anthropic-ai/sdk');
const { formatInTimeZone } = require('date-fns-tz');
const { it: localeIt } = require('date-fns/locale');
const { knowledgeBase } = require('./knowledge-base');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';

// Modello Haiku più recente secondo https://platform.claude.com/docs/en/about-claude/models/overview
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 300;

// Il modello lo aggiunge in fondo quando la conversazione è finita.
const FINE_CONVERSAZIONE = '[FINE]';
// Blocco con i dati della richiamata confermati dal chiamante; non viene letto al telefono.
const APRI_RICHIAMATA = '[RICHIAMATA]';
const CHIUDI_RICHIAMATA = '[/RICHIAMATA]';

// Frase obbligatoria dopo ogni prezzo, scritta per la sintesi vocale.
const FRASE_PREZZI = 'Il prezzo è quello del nostro sito in questo momento e può cambiare: per prenotare usi il sito nazarethresidence punto com oppure scriva su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre.';
const FRASE_TASSA = 'La tassa di soggiorno è esclusa: due euro e trenta a persona a notte, per al massimo tre notti.';

// Istruzioni del bot. La sezione sulla richiamata c'è solo se l'email alla reception è
// configurata: senza, il bot non deve nemmeno nominarla.
function componiPrompt({ richiamata }) {
  const regoleRichiamata = `

Richiamata dalla reception:
- Quando il chiamante ha bisogno di qualcosa che non puoi dare (prenotazioni, gruppi che occupano più di quattro camere, casi particolari, oppure quando la verifica di prezzi e disponibilità non riesce) oppure chiede un operatore, dopo aver risposto per quanto puoi offri: "Se vuole, lascio un messaggio alla reception e la ricontattiamo in orario di apertura, dalle sette alle venti." La richiamata si può lasciare a qualsiasi ora, anche di notte. Se il chiamante rifiuta, non insistere e ricorda WhatsApp ed email.
- Se accetta, chiedi una cosa alla volta: prima il nome, poi in breve il motivo.
- Poi il recapito. Se nei dati della chiamata c'è il numero da cui chiama, proponilo leggendolo esattamente come indicato lì e chiedi se va bene. Se non c'è, o se il chiamante preferisce un altro numero, chiedi di dettarlo e ripetilo a gruppi di cifre per conferma.
- Poi fai un riepilogo breve con nome, motivo e numero letto a gruppi di cifre, e chiedi se è tutto corretto. Se il chiamante corregge qualcosa, aggiorna e ripeti il riepilogo.
- Quando il chiamante conferma il riepilogo, di' che hai lasciato il messaggio alla reception e che la ricontattiamo in orario di apertura, poi aggiungi: "I suoi dati servono solo per ricontattarla e vengono cancellati dopo la richiamata." Chiudi con: "Posso esserle utile in altro?"
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
- Le tue risposte vengono lette da una sintesi vocale: rispondi con una, due o al massimo tre frasi brevi (per prezzi e disponibilità fino a cinque). Niente elenchi, niente markdown, niente emoji, niente simboli.
- Scrivi i numeri come vanno pronunciati. Il WhatsApp si legge "tre quattro otto, nove zero cinque, quattro sette due tre"; il telefono della reception "zero sette sei uno, uno cinque sei, quattro sei uno due"; l'email "info chiocciola nazarethresidence punto com"; il sito "nazarethresidence punto com". Gli orari si scrivono a parole, per esempio "dalle sette alle venti".
- Non prendere prenotazioni, non confermarle e non bloccare camere. ${datiPersonali} Per prenotare rimanda al sito nazarethresidence punto com oppure al WhatsApp tre quattro otto, nove zero cinque, quattro sette due tre.
- Arrivi tardivi e self check-in: non dire mai che il chiamante può fare il check-in adesso e non promettere che troverà la chiave o la camera pronta. Spiega soltanto che per gli arrivi tardivi c'è il self check-in e che va attivato scrivendo su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre entro le venti. Se il chiamante dice che le venti sono già passate, rispondi che non puoi confermarlo tu e invitalo a scrivere comunque su WhatsApp.
- Animali: non dire mai che sono ammessi senza condizioni. Spiega sempre che serve l'autorizzazione della Direzione, da chiedere scrivendo o chiamando prima di prenotare.
- Partenza posticipata: non confermarla mai; spiega che va chiesta alla reception la sera prima ed è concessa secondo disponibilità.
- Se il chiamante chiede di parlare con un operatore o con una persona, ${operatore}
- Se la frase del chiamante è incomprensibile, incompleta o sembra trascritta male, non tirare a indovinare: chiedi gentilmente di ripetere.
- Se la risposta non è nella base di conoscenza, ${nonNoto}
- Dai sempre del lei al chiamante, con le formule di cortesia corrette: "Posso esserle utile in altro?", "La ricontattiamo", "Le auguro una buona serata". Sei tu che offri aiuto al chiamante: non dire mai "Può essere utile in altro?". Se il chiamante parla in un'altra lingua, rispondi nella sua lingua.

Prezzi e disponibilità:
- Prezzi e disponibilità puoi darli SOLO con i dati appena ottenuti dallo strumento verifica_disponibilita. Non inventarli, non stimarli e non ripeterli da risposte precedenti: se cambiano date o persone, o se il chiamante chiede di nuovo, usa di nuovo lo strumento.
- Per usarlo servono data di arrivo, data di partenza o numero di notti, e numero di adulti e di bambini. Chiedi quello che manca, una cosa alla volta.
- Interpreta le date parlate rispetto alla data di oggi indicata nei dati della chiamata, ora di Roma: "il tre ottobre" è la prossima data con quel giorno e mese; "questo weekend" è da venerdì a domenica di questa settimana, due notti. Se una data è ambigua, ripetila al chiamante e chiedi conferma prima di usare lo strumento.
- Con il risultato indica le tipologie disponibili, al massimo tre partendo dalla più economica, con il prezzo totale indicativo del soggiorno, colazione inclusa. Se una tipologia è l'ultima camera disponibile, dillo. Scrivi i prezzi in cifre seguite da euro, per esempio 166 euro.
- Di' sempre che la tassa di soggiorno è esclusa: due euro e trenta a persona a notte, per al massimo tre notti.
- Chiudi sempre la risposta con questa frase: "${FRASE_PREZZI}"
- Se non ci sono camere, dillo e suggerisci altre date oppure il sito o WhatsApp. Se la verifica non riesce, di' che in questo momento non riesci a verificare e rimanda al sito o a WhatsApp.
- Per gruppi che occupano più di quattro camere non dare prezzi.
- Dopo aver risposto non fare domande di chiusura ripetitive: al massimo chiedi "Posso esserle utile in altro?"
- Se il chiamante saluta, ringrazia per chiudere o dice che non gli serve altro, congedalo in una frase che contenga sempre un saluto esplicito, per esempio "Grazie a lei, arrivederci" o "Le auguro una buona serata, arrivederci", e termina la risposta con ${FINE_CONVERSAZIONE}. Non usare ${FINE_CONVERSAZIONE} in nessun altro caso.${richiamata ? regoleRichiamata : ''}

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
function contestoChiamata({ numeroChiamanteLetto, richiamataDisponibile = true, adesso = Date.now() } = {}) {
  const oggi = new Date(adesso);
  const righe = [
    `Oggi è ${formatInTimeZone(oggi, TIMEZONE, 'EEEE d MMMM yyyy', { locale: localeIt })} (${formatInTimeZone(oggi, TIMEZONE, 'yyyy-MM-dd')}), ore ${formatInTimeZone(oggi, TIMEZONE, 'HH:mm')} ora di Roma.`,
  ];
  if (richiamataDisponibile) {
    righe.push(numeroChiamanteLetto
      ? `Numero da cui chiama il cliente, da leggere così: "${numeroChiamanteLetto}".`
      : 'Il numero da cui chiama il cliente non è disponibile: per la richiamata chiedi di dettarlo.');
  }
  return `\n\n<dati_chiamata>\n${righe.join('\n')}\n</dati_chiamata>`;
}

// System prompt della singola chiamata.
function systemPer(dati = {}) {
  const base = dati.richiamataDisponibile === false ? SYSTEM_PROMPT_SENZA_RICHIAMATA : SYSTEM_PROMPT;
  return base + contestoChiamata(dati);
}

// Importi in euro scritti in cifre, per esempio "166 euro", "2,30 euro", "€ 90".
function importiInEuro(testo) {
  const importi = [];
  const re = /(?:€\s*(\d+(?:[.,]\d+)?))|(?:(\d+(?:[.,]\d+)?)\s*(?:euro|€))/gi;
  for (const m of testo.matchAll(re)) importi.push(Number((m[1] ?? m[2]).replace(',', '.')));
  return importi;
}

// Gli unici importi che il bot può dire senza una verifica: quelli della base di conoscenza
// (tassa di soggiorno, addebito per il fumo, ...).
const IMPORTI_BASE_DI_CONOSCENZA = new Set(importiInEuro(knowledgeBase));

// Detto al posto di una risposta con un prezzo non verificato.
const MESSAGGIO_PREZZO_NON_VERIFICATO = 'Per prezzi e disponibilità aggiornati posso fare una verifica se mi indica le date e il numero di persone, oppure può consultare il sito nazarethresidence punto com o scriverci su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre.';

// Garantisce le frasi obbligatorie quando al chiamante sono stati dati dei prezzi.
function conFrasiObbligatorie(testo) {
  let risultato = testo;
  if (!/tassa di soggiorno/i.test(risultato)) risultato = `${risultato} ${FRASE_TASSA}`;
  if (!risultato.includes('può cambiare')) risultato = `${risultato} ${FRASE_PREZZI}`;
  return risultato;
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
 *
 * `rispondi(messages, datiChiamata)` riceve lo storico (Anthropic.MessageParam[]) e i dati
 * della chiamata ({ numeroChiamanteLetto, richiamataDisponibile, chiamataId }) e restituisce:
 * - { testo, fine, richiamata } per una risposta normale;
 * - { inVerifica: true, completa } se Claude usa uno strumento: `completa()` esegue gli
 *   strumenti, chiede a Claude la risposta finale e restituisce { testo, fine, richiamata }.
 *   Così il centralino può rispondere subito al provider ("un attimo") e completare dopo.
 * Lancia un errore per timeout, errore API o risposta vuota.
 *
 * `strumenti`: [{ definizione, esegui(input, { chiamataId }) → { contenuto, errore, esito } }]
 */
function creaAssistente({
  client,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  timeoutMs = Number.parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
  maxTokens = Number.parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
  strumenti = [],
  // Massimo di strumenti eseguiti per risposta (per esempio più camere per un gruppo).
  maxStrumentiPerRisposta = 4,
} = {}) {
  let anthropic = client;
  const perNome = new Map(strumenti.map((s) => [s.definizione.name, s]));
  const tools = strumenti.map((s) => s.definizione);

  async function chiama(params) {
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
    try {
      const response = await Promise.race([
        anthropic.messages.create(
          { model, ...params, ...(tools.length ? { tools } : {}) },
          { signal: controller.signal, timeout: timeoutMs, maxRetries: 0 }
        ),
        scadenza,
      ]);
      if (response.stop_reason === 'refusal') throw new ClaudeRispostaNonValidaError('refusal');
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  function interpreta(response, { prezziDati = false } = {}) {
    // Blocco lato server: senza una verifica riuscita in questo turno nessun prezzo
    // può arrivare al chiamante, anche se il modello ignorasse le istruzioni.
    const bloccaSeServe = (risultato) => {
      if (prezziDati) return risultato;
      const nonVerificati = importiInEuro(risultato.testo).filter((i) => !IMPORTI_BASE_DI_CONOSCENZA.has(i));
      if (nonVerificati.length === 0) return risultato;
      return { testo: MESSAGGIO_PREZZO_NON_VERIFICATO, fine: false, richiamata: null, prezzoBloccato: true };
    };
    const { parlato, richiamata } = estraiRichiamata(
      response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join(' ')
    );
    const fine = parlato.includes(FINE_CONVERSAZIONE);
    let testo = pulisciPerVoce(parlato.replaceAll(FINE_CONVERSAZIONE, ''));
    if (!testo) {
      throw new ClaudeRispostaNonValidaError(`testo vuoto (stop_reason ${response.stop_reason})`);
    }
    if (prezziDati) testo = conFrasiObbligatorie(testo);
    return bloccaSeServe({ testo, fine, richiamata });
  }

  async function eseguiStrumento(blocco, datiChiamata) {
    const strumento = perNome.get(blocco.name);
    if (!strumento) {
      return { tool_use_id: blocco.id, contenuto: `Strumento sconosciuto: ${blocco.name}`, errore: true, esito: 'sconosciuto' };
    }
    try {
      const r = await strumento.esegui(blocco.input, { chiamataId: datiChiamata.chiamataId });
      return { tool_use_id: blocco.id, ...r };
    } catch (error) {
      return { tool_use_id: blocco.id, contenuto: 'Verifica non riuscita: rimanda al sito o a WhatsApp.', errore: true, esito: error.name };
    }
  }

  async function rispondi(messages, datiChiamata = {}) {
    const system = systemPer(datiChiamata);
    const response = await chiama({ max_tokens: maxTokens, system, messages });

    const richieste = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || richieste.length === 0) return interpreta(response);

    const completa = async () => {
      const eseguite = await Promise.all(
        richieste.map((blocco, i) =>
          i < maxStrumentiPerRisposta
            ? eseguiStrumento(blocco, datiChiamata)
            : { tool_use_id: blocco.id, contenuto: 'Troppe verifiche insieme: per gruppi grandi non dare prezzi.', errore: true, esito: 'limite' }
        )
      );
      const conStrumenti = [
        ...messages,
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: eseguite.map((r) => ({
            type: 'tool_result',
            tool_use_id: r.tool_use_id,
            content: r.contenuto,
            ...(r.errore ? { is_error: true } : {}),
          })),
        },
      ];
      // Seconda chiamata senza altri strumenti: deve arrivare una risposta da leggere.
      const finale = await chiama({
        max_tokens: Math.max(maxTokens, 500),
        system,
        messages: conStrumenti,
        tool_choice: { type: 'none' },
      });
      const prezziDati = eseguite.some((r) => r.esito === 'disponibile');
      return { ...interpreta(finale, { prezziDati }), esitiStrumenti: eseguite.map((r) => r.esito) };
    };

    return { inVerifica: true, completa };
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
  conFrasiObbligatorie,
  importiInEuro,
  FRASE_PREZZI,
  MESSAGGIO_PREZZO_NON_VERIFICATO,
};
