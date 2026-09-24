// Test della dashboard: accesso protetto, metriche senza dati personali, registro Twilio.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
delete process.env.PUBLIC_BASE_URL;

const twilio = require('twilio');
const { createApp } = require('../server');
const { creaMetriche } = require('../src/dashboard/metriche');
const { creaRegistroTwilio, mascheraNumero } = require('../src/dashboard/registro-twilio');
const { creaConversationStore } = require('../src/conversation-store');

const PASSWORD = 'password-di-prova-lunga';
const basic = (password, utente = 'reception') => `Basic ${Buffer.from(`${utente}:${password}`).toString('base64')}`;

function registroFinto(chiamate) {
  let richieste = 0;
  const client = { calls: { list: async () => { richieste += 1; return chiamate; } } };
  return { registro: creaRegistroTwilio({ client }), richieste: () => richieste };
}

async function avvia(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://localhost:${server.address().port}` };
}

describe('dashboard: accesso', () => {
  test('senza DASHBOARD_PASSWORD la dashboard è disattivata (404)', async () => {
    const { server, base } = await avvia(createApp({
      assistente: { rispondi: async () => ({ testo: 'x', fine: false }) },
      dashboardPassword: '',
      registroTwilio: registroFinto([]).registro,
    }));
    try {
      assert.equal((await fetch(`${base}/dashboard`)).status, 404);
      assert.equal((await fetch(`${base}/dashboard/api/stato`, { headers: { authorization: basic('') } })).status, 404);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally {
      server.close();
    }
  });

  test('password errata o assente: 401; dopo 10 tentativi falliti: 429', async () => {
    const { server, base } = await avvia(createApp({
      assistente: { rispondi: async () => ({ testo: 'x', fine: false }) },
      dashboardPassword: PASSWORD,
      registroTwilio: registroFinto([]).registro,
    }));
    try {
      const senza = await fetch(`${base}/dashboard`);
      assert.equal(senza.status, 401);
      assert.match(senza.headers.get('www-authenticate'), /^Basic realm="Nazareth Voicebot"/);

      for (let i = 0; i < 10; i += 1) {
        assert.equal((await fetch(`${base}/dashboard/api/stato`, { headers: { authorization: basic('sbagliata') } })).status, 401);
      }
      const bloccato = await fetch(`${base}/dashboard`, { headers: { authorization: basic(PASSWORD) } });
      assert.equal(bloccato.status, 429);
    } finally {
      server.close();
    }
  });

  test('password corretta: pagina, script e intestazioni di sicurezza', async () => {
    const { server, base } = await avvia(createApp({
      assistente: { rispondi: async () => ({ testo: 'x', fine: false }) },
      dashboardPassword: PASSWORD,
      registroTwilio: registroFinto([]).registro,
    }));
    try {
      const pagina = await fetch(`${base}/dashboard`, { headers: { authorization: basic(PASSWORD) } });
      assert.equal(pagina.status, 200);
      assert.match(await pagina.text(), /<title>Voicebot Nazareth<\/title>/);
      assert.equal(pagina.headers.get('cache-control'), 'no-store');
      assert.equal(pagina.headers.get('x-frame-options'), 'DENY');
      assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);

      const script = await fetch(`${base}/dashboard/app.js`, { headers: { authorization: basic(PASSWORD) } });
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
    } finally {
      server.close();
    }
  });
});

describe('dashboard: dati', () => {
  let server;
  let base;
  const metriche = creaMetriche();
  const twilioFinto = registroFinto([
    { startTime: new Date('2026-09-24T19:05:00Z'), duration: '95', status: 'completed', direction: 'inbound', from: '+393331234567', price: '-0.0085', priceUnit: 'USD' },
    { startTime: new Date('2026-09-24T19:10:00Z'), duration: '0', status: 'no-answer', direction: 'inbound', from: '+390612345678', price: null, priceUnit: 'USD' },
  ]);

  before(async () => {
    const risposte = [
      { testo: 'Il parcheggio è gratuito.', fine: false },
      { testo: 'Grazie a lei, arrivederci.', fine: true },
    ];
    ({ server, base } = await avvia(createApp({
      assistente: { rispondi: async () => risposte.shift(), model: 'modello-di-test' },
      conversazioni: creaConversationStore(),
      metriche,
      registroTwilio: twilioFinto.registro,
      dashboardPassword: PASSWORD,
    })));
  });

  after(() => server.close());

  async function postTwilio(path, params) {
    const url = base + path;
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
      },
      body: new URLSearchParams(params).toString(),
    });
  }

  test('una chiamata vera attraverso Twilio compare in dashboard, senza il parlato', async () => {
    await postTwilio('/voice', { CallSid: 'CA00000000000000000000000000abc123' });
    await postTwilio('/handle-speech', { CallSid: 'CA00000000000000000000000000abc123', SpeechResult: 'Avete il parcheggio? Sono Mario Rossi' });
    await postTwilio('/handle-speech', { CallSid: 'CA00000000000000000000000000abc123', SpeechResult: 'No grazie, arrivederci' });

    const risposta = await fetch(`${base}/dashboard/api/stato`, { headers: { authorization: basic(PASSWORD) } });
    assert.equal(risposta.status, 200);
    const testo = await risposta.text();
    const { configurazione, metriche: m, twilio: t } = JSON.parse(testo);

    assert.equal(configurazione.modello, 'modello-di-test');
    assert.equal(configurazione.receptionAdesso, 'chiusa');
    assert.equal(m.oggi.chiamate, 1);
    assert.equal(m.oggi.conAssistente, 1);
    assert.equal(m.oggi.domande, 2);
    assert.equal(m.oggi.esiti.congedo, 1);
    assert.equal(m.oggi.perOra.reduce((tot, p) => tot + p.chiamate, 0), 1);
    assert.deepEqual(m.ultimeChiamate.map((c) => [c.id, c.ingresso, c.domande, c.esito]), [
      ['…abc123', 'reception_chiusa', 2, 'congedo'],
    ]);

    // Nessun dato personale: né il parlato né l'id completo né i numeri interi.
    assert.doesNotMatch(testo, /Mario|parcheggio\?|CA00000000000000000000000000abc123|3331234567/);

    assert.equal(t.totale.chiamate, 2);
    assert.equal(t.totale.minuti, 2);
    assert.equal(t.totale.costo, 0.0085);
    assert.deepEqual(t.chiamate.map((c) => c.da), ['•••567', '•••678']);
    assert.equal(t.chiamate[1].costo, null);
  });
});

describe('metriche', () => {
  test('esiti, errori e chiamate interrotte dal chiamante', () => {
    let adesso = Date.parse('2026-09-24T20:00:00Z');
    const m = creaMetriche({ now: () => adesso });

    m.registra('CA_ok', 'assistente', { motivo: 'chiusa' });
    m.registra('CA_ok', 'risposta_claude', { ms: 1000 });
    m.registra('CA_ok', 'risposta_claude', { ms: 3000 });
    m.registra('CA_ok', 'chiusura', { causa: 'congedo' });

    m.registra('CA_err', 'assistente', { motivo: 'occupata' });
    m.registra('CA_err', 'errore_claude', { tipo: 'ClaudeTimeoutError', messaggio: 'timeout' });
    m.registra('CA_err', 'chiusura', { causa: 'ripiego' });

    m.registra('CA_muto', 'assistente', { motivo: 'chiusa' });

    let r = m.riepilogo();
    assert.equal(r.oggi.latenzaMediaMs, 2000);
    assert.equal(r.oggi.latenzaP95Ms, 3000);
    assert.equal(r.oggi.esiti.congedo, 1);
    assert.equal(r.oggi.esiti.ripiego, 1);
    assert.equal(r.oggi.esiti.in_corso, 1);
    assert.equal(r.errori[0].tipo, 'ClaudeTimeoutError');
    assert.equal(r.errori[0].chiamata, '…CA_err');

    adesso += 6 * 60 * 1000;
    r = m.riepilogo();
    assert.equal(r.oggi.esiti.chiusa_dal_chiamante, 1);
    assert.equal(r.oggi.esiti.in_corso, 0);
  });

  test('conserva solo le chiamate più recenti', () => {
    const m = creaMetriche({ maxChiamate: 3 });
    for (let i = 0; i < 5; i += 1) m.registra(`CA_${i}`, 'assistente', { motivo: 'chiusa' });
    assert.deepEqual(m.riepilogo().ultimeChiamate.map((c) => c.id), ['…CA_4', '…CA_3', '…CA_2']);
  });

  test('il registro Twilio usa la cache e maschera i numeri', async () => {
    const { registro, richieste } = registroFinto([]);
    await registro.ultimeChiamate();
    await registro.ultimeChiamate();
    assert.equal(richieste(), 1);
    assert.equal(mascheraNumero('+39 0761 1564612'), '•••612');
    assert.deepEqual(await creaRegistroTwilio({}).ultimeChiamate(), { disponibile: false });
  });
});
