// Integrazione con l'API Anthropic (Claude) per le risposte dell'assistente vocale.
const Anthropic = require('@anthropic-ai/sdk');
const { knowledgeBase } = require('./knowledge-base');

// Modello Haiku più recente secondo https://platform.claude.com/docs/en/about-claude/models/overview
const DEFAULT_MODEL = 'claude-haiku-4-5-20251001';
const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_TOKENS = 300;

// Il modello lo aggiunge in fondo quando la conversazione è finita.
const FINE_CONVERSAZIONE = '[FINE]';

const SYSTEM_PROMPT = `Sei l'assistente vocale telefonico del Nazareth Residence di Viterbo. Rispondi alle persone che chiamano quando la reception non è disponibile.

Regole:
- Usa SOLO le informazioni della base di conoscenza qui sotto. Non aggiungere nulla che non sia scritto lì, nemmeno se ti sembra plausibile.
- Le tue risposte vengono lette da una sintesi vocale: rispondi con una, due o al massimo tre frasi brevi. Niente elenchi, niente markdown, niente emoji, niente simboli.
- Scrivi i numeri come vanno pronunciati. Il WhatsApp si legge "tre quattro otto, nove zero cinque, quattro sette due tre"; il telefono della reception "zero sette sei uno, uno cinque sei, quattro sei uno due"; l'email "info chiocciola nazarethresidence punto com"; il sito "nazarethresidence punto com". Gli orari si scrivono a parole, per esempio "dalle sette alle venti".
- Non confermare mai prenotazioni, prezzi o disponibilità e non raccogliere dati per prenotare. Per prenotare rimanda al sito nazarethresidence punto com oppure al WhatsApp tre quattro otto, nove zero cinque, quattro sette due tre.
- Se la risposta non è nella base di conoscenza, dillo con semplicità e rimanda a WhatsApp, email o sito, oppure alla reception dalle sette alle venti.
- Dai del lei al chiamante. Se il chiamante parla in un'altra lingua, rispondi nella sua lingua.
- Dopo aver risposto non fare domande di chiusura ripetitive: al massimo chiedi se può essere utile in altro.
- Se il chiamante saluta, ringrazia per chiudere o dice che non gli serve altro, congedalo cordialmente in una frase e termina la risposta con ${FINE_CONVERSAZIONE}. Non usare ${FINE_CONVERSAZIONE} in nessun altro caso.

<base_di_conoscenza>
${knowledgeBase}
</base_di_conoscenza>`;

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
 * `rispondi(messages)` riceve lo storico (Anthropic.MessageParam[]) e restituisce
 * { testo, fine }, oppure lancia un errore (timeout, errore API, risposta vuota).
 */
function creaAssistente({
  client,
  model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL,
  timeoutMs = Number.parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || DEFAULT_TIMEOUT_MS,
  maxTokens = Number.parseInt(process.env.CLAUDE_MAX_TOKENS, 10) || DEFAULT_MAX_TOKENS,
} = {}) {
  let anthropic = client;

  async function rispondi(messages) {
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
          { model, max_tokens: maxTokens, system: SYSTEM_PROMPT, messages },
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

    const grezzo = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join(' ');
    const fine = grezzo.includes(FINE_CONVERSAZIONE);
    const testo = pulisciPerVoce(grezzo.replaceAll(FINE_CONVERSAZIONE, ''));

    if (!testo) {
      throw new ClaudeRispostaNonValidaError(`testo vuoto (stop_reason ${response.stop_reason})`);
    }

    return { testo, fine };
  }

  return { rispondi, model };
}

module.exports = {
  creaAssistente,
  ClaudeTimeoutError,
  ClaudeRispostaNonValidaError,
  SYSTEM_PROMPT,
  DEFAULT_MODEL,
};
