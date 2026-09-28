// Test della voce in streaming (Twilio ConversationRelay, VOICE_STREAMING=true).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
delete process.env.PUBLIC_BASE_URL;
delete process.env.DATABASE_URL;
delete process.env.DEMO_PHONE_NUMBER;

const twilio = require('twilio');
const WebSocket = require('ws');
const { createApp } = require('../server');
const { creaProviderTwilio } = require('../src/provider/twilio');
const { creaGettone, gettoneValido, voceRelay } = require('../src/provider/twilio-relay');

function attendi(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

describe('voce in streaming', () => {
  let server;
  let base;
  let provider;
  const risposte = [];

  before(async () => {
    provider = creaProviderTwilio({
      voce: 'Google.it-IT-Chirp3-HD-Aoede',
      validaFirma: true,
      authToken: AUTH_TOKEN,
      relay: { attivo: true, ...voceRelay('Google.it-IT-Chirp3-HD-Aoede'), silenzioMs: 150 },
    });
    const app = createApp({
      provider,
      assistente: { rispondi: async () => risposte.shift() ?? { testo: 'Va bene.', fine: false } },
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    provider.collegaWebSocket(server);
    base = `http://localhost:${server.address().port}`;
  });

  after(() => {
    provider.chiudi();
    server.close();
  });

  async function post(path, params) {
    const url = base + path;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    return r.text();
  }

  // Apre il WebSocket come farebbe Twilio e raccoglie i messaggi ricevuti.
  async function sessione(callSid, gettone) {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/relay`);
    const ricevuti = [];
    const chiusura = new Promise((resolve) => ws.on('close', (codice) => resolve(codice)));
    ws.on('message', (m) => ricevuti.push(JSON.parse(m)));
    await new Promise((resolve) => ws.on('open', resolve));
    ws.send(JSON.stringify({ type: 'setup', callSid, from: '+393331234567', to: '+19343867171', customParameters: { gettone } }));
    return { ws, ricevuti, chiusura, invia: (m) => ws.send(JSON.stringify(m)) };
  }

  const gettoneDa = (twiml) => twiml.match(/name="gettone" value="([^"]+)"/)[1];

  test('la chiamata apre la sessione con il benvenuto, la voce e un gettone', async () => {
    const twiml = await post('/voice', { CallSid: 'CA_relay_1', To: '+19343867171' });
    assert.match(twiml, /<Connect action="\/relay-fine" method="POST"><ConversationRelay url="wss:\/\/localhost:\d+\/relay"/);
    assert.match(twiml, /language="it-IT"/);
    assert.match(twiml, /ttsProvider="Google" voice="it-IT-Chirp3-HD-Aoede"/);
    assert.match(twiml, /welcomeGreeting="Nazareth Residence, sono l'assistente virtuale: la reception ora è chiusa/);
    assert.match(twiml, /welcomeGreetingInterruptible="none"/);
    assert.ok(gettoneValido(AUTH_TOKEN, 'CA_relay_1', gettoneDa(twiml)));
    assert.ok(!gettoneValido(AUTH_TOKEN, 'CA_altra', gettoneDa(twiml)));
  });

  test('conversazione: risposta in testo, silenzio, congedo passato al webhook di fine', async () => {
    risposte.push({ testo: 'La colazione è dalle sette e trenta.', fine: false });
    risposte.push({ testo: 'Grazie a lei, arrivederci.', fine: true });
    const twiml = await post('/voice', { CallSid: 'CA_relay_2', To: '+19343867171' });
    const s = await sessione('CA_relay_2', gettoneDa(twiml));

    s.invia({ type: 'prompt', voicePrompt: 'A che ora è la colazione?', lang: 'it-IT', last: true });
    await attendi(80);
    assert.deepEqual(s.ricevuti[0], { type: 'text', token: 'La colazione è dalle sette e trenta.', last: true });

    // Nessuna risposta del cliente: dopo l'attesa arriva "è ancora in linea?".
    await attendi(150 + 'La colazione è dalle sette e trenta.'.length * 60 + 150);
    assert.match(s.ricevuti[1].token, /ancora in linea/);

    s.invia({ type: 'prompt', voicePrompt: 'No grazie, arrivederci', last: true });
    await attendi(80);
    const fine = s.ricevuti.at(-1);
    assert.equal(fine.type, 'end');
    const passaggio = JSON.parse(fine.handoffData);

    // Il saluto lo legge il webhook di fine sessione, per intero, poi riaggancia.
    const chiusura = await post('/relay-fine', { CallSid: 'CA_relay_2', SessionStatus: 'ended', HandoffData: JSON.stringify(passaggio) });
    assert.match(chiusura, /<Say voice="Google.it-IT-Chirp3-HD-Aoede" language="it-IT">Grazie a lei, arrivederci.<\/Say><Hangup\/>/);
    s.ws.close();
  });

  test('gettone assente, sbagliato o già usato: connessione rifiutata', async () => {
    const falso = await sessione('CA_relay_3', creaGettone('altro-segreto', 'CA_relay_3'));
    assert.equal(await falso.chiusura, 1008);

    const twiml = await post('/voice', { CallSid: 'CA_relay_4', To: '+19343867171' });
    const g = gettoneDa(twiml);
    const primo = await sessione('CA_relay_4', g);
    await attendi(30);
    const secondo = await sessione('CA_relay_4', g);
    assert.equal(await secondo.chiusura, 1008);
    primo.ws.close();
  });

  test('sessione fallita (per esempio voce non valida): si continua con i webhook classici', async () => {
    const twiml = await post('/relay-fine', { CallSid: 'CA_relay_5', SessionStatus: 'failed', ErrorCode: '64101' });
    assert.match(twiml, /<Gather input="speech" language="it-IT" speechTimeout="auto" action="\/handle-speech"/);
  });

  test('conversione della voce di <Say> nel formato di ConversationRelay', () => {
    assert.deepEqual(voceRelay('Google.it-IT-Chirp3-HD-Aoede'), { ttsProvider: 'Google', voice: 'it-IT-Chirp3-HD-Aoede' });
    assert.deepEqual(voceRelay('Polly.Bianca-Neural'), { ttsProvider: 'Amazon', voice: 'Bianca-Neural' });
    assert.deepEqual(voceRelay(undefined), {});
  });
});

describe('senza streaming', () => {
  test('VOICE_STREAMING spento: /voice resta con Say e Gather', async () => {
    const app = createApp({ assistente: { rispondi: async () => ({ testo: 'ok', fine: false }) } });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const url = `http://localhost:${server.address().port}/voice`;
      const params = { CallSid: 'CA_classico' };
      const twiml = await (await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params) },
        body: new URLSearchParams(params).toString(),
      })).text();
      assert.doesNotMatch(twiml, /ConversationRelay/);
      assert.match(twiml, /<Gather/);
    } finally {
      server.close();
    }
  });
});
