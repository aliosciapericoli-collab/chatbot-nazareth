// Test dell'archivio delle conversazioni.
// La parte su Postgres gira solo con TEST_DATABASE_URL (un database di prova, che viene svuotato);
// senza, restano i test che non hanno bisogno del database.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
delete process.env.PUBLIC_BASE_URL;
delete process.env.DATABASE_URL;

const twilio = require('twilio');
const { Pool } = require('pg');
const { createApp } = require('../server');
const { creaCentralino } = require('../src/centralino/centralino');
const { creaConversationStore } = require('../src/conversation-store');
const { creaIntro, INTRO } = require('../src/centralino/messaggi');
const { creaArchivio } = require('../src/archivio/archivio');
const { componiEmail } = require('../src/notifiche/email-richiamata');

const PASSWORD = 'password-di-prova-lunga';
const TEST_DB = process.env.TEST_DATABASE_URL;

async function avvia(app) {
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://localhost:${server.address().port}` };
}

async function accedi(base) {
  const res = await fetch(`${base}/dashboard/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
    redirect: 'manual',
  });
  return res.headers.get('set-cookie').split(';')[0];
}

describe('archivio: senza database', () => {
  test('senza DATABASE_URL l\'archivio è spento e l\'avviso iniziale non cambia', async () => {
    const archivio = creaArchivio({});
    assert.equal(archivio.attivo, false);
    const { server, base } = await avvia(createApp({
      assistente: { rispondi: async () => ({ testo: 'ok', fine: true }) },
      dashboardPassword: PASSWORD,
    }));
    try {
      const cookie = await accedi(base);
      const r = await fetch(`${base}/dashboard/api/archivio`, { headers: { cookie } });
      assert.deepEqual(await r.json(), { attivo: false });
      assert.equal((await fetch(`${base}/dashboard/api/archivio/CA1`, { headers: { cookie } })).status, 404);
      assert.equal((await fetch(`${base}/dashboard/api/archivio`)).status, 401);
    } finally {
      server.close();
    }
  });

  test('con l\'archivio attivo il chiamante sente per quanto viene conservata la conversazione', () => {
    assert.match(creaIntro(90).chiusa, /la conversazione viene conservata per novanta giorni\. Come posso aiutarla\?$/);
    assert.match(creaIntro(45).occupata, /conservata per un periodo limitato\./);
    assert.doesNotMatch(INTRO.chiusa, /conservata/);
  });

  test('il centralino passa all\'archivio ogni battuta, nell\'ordine, e un errore non tocca la chiamata', async () => {
    const battute = [];
    const centralino = creaCentralino({
      assistente: { rispondi: async () => ({ testo: 'La colazione è dalle sette e trenta.', fine: false }) },
      conversazioni: creaConversationStore(),
      numeroReception: '+390000000',
      isReceptionChiusa: () => true,
      giorniConservazione: 90,
      log: () => {},
      trascrivi: (id, ruolo, testo, extra) => battute.push([id, ruolo, testo, extra?.numero ?? null]),
    });
    await centralino.gestisci({ tipo: 'chiamata_in_arrivo', chiamataId: 'CA1' });
    await centralino.gestisci({ tipo: 'parlato', chiamataId: 'CA1', testo: ' A che ora è la colazione? ', numeroChiamante: '+39 333 1234567' });

    assert.deepEqual(battute, [
      ['CA1', 'assistente', creaIntro(90).chiusa, null],
      ['CA1', 'cliente', 'A che ora è la colazione?', '+393331234567'],
      ['CA1', 'assistente', 'La colazione è dalle sette e trenta.', null],
    ]);

    const rotto = creaCentralino({
      assistente: { rispondi: async () => ({ testo: 'Certo.', fine: false }) },
      conversazioni: creaConversationStore(),
      numeroReception: '+390000000',
      isReceptionChiusa: () => true,
      log: () => {},
      trascrivi: () => { throw new Error('database giù'); },
    });
    const azioni = await rotto.gestisci({ tipo: 'parlato', chiamataId: 'CA2', testo: 'Ciao' });
    assert.equal(azioni[0].testo, 'Certo.');
  });
});

describe('archivio: Postgres', { skip: TEST_DB ? false : 'TEST_DATABASE_URL non impostato' }, () => {
  let pool;

  before(async () => {
    pool = new Pool({ connectionString: TEST_DB });
    await pool.query('DROP TABLE IF EXISTS vocalba_email, vocalba_messaggi, vocalba_chiamate');
  });

  after(async () => {
    await pool?.end();
  });

  function postTwilio(base, path, params) {
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

  test('una chiamata con richiamata: conversazione completa e copia identica dell\'email in dashboard', async () => {
    const archivio = creaArchivio({ pool, log: () => {} });
    const inviate = [];
    const smtp = { sendMail: async (email) => { inviate.push(email); return { messageId: 'x' }; } };
    const blocco = '[RICHIAMATA]{"nome":"Mario Rossi","numero":"+393331234567","motivo":"Gruppo di dieci persone"}[/RICHIAMATA]';
    const risposte = [
      { testo: 'Per i gruppi posso lasciare un messaggio alla reception. Come si chiama?', fine: false },
      { testo: `Ho lasciato il messaggio alla reception. I suoi dati servono solo per ricontattarla. Posso esserle utile in altro? ${blocco}`, fine: false },
      { testo: 'Grazie a lei, arrivederci. [FINE]', fine: true },
    ];
    const { creaAssistente } = require('../src/claude');
    // Assistente vero con un client finto: così passa anche l'estrazione della richiamata.
    const assistente = creaAssistente({
      client: { messages: { create: async () => ({ content: [{ type: 'text', text: risposte.shift().testo }], stop_reason: 'end_turn' }) } },
      strumenti: [],
    });
    process.env.SMTP_HOST = 'smtp.example.invalid';
    process.env.CALLBACK_EMAIL_FROM = 'bot@example.invalid';
    const { server, base } = await avvia(createApp({ assistente, archivio, trasportoEmail: smtp, dashboardPassword: PASSWORD }));
    delete process.env.SMTP_HOST;
    delete process.env.CALLBACK_EMAIL_FROM;
    const sid = 'CA0000000000000000000000000000arch1';
    try {
      const benvenuto = await (await postTwilio(base, '/voice', { CallSid: sid, From: '+393331234567' })).text();
      assert.match(benvenuto, /conservata per novanta giorni/);
      await postTwilio(base, '/handle-speech', { CallSid: sid, From: '+393331234567', SpeechResult: 'Siamo un gruppo di dieci persone' });
      await postTwilio(base, '/handle-speech', { CallSid: sid, From: '+393331234567', SpeechResult: 'Mario Rossi, va bene questo numero' });
      await postTwilio(base, '/handle-speech', { CallSid: sid, From: '+393331234567', SpeechResult: 'No grazie, arrivederci' });
      await new Promise((r) => setTimeout(r, 50));
      await archivio.attendi();

      assert.equal(inviate.length, 1);
      const cookie = await accedi(base);
      const elenco = await (await fetch(`${base}/dashboard/api/archivio`, { headers: { cookie } })).json();
      assert.equal(elenco.attivo, true);
      assert.equal(elenco.totale, 1);
      assert.equal(elenco.giorni, 90);
      const [voce] = elenco.chiamate;
      assert.equal(voce.id, sid);
      assert.equal(voce.numero, '+393331234567');
      assert.equal(voce.esito, 'congedo');
      assert.equal(voce.ingresso, 'reception_chiusa');
      assert.equal(voce.richiamata, 'email_inviata');
      assert.equal(voce.domande, 3);
      assert.equal(voce.primaDomanda, 'Siamo un gruppo di dieci persone');
      assert.equal(voce.conEmail, true);

      const c = await (await fetch(`${base}/dashboard/api/archivio/${sid}`, { headers: { cookie } })).json();
      assert.deepEqual(c.messaggi.map((m) => m.ruolo), ['assistente', 'cliente', 'assistente', 'cliente', 'assistente', 'cliente', 'assistente']);
      assert.equal(c.messaggi[1].testo, 'Siamo un gruppo di dieci persone');
      // Il blocco tecnico della richiamata non viene detto al chiamante e non finisce in archivio.
      assert.ok(c.messaggi.every((m) => !m.testo.includes('[RICHIAMATA]')));
      assert.equal(c.messaggi.at(-1).testo, 'Grazie a lei, arrivederci.');

      // Copia esatta dell'email partita.
      assert.equal(c.email.length, 1);
      assert.equal(c.email[0].oggetto, inviate[0].subject);
      assert.equal(c.email[0].testo, inviate[0].text);
      assert.equal(c.email[0].destinatario, inviate[0].to);
      assert.equal(c.email[0].esito, 'inviata');

      // Ricerca per parola e per numero.
      const trovate = await (await fetch(`${base}/dashboard/api/archivio?cerca=dieci`, { headers: { cookie } })).json();
      assert.equal(trovate.chiamate.length, 1);
      const nessuna = await (await fetch(`${base}/dashboard/api/archivio?cerca=piscina`, { headers: { cookie } })).json();
      assert.equal(nessuna.chiamate.length, 0);
      const perNumero = await (await fetch(`${base}/dashboard/api/archivio?cerca=3331234`, { headers: { cookie } })).json();
      assert.equal(perNumero.chiamate.length, 1);

      assert.equal((await fetch(`${base}/dashboard/api/archivio/CA_inesistente`, { headers: { cookie } })).status, 404);
      assert.equal((await fetch(`${base}/dashboard/api/archivio/${encodeURIComponent('x;drop')}`, { headers: { cookie } })).status, 400);
    } finally {
      server.close();
    }
  });

  test('sincronizzazione del registro telefonico, pagine e cancellazione dopo il periodo di conservazione', async () => {
    const archivio = creaArchivio({ pool, giorni: 90, log: () => {} });
    const ora = Date.now();
    const importate = await archivio.sincronizza([
      { sid: 'CA_sync_1', from: '+390611111111', startTime: new Date(ora - 3600e3), duration: '42', status: 'completed', price: '-0.0085', priceUnit: 'USD', direction: 'inbound' },
      { sid: 'CA_sync_figlia', from: '+390611111111', startTime: new Date(ora - 3600e3), duration: '10', status: 'completed', direction: 'outbound-dial', parentCallSid: 'CA_sync_1' },
      { sid: 'CA_vecchia', from: '+390622222222', startTime: new Date(ora - 100 * 86400e3), duration: '30', status: 'completed', direction: 'inbound' },
    ]);
    assert.equal(importate, 2);
    // Una seconda sincronizzazione aggiorna, non duplica.
    await archivio.sincronizza([{ sid: 'CA_sync_1', from: '+390611111111', startTime: new Date(ora - 3600e3), duration: '43', status: 'completed', price: '-0.0090', priceUnit: 'USD', direction: 'inbound' }]);

    const sync = await archivio.dettaglio('CA_sync_1');
    assert.equal(sync.durataSec, 43);
    assert.equal(sync.costo, 0.009);
    assert.equal(sync.numero, '+390611111111');
    assert.deepEqual(sync.messaggi, []);
    assert.equal(await archivio.dettaglio('CA_sync_figlia'), null);

    const pagina1 = await archivio.elenco({ limite: 1 });
    assert.equal(pagina1.chiamate.length, 1);
    assert.equal(pagina1.altre, true);
    const pagina2 = await archivio.elenco({ limite: 1, prima: pagina1.prossima });
    assert.notEqual(pagina2.chiamate[0].id, pagina1.chiamate[0].id);

    assert.ok(await archivio.dettaglio('CA_vecchia'));
    assert.equal(await archivio.pulisci(), 1);
    assert.equal(await archivio.dettaglio('CA_vecchia'), null);
    assert.ok(await archivio.dettaglio('CA_sync_1'));
  });

  test('email non partita: in archivio resta la copia, segnata come non inviata', async () => {
    const archivio = creaArchivio({ pool, log: () => {} });
    const dati = {
      richiamata: { nome: 'Anna', numero: '+393339999999', motivo: 'Fattura' },
      numeroChiamante: null,
      messages: [{ role: 'user', content: 'Vorrei la fattura' }],
      ricevutaIl: Date.parse('2026-09-25T21:00:00Z'),
    };
    const { subject, text } = componiEmail(dati);
    archivio.email('CA_email_ko', { destinatario: 'info@example.invalid', oggetto: subject, testo: text, esito: 'non_inviata' });
    archivio.evento('CA_email_ko', 'richiamata_email_non_inviata', { motivo: 'smtp_non_configurato' });
    await archivio.attendi();
    const c = await archivio.dettaglio('CA_email_ko');
    assert.equal(c.richiamata, 'email_non_inviata');
    assert.equal(c.email[0].esito, 'non_inviata');
    assert.equal(c.email[0].testo, text);
  });

  test('database irraggiungibile: le scritture falliscono in silenzio, con un log senza testo', async () => {
    const log = [];
    const rotto = creaArchivio({ databaseUrl: 'postgres://nessuno@127.0.0.1:1/niente', log: (id, evento, dettagli) => log.push([id, evento, dettagli]) });
    rotto.trascrivi('CA_x', 'cliente', 'Testo riservato del cliente');
    await rotto.attendi();
    await rotto.chiudi();
    assert.equal(log.length, 1);
    assert.equal(log[0][1], 'archivio_errore');
    assert.doesNotMatch(JSON.stringify(log), /riservato/);
  });
});
