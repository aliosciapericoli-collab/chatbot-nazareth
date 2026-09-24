// Test di /handle-speech con Claude simulato: nessuna chiamata reale all'API.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
delete process.env.PUBLIC_BASE_URL;

const twilio = require('twilio');
const Anthropic = require('@anthropic-ai/sdk');
const { createApp, MESSAGGIO_RIPIEGO } = require('../server');
const { creaAssistente, SYSTEM_PROMPT, DEFAULT_MODEL } = require('../src/claude');
const { creaConversationStore } = require('../src/conversation-store');

// Finto client Anthropic: registra le richieste e risponde con `comportamento`.
function creaClientFinto(comportamento) {
  const richieste = [];
  return {
    richieste,
    messages: {
      create(params, options) {
        richieste.push({ params: structuredClone(params), options });
        return comportamento(params, options);
      },
    },
  };
}

function rispostaTesto(text, stop_reason = 'end_turn') {
  return Promise.resolve({ content: [{ type: 'text', text }], stop_reason });
}

let server;
let baseUrl;
let clientCorrente;
const conversazioni = creaConversationStore();

before(async () => {
  const assistente = creaAssistente({
    client: { messages: { create: (...args) => clientCorrente.messages.create(...args) } },
    timeoutMs: 200,
  });
  const app = createApp({ assistente, conversazioni });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

after(() => server.close());

// Richiesta firmata come farebbe Twilio.
async function postTwilio(path, params, { firma = 'valida' } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (firma === 'valida') {
    headers['X-Twilio-Signature'] = twilio.getExpectedTwilioSignature(AUTH_TOKEN, baseUrl + path, params);
  } else if (firma === 'errata') {
    headers['X-Twilio-Signature'] = 'firma-non-valida';
  }
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers,
    body: new URLSearchParams(params).toString(),
  });
  return { status: res.status, body: await res.text() };
}

describe('POST /handle-speech', () => {
  test('domanda nota: risponde e continua ad ascoltare, con storico multi-turno', async () => {
    clientCorrente = creaClientFinto(() =>
      rispostaTesto('Sì, il parcheggio privato è **gratuito** ed è all\'interno della struttura. 🚗')
    );
    const r1 = await postTwilio('/handle-speech', { CallSid: 'CA_nota', SpeechResult: 'Avete il parcheggio?' });

    assert.equal(r1.status, 200);
    assert.match(r1.body, /<Say voice="Polly.Bianca-Neural" language="it-IT">Sì, il parcheggio privato è gratuito ed è all'interno della struttura.<\/Say>/);
    assert.match(r1.body, /<Gather input="speech" language="it-IT" speechTimeout="auto" action="\/handle-speech" method="POST"\/>/);
    assert.match(r1.body, /<Redirect method="POST">\/assistente\?motivo=continua&amp;tentativo=2<\/Redirect>/);
    assert.doesNotMatch(r1.body, /Hangup/);

    const [{ params, options }] = clientCorrente.richieste;
    assert.equal(params.model, DEFAULT_MODEL);
    assert.equal(params.system, SYSTEM_PROMPT);
    assert.ok(params.max_tokens <= 300);
    assert.deepEqual(params.messages, [{ role: 'user', content: 'Avete il parcheggio?' }]);
    assert.equal(options.maxRetries, 0);

    // Secondo turno: lo storico della stessa chiamata viene reinviato.
    clientCorrente = creaClientFinto(() => rispostaTesto('Sì, i cani sono ammessi in camera senza limiti di taglia.'));
    await postTwilio('/handle-speech', { CallSid: 'CA_nota', SpeechResult: 'E il cane?' });
    assert.deepEqual(clientCorrente.richieste[0].params.messages, [
      { role: 'user', content: 'Avete il parcheggio?' },
      { role: 'assistant', content: 'Sì, il parcheggio privato è gratuito ed è all\'interno della struttura.' },
      { role: 'user', content: 'E il cane?' },
    ]);
  });

  test('domanda non nota: il prompt vieta di inventare e la risposta rimanda ai contatti', async () => {
    assert.match(SYSTEM_PROMPT, /Usa SOLO le informazioni della base di conoscenza/);
    assert.match(SYSTEM_PROMPT, /Informazioni NON disponibili/);
    assert.match(SYSTEM_PROMPT, /tassa di soggiorno/);

    const risposta = 'Mi dispiace, non ho informazioni sui prezzi. Può scriverci su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre.';
    clientCorrente = creaClientFinto(() => rispostaTesto(risposta));
    const r = await postTwilio('/handle-speech', { CallSid: 'CA_non_nota', SpeechResult: 'Quanto costa una doppia?' });

    assert.equal(r.status, 200);
    assert.ok(r.body.includes(risposta));
    assert.match(r.body, /<Gather /);
  });

  test('saluto finale: congedo e Hangup, storico eliminato', async () => {
    clientCorrente = creaClientFinto(() => rispostaTesto('Grazie a lei per aver chiamato, arrivederci. [FINE]'));
    const r = await postTwilio('/handle-speech', { CallSid: 'CA_saluto', SpeechResult: 'No grazie, arrivederci' });

    assert.equal(r.status, 200);
    assert.match(r.body, /<Say [^>]*>Grazie a lei per aver chiamato, arrivederci.<\/Say><Hangup\/>/);
    assert.doesNotMatch(r.body, /FINE|<Gather/);
    assert.deepEqual(conversazioni.storico('CA_saluto'), []);
  });

  test('timeout di Claude: messaggio di ripiego con i contatti e chiusura', async () => {
    clientCorrente = creaClientFinto(() => new Promise(() => {}));
    const inizio = Date.now();
    const r = await postTwilio('/handle-speech', { CallSid: 'CA_timeout', SpeechResult: 'C\'è il wifi?' });

    assert.ok(Date.now() - inizio < 2000, 'deve rispondere subito dopo il timeout');
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(MESSAGGIO_RIPIEGO));
    assert.match(r.body, /WhatsApp.*email/);
    assert.match(r.body, /<Hangup\/>/);
    assert.ok(clientCorrente.richieste[0].options.signal.aborted, 'la richiesta viene annullata');
  });

  test('errore API: messaggio di ripiego, mai un errore HTTP a Twilio', async () => {
    clientCorrente = creaClientFinto(() =>
      Promise.reject(new Anthropic.InternalServerError(500, undefined, 'errore simulato', new Headers()))
    );
    const r = await postTwilio('/handle-speech', { CallSid: 'CA_errore', SpeechResult: 'A che ora è la colazione?' });

    assert.equal(r.status, 200);
    assert.ok(r.body.includes(MESSAGGIO_RIPIEGO));
    assert.match(r.body, /<Hangup\/>/);
  });

  test('rifiuto del modello (refusal): messaggio di ripiego', async () => {
    clientCorrente = creaClientFinto(() => rispostaTesto('', 'refusal'));
    const r = await postTwilio('/handle-speech', { CallSid: 'CA_refusal', SpeechResult: 'domanda' });
    assert.ok(r.body.includes(MESSAGGIO_RIPIEGO));
  });

  test('parlato vuoto: nuova richiesta senza chiamare Claude', async () => {
    clientCorrente = creaClientFinto(() => rispostaTesto('non deve essere chiamato'));
    const r = await postTwilio('/handle-speech', { CallSid: 'CA_vuoto', SpeechResult: '' });

    assert.match(r.body, /È ancora in linea\?/);
    assert.equal(clientCorrente.richieste.length, 0);
  });

  test('limite di turni: congedo con i contatti', async () => {
    const storico = [];
    for (let i = 0; i < 10; i += 1) {
      storico.push({ role: 'user', content: `domanda ${i}` }, { role: 'assistant', content: `risposta ${i}` });
    }
    conversazioni.salva('CA_limite', storico);
    clientCorrente = creaClientFinto(() => rispostaTesto('non deve essere chiamato'));

    const r = await postTwilio('/handle-speech', { CallSid: 'CA_limite', SpeechResult: 'altra domanda' });
    assert.match(r.body, /Per ulteriori informazioni .*<Hangup\/>/);
    assert.equal(clientCorrente.richieste.length, 0);
  });

  test('firma Twilio obbligatoria: senza firma 400, firma errata 403, Claude non chiamato', async () => {
    clientCorrente = creaClientFinto(() => rispostaTesto('non deve essere chiamato'));
    const params = { CallSid: 'CA_firma', SpeechResult: 'ciao' };

    assert.equal((await postTwilio('/handle-speech', params, { firma: 'assente' })).status, 400);
    assert.equal((await postTwilio('/handle-speech', params, { firma: 'errata' })).status, 403);
    for (const path of ['/voice', '/dial-status', '/assistente']) {
      assert.equal((await postTwilio(path, params, { firma: 'errata' })).status, 403, path);
    }
    assert.equal(clientCorrente.richieste.length, 0);
  });
});

describe('conversation store', () => {
  test('le conversazioni scadono dopo il TTL', () => {
    let adesso = 0;
    const store = creaConversationStore({ ttlMs: 1000, now: () => adesso });
    store.salva('CA_ttl', [{ role: 'user', content: 'x' }]);
    adesso = 999;
    assert.equal(store.storico('CA_ttl').length, 1);
    adesso = 2500;
    assert.equal(store.storico('CA_ttl').length, 0);
  });
});
