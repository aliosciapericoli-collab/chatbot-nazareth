// Test di prezzi e disponibilità con WuBook e Claude simulati.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
delete process.env.PUBLIC_BASE_URL;
delete process.env.SMTP_HOST;

const twilio = require('twilio');
const { createApp } = require('../server');
const { creaAssistente, SYSTEM_PROMPT, FRASE_PREZZI, MESSAGGIO_PREZZO_NON_VERIFICATO, importiInEuro } = require('../src/claude');
const { creaMetriche } = require('../src/dashboard/metriche');
const {
  creaClientWuBook,
  decodificaRisposta,
  calcolaOfferte,
  WuBookNonRaggiungibileError,
  WuBookFormatoError,
} = require('../src/disponibilita/wubook');
const { creaStrumentoDisponibilita, validaInput } = require('../src/disponibilita/strumento');

const ADESSO = Date.parse('2026-09-24T10:00:00Z');
const RATE_BB = 49397;
const RATE_SENZA_COLAZIONE = 65382;

// Risposta WuBook con la stessa struttura di quella reale (ridotta).
function rispostaWuBook({ notti = 2, voci = {}, vociSenzaColazione = {} } = {}) {
  const dati = {
    inventory: {
      user_request: { nights: notti, dfrom: 1790805600, dto: 1790805600 + notti * 86400 },
      inventory: { [RATE_BB]: voci, [RATE_SENZA_COLAZIONE]: vociSenzaColazione },
      room_types: [
        { id: 80710, content: { texts: { it: { name: 'Camera Doppia' }, default: { name: 'DOPPIA XX' } } } },
        { id: 80711, content: { texts: { it: { name: 'Camera Tripla - 3 Letti Singoli' }, default: { name: 'TRIPLA 3X' } } } },
        { id: 80712, content: { texts: { it: { name: 'Camera Quadrupla - 4 Letti Singoli' }, default: { name: 'QUADRUPLA 4X' } } } },
      ],
      products: [
        { id: 158027, is_super: 0, id_zak_room_type: 80710, occupancy: { adults: 2 } },
        { id: 158045, is_super: 0, id_zak_room_type: 80710, occupancy: { adults: 1 } },
        { id: 158112, is_super: 0, id_zak_room_type: 80711, occupancy: { adults: 2 } },
        { id: 158030, is_super: 0, id_zak_room_type: 80711, occupancy: { adults: 3 } },
        { id: 159114, is_super: 0, id_zak_room_type: 80712, occupancy: { adults: 2 } },
        { id: 158034, is_super: 0, id_zak_room_type: 80712, occupancy: { adults: 4 } },
      ],
      rates: [{ id: RATE_BB, board: 'bb' }, { id: RATE_SENZA_COLAZIONE, board: 'nb' }],
    },
    packages: [],
    mcosts: { room_level: { rtypes: {}, super_products: {} }, rsrv_level: [] },
  };
  return Buffer.from(JSON.stringify(dati)).toString('base64');
}

const notte = (p, a) => ({ p, sa: a, a, oa: a, op: p });

// Due notti dal 1 al 3 ottobre 2026, come sul sito: Doppia 87+79 (ultima camera), Tripla 99+90, Quadrupla 110+100.
const DISPONIBILE = rispostaWuBook({
  voci: {
    158027: [notte(87, 1), notte(79, 2)],
    158112: [notte(99, 5), notte(90, 6)],
    159114: [notte(110, 3), notte(100, 3)],
    158045: [notte(55, 1), notte(50, 2)],
  },
  vociSenzaColazione: { 158027: [notte(40, 5), notte(40, 5)] },
});
const ESAURITO = rispostaWuBook({ voci: { 158027: [notte(87, 1), notte(79, 0)] } });

function fetchFinto(risposte) {
  const chiamate = [];
  const fn = async (url, opzioni) => {
    chiamate.push({ url, corpo: String(opzioni.body) });
    const r = typeof risposte === 'function' ? risposte(opzioni) : risposte;
    if (r instanceof Error) throw r;
    if (r?.attesa) {
      return new Promise((_, reject) => {
        opzioni.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
      });
    }
    if (r?.ritardoMs) await new Promise((res) => setTimeout(res, r.ritardoMs));
    return { ok: (r?.status ?? 200) === 200, status: r?.status ?? 200, text: async () => r?.corpo ?? r };
  };
  fn.chiamate = chiamate;
  return fn;
}

describe('WuBook: lettura e calcolo', () => {
  test('disponibile: prezzo totale del soggiorno, solo colazione inclusa, dal più economico', () => {
    const inv = decodificaRisposta(DISPONIBILE);
    const { notti, offerte } = calcolaOfferte(inv, { persone: 2, adesso: ADESSO });
    assert.equal(notti, 2);
    assert.deepEqual(offerte, [
      { tipologia: 'Camera Doppia', prezzoTotale: 166, ultimaCamera: true },
      { tipologia: 'Camera Tripla - 3 Letti Singoli', prezzoTotale: 189, ultimaCamera: false },
      { tipologia: 'Camera Quadrupla - 4 Letti Singoli', prezzoTotale: 210, ultimaCamera: false },
    ]);
  });

  test('esaurito: una notte senza camere rende la tipologia non prenotabile', () => {
    const { offerte } = calcolaOfferte(decodificaRisposta(ESAURITO), { persone: 2, adesso: ADESSO });
    assert.deepEqual(offerte, []);
  });

  test('restrizioni della pagina: soggiorno minimo, chiusura, arrivo non consentito, notti mancanti', () => {
    const casi = {
      soggiornoMinimo: [{ ...notte(87, 3), m: 3 }, notte(79, 3)],
      chiuso: [notte(87, 3), { ...notte(79, 3), c: 1 }],
      arrivoNonConsentito: [{ ...notte(87, 3), ni: 1 }, notte(79, 3)],
      nottiMancanti: [notte(87, 3)],
    };
    for (const [nome, voci] of Object.entries(casi)) {
      const inv = decodificaRisposta(rispostaWuBook({ voci: { 158027: voci } }));
      assert.deepEqual(calcolaOfferte(inv, { persone: 2, adesso: ADESSO }).offerte, [], nome);
    }
  });

  test('formato cambiato: errore dedicato', () => {
    assert.throws(() => decodificaRisposta('<html>manutenzione</html>'), WuBookFormatoError);
    assert.throws(() => decodificaRisposta(Buffer.from('{"inventory":{}}').toString('base64')), WuBookFormatoError);
    const senzaPrezzo = JSON.parse(Buffer.from(DISPONIBILE, 'base64').toString());
    senzaPrezzo.inventory.inventory[RATE_BB][158027] = [{ price: 87 }, { price: 79 }];
    assert.throws(() => decodificaRisposta(Buffer.from(JSON.stringify(senzaPrezzo)).toString('base64')), WuBookFormatoError);
  });

  test('richiesta come la pagina pubblica: POST con date DD/MM/YYYY e colazione inclusa', async () => {
    const fetch = fetchFinto(DISPONIBILE);
    await creaClientWuBook({ fetch }).inventario('2026-10-01', '2026-10-03');
    assert.equal(fetch.chiamate[0].url, 'https://wubook.net/nneb/bk/inv?ep=17104f2c');
    const corpo = new URLSearchParams(fetch.chiamate[0].corpo);
    assert.equal(corpo.get('dfrom'), '01/10/2026');
    assert.equal(corpo.get('dto'), '03/10/2026');
    assert.equal(corpo.get('board'), 'bb');
    assert.equal(corpo.get('currency'), 'EUR');
  });

  test('cache di 5 minuti per coppia di date; gli errori non restano in cache', async () => {
    let adesso = ADESSO;
    const fetch = fetchFinto(DISPONIBILE);
    const client = creaClientWuBook({ fetch, now: () => adesso });
    await client.inventario('2026-10-01', '2026-10-03');
    const seconda = await client.inventario('2026-10-01', '2026-10-03');
    assert.equal(seconda.daCache, true);
    assert.equal(fetch.chiamate.length, 1);
    adesso += 5 * 60 * 1000 + 1;
    await client.inventario('2026-10-01', '2026-10-03');
    assert.equal(fetch.chiamate.length, 2);

    let fallisce = true;
    const fetchErrore = fetchFinto(() => (fallisce ? new TypeError('fetch failed') : DISPONIBILE));
    const client2 = creaClientWuBook({ fetch: fetchErrore });
    await assert.rejects(client2.inventario('2026-10-01', '2026-10-03'), WuBookNonRaggiungibileError);
    fallisce = false;
    assert.equal((await client2.inventario('2026-10-01', '2026-10-03')).daCache, false);
  });

  test('timeout: WuBook che non risponde viene abbandonato dopo il limite', async () => {
    const client = creaClientWuBook({ fetch: fetchFinto({ attesa: true }), timeoutMs: 100 });
    const inizio = Date.now();
    await assert.rejects(client.inventario('2026-10-01', '2026-10-03'), (e) => e instanceof WuBookNonRaggiungibileError && /timeout 100 ms/.test(e.message));
    assert.ok(Date.now() - inizio < 1000);
  });

  test('HTTP in errore: non raggiungibile', async () => {
    const client = creaClientWuBook({ fetch: fetchFinto({ status: 503, corpo: '' }) });
    await assert.rejects(client.inventario('2026-10-01', '2026-10-03'), WuBookNonRaggiungibileError);
  });
});

describe('strumento verifica_disponibilita', () => {
  const oggi = '2026-09-24';

  test('controllo dei dati: passato, partenza mancante, notti, persone', () => {
    assert.match(validaInput({ arrivo: '2026-09-01', partenza: '2026-09-02', adulti: 2 }, oggi).errore, /passato/);
    assert.match(validaInput({ arrivo: '2026-10-01', adulti: 2 }, oggi).errore, /partenza o il numero di notti/);
    assert.match(validaInput({ arrivo: '2026-10-03', partenza: '2026-10-01', adulti: 2 }, oggi).errore, /dopo l'arrivo/);
    assert.match(validaInput({ arrivo: '2026-02-30', notti: 1, adulti: 2 }, oggi).errore, /arrivo mancante o non valida/);
    assert.match(validaInput({ arrivo: '2026-10-01', notti: 2, adulti: 0 }, oggi).errore, /adulti/);
    assert.deepEqual(validaInput({ arrivo: '2026-10-01', notti: 2, adulti: 2 }, oggi), {
      arrivo: '2026-10-01', partenza: '2026-10-03', notti: 2, adulti: 2, bambini: 0,
    });
  });

  const strumento = (fetch, log = () => {}) =>
    creaStrumentoDisponibilita({ wubook: creaClientWuBook({ fetch, now: () => ADESSO, timeoutMs: 100 }), now: () => ADESSO, log });

  test('disponibile: tipologie, prezzi totali, ultima camera, tassa di soggiorno', async () => {
    const r = await strumento(fetchFinto(DISPONIBILE)).esegui({ arrivo: '2026-10-01', partenza: '2026-10-03', adulti: 2 });
    const dati = JSON.parse(r.contenuto);
    assert.equal(r.esito, 'disponibile');
    assert.equal(r.errore, false);
    assert.equal(dati.notti, 2);
    assert.deepEqual(dati.camere[0], { tipologia: 'Camera Doppia', prezzo_totale_euro: 166, ultima_camera: true });
    assert.match(dati.nota, /colazione inclusa/);
    assert.match(dati.nota, /Tassa di soggiorno esclusa: 2,30 euro a persona a notte, per al massimo 3 notti.*al massimo 9,20 euro/);
    assert.match(dati.nota, /Non hai prenotato né bloccato nulla/);
  });

  test('esaurito', async () => {
    const r = await strumento(fetchFinto(ESAURITO)).esegui({ arrivo: '2026-10-01', notti: 2, adulti: 2 });
    assert.equal(r.esito, 'nessuna_disponibilita');
    assert.match(JSON.parse(r.contenuto).istruzione, /Nessuna camera disponibile/);
  });

  test('troppe persone per una camera', async () => {
    const r = await strumento(fetchFinto(DISPONIBILE)).esegui({ arrivo: '2026-10-01', notti: 2, adulti: 5 });
    assert.equal(r.esito, 'troppe_persone_per_una_camera');
  });

  test('timeout e formato cambiato: verifica non riuscita, nessun prezzo, evento nei log', async () => {
    for (const [risposta, esitoAtteso] of [[{ attesa: true }, 'non_raggiungibile'], ['{"altro":1}', 'formato_cambiato']]) {
      const log = [];
      const r = await strumento(fetchFinto(risposta), (...a) => log.push(a)).esegui({ arrivo: '2026-10-01', notti: 2, adulti: 2 }, { chiamataId: 'CA1' });
      assert.equal(r.errore, true);
      assert.equal(r.esito, esitoAtteso);
      assert.equal(JSON.parse(r.contenuto).esito, 'verifica_non_riuscita');
      assert.doesNotMatch(r.contenuto, /euro/);
      assert.equal(log[0][1], 'verifica_disponibilita');
      assert.equal(log[0][2].esito, esitoAtteso);
    }
  });
});

describe('prezzi al telefono (Twilio + Claude simulati)', () => {
  // Claude simulato: la prima risposta chiede lo strumento, la seconda legge il risultato.
  function claudeConStrumento(testoFinale, input = { arrivo: '2026-10-01', partenza: '2026-10-03', adulti: 2, bambini: 0 }) {
    const richieste = [];
    const risposte = [
      { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Controllo.' }, { type: 'tool_use', id: 'toolu_1', name: 'verifica_disponibilita', input }] },
      { stop_reason: 'end_turn', content: [{ type: 'text', text: testoFinale }] },
    ];
    const client = { messages: { create: async (params) => { richieste.push(structuredClone(params)); return risposte.shift(); } } };
    return { client, richieste };
  }

  async function conServer({ client, fetch }, corpo) {
    const wubook = creaClientWuBook({ fetch, timeoutMs: 150 });
    const assistente = creaAssistente({
      client,
      timeoutMs: 1000,
      strumenti: [creaStrumentoDisponibilita({ wubook, now: () => ADESSO })],
    });
    const app = createApp({ assistente, wubook, dashboardPassword: '' });
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const base = `http://localhost:${server.address().port}`;
    const post = async (path, params) => {
      const url = base + path;
      const inizio = Date.now();
      const res = await fetch_(url, params);
      return { status: res.status, body: await res.text(), ms: Date.now() - inizio };
    };
    const fetch_ = (url, params) => globalThis.fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    try {
      await corpo(post);
    } finally {
      server.close();
    }
  }

  test('disponibile: "un attimo" subito, poi prezzi con le frasi obbligatorie', async () => {
    const { client, richieste } = claudeConStrumento(
      'Dal primo al tre ottobre per due adulti la Camera Doppia costa 166 euro in totale, colazione inclusa, ed è l\'ultima disponibile; la Tripla costa 189 euro.'
    );
    const fetch = fetchFinto({ corpo: DISPONIBILE, ritardoMs: 300 });
    await conServer({ client, fetch }, async (post) => {
      const primo = await post('/handle-speech', { CallSid: 'CA_prezzi', SpeechResult: 'Quanto costa una doppia dal primo al tre ottobre per due?' });
      assert.equal(primo.body,
        '<?xml version="1.0" encoding="UTF-8"?><Response>' +
        '<Say voice="Polly.Bianca-Neural" language="it-IT">Un attimo, controllo la disponibilità.</Say>' +
        '<Redirect method="POST">/prosegui?motivo=verifica</Redirect></Response>');
      // La risposta a Twilio non aspetta WuBook (300 ms).
      assert.ok(primo.ms < 250, `prima risposta in ${primo.ms} ms`);

      const secondo = await post('/prosegui?motivo=verifica', { CallSid: 'CA_prezzi' });
      assert.match(secondo.body, /Camera Doppia costa 166 euro/);
      assert.match(secondo.body, /La tassa di soggiorno è esclusa: due euro e trenta a persona a notte, per al massimo tre notti\./);
      assert.ok(secondo.body.includes(FRASE_PREZZI));
      assert.match(secondo.body, /<Gather /);

      // Seconda chiamata a Claude: risultato dello strumento e nessun altro strumento.
      assert.deepEqual(richieste[1].tool_choice, { type: 'none' });
      const risultato = richieste[1].messages.at(-1).content[0];
      assert.equal(risultato.type, 'tool_result');
      assert.equal(risultato.tool_use_id, 'toolu_1');
      assert.match(risultato.content, /"prezzo_totale_euro":166,"ultima_camera":true/);
      assert.equal(richieste[0].tools[0].name, 'verifica_disponibilita');
      assert.match(richieste[0].system, /Oggi è giovedì 24 settembre 2026/);
    });
  });

  test('i prezzi non restano nello storico come dati: alla domanda dopo si riverifica', async () => {
    const { client, richieste } = claudeConStrumento('La Doppia costa 166 euro. ' + FRASE_PREZZI + ' La tassa di soggiorno è esclusa.');
    const altreRisposte = [{ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Prego.' }] }];
    const originale = client.messages.create;
    client.messages.create = async (params) => (richieste.length < 2 ? originale(params) : (richieste.push(structuredClone(params)), altreRisposte.shift()));
    await conServer({ client, fetch: fetchFinto(DISPONIBILE) }, async (post) => {
      await post('/handle-speech', { CallSid: 'CA_storico', SpeechResult: 'Prezzi dal primo al tre ottobre per due?' });
      await post('/prosegui?motivo=verifica', { CallSid: 'CA_storico' });
      await post('/handle-speech', { CallSid: 'CA_storico', SpeechResult: 'Grazie' });
    });
    const storico = richieste[2].messages;
    assert.ok(storico.every((m) => typeof m.content === 'string'), 'solo testo nello storico');
    assert.equal(storico.length, 3);
  });

  test('WuBook non risponde: il bot dice che non riesce a verificare, senza prezzi né frase obbligatoria', async () => {
    const { client, richieste } = claudeConStrumento('In questo momento non riesco a verificare la disponibilità: può controllare sul sito o scriverci su WhatsApp.');
    await conServer({ client, fetch: fetchFinto({ attesa: true }) }, async (post) => {
      await post('/handle-speech', { CallSid: 'CA_timeout', SpeechResult: 'Avete posto il primo ottobre?' });
      const r = await post('/prosegui?motivo=verifica', { CallSid: 'CA_timeout' });
      assert.match(r.body, /non riesco a verificare/);
      assert.ok(!r.body.includes(FRASE_PREZZI));
      assert.match(r.body, /<Gather /);
    });
    const risultato = richieste[1].messages.at(-1).content[0];
    assert.equal(risultato.is_error, true);
    assert.match(risultato.content, /verifica_non_riuscita/);
  });

  test('"prosegui" senza verifica in corso (per esempio dopo un riavvio): chiede di ripetere', async () => {
    const { client } = claudeConStrumento('x');
    await conServer({ client, fetch: fetchFinto(DISPONIBILE) }, async (post) => {
      const r = await post('/prosegui?motivo=verifica', { CallSid: 'CA_nessuna' });
      assert.match(r.body, /Mi scusi, può ripetere la domanda\?<\/Say><Gather /);
    });
  });

  test('prezzo inventato senza verifica: bloccato dal server, il cliente viene rimandato al sito', async () => {
    const richieste = [];
    const client = { messages: { create: async (p) => { richieste.push(p); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Di solito una doppia costa circa 90 euro a notte.' }] }; } } };
    const metriche = creaMetriche();
    const assistente = creaAssistente({ client, timeoutMs: 1000 });
    const app = createApp({ assistente, metriche, dashboardPassword: '' });
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    try {
      const url = `http://localhost:${server.address().port}/handle-speech`;
      const params = { CallSid: 'CA_inventa', SpeechResult: 'Quanto costa più o meno una doppia?' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', 'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params) },
        body: new URLSearchParams(params).toString(),
      });
      const body = await res.text();
      assert.doesNotMatch(body, /90 euro/);
      assert.ok(body.includes(MESSAGGIO_PREZZO_NON_VERIFICATO));
      assert.match(body, /<Gather /);
      assert.equal(metriche.riepilogo().oggi.verifichePrezzi.prezziBloccati, 1);
    } finally {
      server.close();
    }
  });

  test('WuBook giù e Claude che dà comunque una cifra: bloccata', async () => {
    const { client } = claudeConStrumento('Non riesco a verificare, ma indicativamente sono 80 euro.');
    await conServer({ client, fetch: fetchFinto({ attesa: true }) }, async (post) => {
      await post('/handle-speech', { CallSid: 'CA_giu', SpeechResult: 'Prezzo dal primo al tre ottobre per due?' });
      const r = await post('/prosegui?motivo=verifica', { CallSid: 'CA_giu' });
      assert.doesNotMatch(r.body, /80 euro/);
      assert.ok(r.body.includes(MESSAGGIO_PREZZO_NON_VERIFICATO));
    });
  });

  test('gli importi della base di conoscenza restano ammessi senza verifica', async () => {
    const client = { messages: { create: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'Fumare in camera comporta un addebito di 150 euro; la tassa di soggiorno è di 2,30 euro a persona a notte.' }] }) } };
    const risposta = await creaAssistente({ client, timeoutMs: 1000 }).rispondi([{ role: 'user', content: 'Si può fumare?' }]);
    assert.match(risposta.testo, /150 euro/);
    assert.equal(risposta.prezzoBloccato, undefined);
    assert.deepEqual(importiInEuro('Costa 166 euro, poi € 90 e 2,30 euro.'), [166, 90, 2.3]);
  });

  test('dashboard: verifiche riuscite e non riuscite contate a parte', () => {
    const m = creaMetriche();
    for (const esito of ['disponibile', 'nessuna_disponibilita', 'non_raggiungibile', 'formato_cambiato', 'input_non_valido']) {
      m.registra('CA1', 'verifica_disponibilita', { esito });
    }
    assert.deepEqual(m.riepilogo().oggi.verifichePrezzi, { riuscite: 2, nonRiuscite: 2, prezziBloccati: 0 });
    assert.equal(m.riepilogo().errori.length, 2);
  });

  test('il prompt limita prezzi e disponibilità allo strumento', () => {
    assert.match(SYSTEM_PROMPT, /Prezzi e disponibilità puoi darli SOLO con i dati appena ottenuti dallo strumento verifica_disponibilita/);
    assert.match(SYSTEM_PROMPT, /non ripeterli da risposte precedenti/);
    assert.match(SYSTEM_PROMPT, /"questo weekend" è da venerdì a domenica/);
    assert.match(SYSTEM_PROMPT, /tassa di soggiorno è esclusa: due euro e trenta a persona a notte/);
    assert.ok(SYSTEM_PROMPT.includes(`Chiudi sempre la risposta con questa frase: "${FRASE_PREZZI}"`));
    assert.match(SYSTEM_PROMPT, /Per gruppi che occupano più di quattro camere non dare prezzi/);
    assert.match(SYSTEM_PROMPT, /Non prendere prenotazioni, non confermarle e non bloccare camere/);
  });
});
