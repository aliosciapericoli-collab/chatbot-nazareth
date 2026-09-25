// Test della linea demo di Vocalba (DEMO_PHONE_NUMBER).
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
process.env.DEMO_PHONE_NUMBER = '+1 934 000 0000';
delete process.env.PUBLIC_BASE_URL;
delete process.env.DATABASE_URL;

const twilio = require('twilio');
const { createApp } = require('../server');
const { creaMetriche } = require('../src/dashboard/metriche');
const { creaAssistenteDemo, MESSAGGI_DEMO, PROMPT_DEMO, stessoNumero } = require('../src/demo/linea-demo');

const NUMERO_DEMO = '+19340000000';
const NUMERO_CLIENTE = '+19343867171';

after(() => {
  delete process.env.DEMO_PHONE_NUMBER;
});

function clientFinto(risposte) {
  const richieste = [];
  return {
    richieste,
    messages: {
      create: async (params) => {
        richieste.push(params);
        return { content: [{ type: 'text', text: risposte.shift() }], stop_reason: 'end_turn' };
      },
    },
  };
}

describe('linea demo', () => {
  let server;
  let base;
  const metriche = creaMetriche();
  const archiviate = [];
  const clientDemo = clientFinto([
    'Il check-in è dalle quindici alle venti. Posso esserle utile in altro?',
    'Una doppia costa 90 euro a notte.',
    'Gli animali piccoli sono ammessi con un supplemento di 10 euro a notte. Posso esserle utile in altro?',
    `Perfetto, la richiamo io. [RICHIAMATA]{"nome":"Test","numero":"+393331234567","motivo":"prova"}[/RICHIAMATA]`,
    'Grazie per aver provato Vocalba, arrivederci. [FINE]',
  ]);
  let emailInviate = 0;

  before(async () => {
    const app = createApp({
      assistente: { rispondi: async () => ({ testo: 'Risposta del cliente vero.', fine: false }) },
      assistenteDemo: creaAssistenteDemo({ client: clientDemo }),
      metriche,
      trasportoEmail: { sendMail: async () => { emailInviate += 1; } },
      archivio: {
        attivo: true,
        giorni: 90,
        evento: (...a) => archiviate.push(a),
        trascrivi: (...a) => archiviate.push(a),
        email: (...a) => archiviate.push(a),
      },
    });
    server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    base = `http://localhost:${server.address().port}`;
  });

  after(() => server.close());

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

  test('il numero demo risponde per la struttura dimostrativa, senza toccare il cliente', async () => {
    const sid = 'CA_demo_1';
    const chiamata = { CallSid: sid, To: NUMERO_DEMO, From: '+393331234567' };
    const benvenuto = await post('/voice', chiamata);
    assert.match(benvenuto, /Benvenuto nella demo di Vocalba/);
    assert.doesNotMatch(benvenuto, /Nazareth/);

    assert.match(await post('/handle-speech', { ...chiamata, SpeechResult: 'A che ora è il check-in?' }), /check-in è dalle quindici/);
    // Un prezzo che non è nella base di conoscenza demo viene bloccato.
    const prezzo = await post('/handle-speech', { ...chiamata, SpeechResult: 'Quanto costa una doppia?' });
    assert.match(prezzo, /In questa demo non ci sono prezzi reali/);
    assert.doesNotMatch(prezzo, /90 euro/);
    // Gli importi d'esempio della base di conoscenza sì.
    assert.match(await post('/handle-speech', { ...chiamata, SpeechResult: 'E il cane?' }), /10 euro a notte/);
    // Anche se il modello provasse a lasciare una richiamata, nessuna email parte.
    await post('/handle-speech', { ...chiamata, SpeechResult: 'Mi richiamate?' });
    const saluto = await post('/handle-speech', { ...chiamata, SpeechResult: 'Grazie, arrivederci' });
    assert.match(saluto, /<Hangup\/>/);
    await new Promise((r) => setTimeout(r, 20));

    assert.equal(emailInviate, 0);
    assert.equal(metriche.riepilogo().ultime24h.chiamate, 0);
    assert.deepEqual(archiviate, []);

    // Il prompt della demo non contiene nulla del cliente vero.
    const inviato = clientDemo.richieste[0];
    assert.doesNotMatch(inviato.system, /Nazareth|nazareth|Viterbo/);
    assert.equal(inviato.tools, undefined);
  });

  test('il numero del cliente continua a rispondere come prima', async () => {
    const benvenuto = await post('/voice', { CallSid: 'CA_cliente_1', To: NUMERO_CLIENTE });
    assert.match(benvenuto, /Benvenuto al Nazareth Residence/);
    assert.match(await post('/handle-speech', { CallSid: 'CA_cliente_1', To: NUMERO_CLIENTE, SpeechResult: 'Buonasera' }), /Risposta del cliente vero/);
    assert.equal(metriche.riepilogo().ultime24h.chiamate, 1);
    assert.ok(archiviate.length > 0);
  });

  test('testi e confronto dei numeri', () => {
    for (const testo of [PROMPT_DEMO, JSON.stringify(MESSAGGI_DEMO)]) {
      assert.doesNotMatch(testo, /Nazareth|nazareth|Viterbo|tre quattro otto/);
    }
    assert.ok(stessoNumero('+1 (934) 000-0000', '+19340000000'));
    assert.ok(!stessoNumero(null, '+19340000000'));
    assert.ok(!stessoNumero('+19343867171', '+19340000000'));
  });
});
