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

// Accede con la password e restituisce il cookie di sessione.
async function accedi(base, password = PASSWORD) {
  const res = await fetch(`${base}/dashboard/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
    redirect: 'manual',
  });
  const cookie = res.headers.get('set-cookie');
  return { res, cookie: cookie ? cookie.split(';')[0] : null };
}

describe('dashboard: accesso', () => {
  const appCon = (password) => createApp({
    assistente: { rispondi: async () => ({ testo: 'x', fine: false }) },
    dashboardPassword: password,
    registroTwilio: registroFinto([]).registro,
  });

  test('senza DASHBOARD_PASSWORD la dashboard è disattivata (404)', async () => {
    const { server, base } = await avvia(appCon(''));
    try {
      assert.equal((await fetch(`${base}/dashboard`)).status, 404);
      assert.equal((await fetch(`${base}/dashboard/api/stato`)).status, 404);
      assert.equal((await accedi(base, '')).res.status, 404);
      assert.equal((await fetch(`${base}/health`)).status, 200);
    } finally {
      server.close();
    }
  });

  test('senza sessione: pagina di accesso con il marchio, dati negati', async () => {
    const { server, base } = await avvia(appCon(PASSWORD));
    try {
      const pagina = await fetch(`${base}/dashboard`);
      assert.equal(pagina.status, 200);
      const html = await pagina.text();
      assert.match(html, /<title>Vocalba · Nazareth Residence<\/title>/);
      assert.match(html, /action="\/dashboard\/login"/);
      assert.equal((await fetch(`${base}/dashboard/api/stato`)).status, 401);
    } finally {
      server.close();
    }
  });

  test('password errata: 401; dopo 10 tentativi falliti: 429 anche con la password giusta', async () => {
    const { server, base } = await avvia(appCon(PASSWORD));
    try {
      for (let i = 0; i < 10; i += 1) {
        const { res, cookie } = await accedi(base, 'sbagliata');
        assert.equal(res.status, 401);
        assert.equal(cookie, null);
      }
      assert.equal((await accedi(base)).res.status, 429);
    } finally {
      server.close();
    }
  });

  test('password corretta: sessione sicura, pagina, uscita', async () => {
    const { server, base } = await avvia(appCon(PASSWORD));
    try {
      const { res, cookie } = await accedi(base);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard');
      const setCookie = res.headers.get('set-cookie');
      assert.match(setCookie, /HttpOnly/);
      assert.match(setCookie, /SameSite=Strict/);
      assert.match(setCookie, /Path=\/dashboard/);

      const pagina = await fetch(`${base}/dashboard`, { headers: { cookie } });
      assert.equal(pagina.status, 200);
      const html = await pagina.text();
      assert.match(html, /id="titolo-giornata"/);
      assert.match(html, /<b>Vocalba<\/b><span>Nazareth Residence<\/span>/);
      assert.equal(pagina.headers.get('cache-control'), 'no-store');
      assert.equal(pagina.headers.get('x-frame-options'), 'DENY');
      assert.match(pagina.headers.get('content-security-policy'), /default-src 'self'/);

      // Una sessione falsificata non vale.
      const falso = cookie.replace(/\.[^.]+$/, '.firmaFalsa');
      assert.equal((await fetch(`${base}/dashboard/api/stato`, { headers: { cookie: falso } })).status, 401);

      const uscita = await fetch(`${base}/dashboard/logout`, { method: 'POST', headers: { cookie }, redirect: 'manual' });
      assert.equal(uscita.status, 303);
      assert.match(uscita.headers.get('set-cookie'), /Max-Age=0/);
    } finally {
      server.close();
    }
  });

  test('risorse per installare l\'app: icona e manifest pubblici', async () => {
    const { server, base } = await avvia(appCon(PASSWORD));
    try {
      const manifest = await (await fetch(`${base}/dashboard/manifest.webmanifest`)).json();
      assert.equal(manifest.name, 'Vocalba · Nazareth Residence');
      assert.equal(manifest.short_name, 'Vocalba');
      assert.equal(manifest.display, 'standalone');
      const icona = await fetch(`${base}/dashboard/icona.svg`);
      assert.match(icona.headers.get('content-type'), /image\/svg\+xml/);
      assert.equal((await fetch(`${base}/dashboard/app.js`)).status, 200);
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

    const { cookie } = await accedi(base);
    const risposta = await fetch(`${base}/dashboard/api/stato`, { headers: { cookie } });
    assert.equal(risposta.status, 200);
    const testo = await risposta.text();
    const { configurazione, metriche: m, twilio: t } = JSON.parse(testo);

    assert.equal(configurazione.modello, 'modello-di-test');
    assert.equal(configurazione.receptionAdesso, 'chiusa');
    assert.equal(m.ultime24h.chiamate, 1);
    assert.equal(m.ultime24h.conAssistente, 1);
    assert.equal(m.ultime24h.domande, 2);
    assert.equal(m.ultime24h.esiti.congedo, 1);
    assert.equal(m.ultime24h.perOra.reduce((tot, p) => tot + p.chiamate, 0), 1);
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
    assert.equal(r.ultime24h.latenzaMediaMs, 2000);
    assert.equal(r.ultime24h.latenzaP95Ms, 3000);
    assert.equal(r.ultime24h.esiti.congedo, 1);
    assert.equal(r.ultime24h.esiti.ripiego, 1);
    assert.equal(r.ultime24h.esiti.in_corso, 1);
    assert.equal(r.errori[0].tipo, 'ClaudeTimeoutError');
    assert.equal(r.errori[0].chiamata, '…CA_err');

    adesso += 6 * 60 * 1000;
    r = m.riepilogo();
    assert.equal(r.ultime24h.esiti.chiusa_dal_chiamante, 1);
    assert.equal(r.ultime24h.esiti.in_corso, 0);
  });

  test('argomenti, preventivi e salute dei servizi', () => {
    let adesso = Date.parse('2026-09-24T20:00:00Z');
    const m = creaMetriche({ now: () => adesso });
    m.registra('CA_a', 'assistente', { motivo: 'chiusa' });
    m.registra('CA_a', 'domanda', { argomenti: ['prezzi'] });
    m.registra('CA_a', 'verifica_disponibilita', { esito: 'disponibile', prezzoMinimo: 166 });
    m.registra('CA_a', 'domanda', { argomenti: ['prezzi', 'animali'] });
    m.registra('CA_a', 'verifica_disponibilita', { esito: 'disponibile', prezzoMinimo: 87 });
    m.registra('CA_a', 'risposta_claude', { ms: 1500 });
    m.registra('CA_b', 'assistente', { motivo: 'chiusa' });
    m.registra('CA_b', 'domanda', { argomenti: ['animali'] });
    m.registra('CA_b', 'verifica_disponibilita', { esito: 'non_raggiungibile' });

    const r = m.riepilogo();
    assert.deepEqual(r.ultime24h.argomenti.map((a) => [a.id, a.chiamate]), [['animali', 2], ['prezzi', 1]]);
    assert.equal(r.ultime24h.argomenti[0].nome, 'Animali');
    // Una chiamata, un preventivo: vale l'ultimo prezzo proposto.
    assert.deepEqual(r.ultime24h.preventivi, { chiamate: 1, valoreEuro: 87 });
    assert.deepEqual(r.ultimeChiamate.find((c) => c.id === '…CA_a').argomenti, ['Prezzi e disponibilità', 'Animali']);
    assert.equal(r.salute.claude.stato, 'ok');
    assert.equal(r.salute.wubook.stato, 'problema');
    assert.equal(r.salute.email.stato, 'nessun_dato');

    // Una verifica riuscita dopo l'errore rimette WuBook in ordine; un errore vecchio non conta.
    m.registra('CA_c', 'verifica_disponibilita', { esito: 'disponibile', prezzoMinimo: 90 });
    assert.equal(m.riepilogo().salute.wubook.stato, 'ok');
    m.registra('CA_d', 'verifica_disponibilita', { esito: 'formato_cambiato' });
    adesso += 7 * 60 * 60 * 1000;
    assert.equal(m.riepilogo().salute.wubook.stato, 'ok');
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

describe('argomenti delle domande', () => {
  const { classificaDomanda } = require('../src/centralino/argomenti');
  test('classificazione per parole chiave, senza conservare il testo', () => {
    assert.deepEqual(classificaDomanda('Quanto costa una doppia dal 3 ottobre?'), ['prezzi']);
    assert.deepEqual(classificaDomanda('Avete il parcheggio?'), ['arrivo']);
    assert.deepEqual(classificaDomanda('Posso portare il cane?'), ['animali']);
    assert.deepEqual(classificaDomanda('A che ora è la colazione?'), ['colazione']);
    assert.deepEqual(classificaDomanda('Vorrei parlare con un operatore'), ['persona']);
    assert.deepEqual(classificaDomanda('Buonasera'), ['altro']);
  });
});
