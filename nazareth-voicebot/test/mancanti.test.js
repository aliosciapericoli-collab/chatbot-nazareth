// Test delle domande senza risposta: marcatore [MANCA], email a chi gestisce il bot, dashboard.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
delete process.env.PUBLIC_BASE_URL;
delete process.env.DATABASE_URL;
delete process.env.DEMO_PHONE_NUMBER;
delete process.env.VOICE_STREAMING;
delete process.env.SMTP_HOST;

const twilio = require('twilio');
const { createApp } = require('../server');
const { creaAssistente, estraiMancante, SYSTEM_PROMPT } = require('../src/claude');
const { componiEmailMancante, OGGETTO } = require('../src/notifiche/informazioni-mancanti');

const PASSWORD = 'password-di-prova-lunga';
const RISPOSTA = 'Non ho questa informazione: può scriverci su WhatsApp. Posso esserle utile in altro? [MANCA]C\'è una piscina?[/MANCA]';

function assistenteCon(testi) {
  return creaAssistente({
    client: { messages: { create: async () => ({ content: [{ type: 'text', text: testi.shift() }], stop_reason: 'end_turn' }) } },
    strumenti: [],
  });
}

async function avvia(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const base = `http://localhost:${server.address().port}`;
  const post = async (path, params) => {
    const url = base + path;
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params) },
      body: new URLSearchParams(params).toString(),
    });
    return r.text();
  };
  const accedi = async () => {
    const r = await fetch(`${base}/dashboard/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ password: PASSWORD }).toString(),
      redirect: 'manual',
    });
    return r.headers.get('set-cookie').split(';')[0];
  };
  return { server, base, post, accedi };
}

// Cattura i log JSON del processo durante una funzione.
async function conLog(fn) {
  const righe = [];
  const originale = console.log;
  console.log = (...a) => righe.push(a.join(' '));
  try {
    await fn();
  } finally {
    console.log = originale;
  }
  return righe.join('\n');
}

describe('domande senza risposta', () => {
  test('il blocco [MANCA] si separa dal testo detto al chiamante', () => {
    assert.deepEqual(estraiMancante(RISPOSTA), {
      parlato: 'Non ho questa informazione: può scriverci su WhatsApp. Posso esserle utile in altro? ',
      mancante: 'C\'è una piscina?',
    });
    assert.deepEqual(estraiMancante('Tutto chiaro.'), { parlato: 'Tutto chiaro.', mancante: null });
    // Blocco non chiuso: non viene comunque letto.
    assert.equal(estraiMancante('Non lo so. [MANCA]C\'è la sauna').parlato, 'Non lo so. ');
    assert.match(SYSTEM_PROMPT, /\[MANCA\]domanda\[\/MANCA\]/);
  });

  test('email a chi gestisce il bot, niente testo nei log né nel riepilogo della dashboard', async () => {
    process.env.INFO_MANCANTI_EMAIL_TO = 'gestore@example.invalid';
    const inviate = [];
    const app = createApp({
      assistente: assistenteCon([RISPOSTA]),
      trasportoEmail: { sendMail: async (email) => { inviate.push(email); } },
      dashboardPassword: PASSWORD,
    });
    delete process.env.INFO_MANCANTI_EMAIL_TO;
    const { server, post, accedi, base } = await avvia(app);
    try {
      let twiml;
      const log = await conLog(async () => {
        await post('/voice', { CallSid: 'CA_manca_1' });
        twiml = await post('/handle-speech', { CallSid: 'CA_manca_1', SpeechResult: 'Avete la piscina?' });
        await new Promise((r) => setTimeout(r, 30));
      });

      assert.doesNotMatch(twiml, /MANCA|piscina\?/);
      assert.match(twiml, /Non ho questa informazione/);

      assert.equal(inviate.length, 1);
      assert.equal(inviate[0].to, 'gestore@example.invalid');
      assert.equal(inviate[0].subject, `${OGGETTO}: C'è una piscina?`);
      assert.match(inviate[0].text, /Domanda: C'è una piscina\?/);

      assert.match(log, /"evento":"informazione_mancante"/);
      assert.match(log, /"evento":"informazione_mancante_inviata"/);
      assert.doesNotMatch(log, /piscina/);

      const cookie = await accedi();
      const elenco = await (await fetch(`${base}/dashboard/api/mancanti`, { headers: { cookie } })).json();
      assert.equal(elenco.fonte, 'memoria');
      assert.deepEqual(elenco.mancanti.map((m) => m.domanda), ['C\'è una piscina?']);
      const stato = await (await fetch(`${base}/dashboard/api/stato`, { headers: { cookie } })).text();
      assert.doesNotMatch(stato, /piscina/);
      assert.match(stato, /"emailMancanti":"gestore@example.invalid"/);
      assert.equal((await fetch(`${base}/dashboard/api/mancanti`)).status, 401);
    } finally {
      server.close();
    }
  });

  test('senza SMTP la domanda resta in dashboard e la chiamata prosegue', async () => {
    const app = createApp({ assistente: assistenteCon([RISPOSTA]), dashboardPassword: PASSWORD });
    const { server, post, accedi, base } = await avvia(app);
    try {
      let twiml;
      const log = await conLog(async () => {
        twiml = await post('/handle-speech', { CallSid: 'CA_manca_2', SpeechResult: 'Avete la piscina?' });
        await new Promise((r) => setTimeout(r, 30));
      });
      assert.match(twiml, /<Gather/);
      assert.match(log, /"evento":"informazione_mancante_non_inviata","motivo":"email_non_configurata"/);
      const cookie = await accedi();
      const elenco = await (await fetch(`${base}/dashboard/api/mancanti`, { headers: { cookie } })).json();
      assert.equal(elenco.mancanti.length, 1);
    } finally {
      server.close();
    }
  });

  test('testo dell\'email', () => {
    const { subject, text } = componiEmailMancante({ domanda: 'Si può fare il bagno in piscina?\nanche di notte', ts: Date.parse('2026-11-22T22:14:00Z'), cliente: 'Nazareth Residence' });
    assert.equal(subject, `${OGGETTO}: Si può fare il bagno in piscina? anche di notte`);
    assert.match(text, /Il receptionist virtuale di Nazareth Residence non ha saputo rispondere/);
    assert.match(text, /Data e ora: 22\/11\/2026 23:14 \(ora di Roma\)/);
  });
});
