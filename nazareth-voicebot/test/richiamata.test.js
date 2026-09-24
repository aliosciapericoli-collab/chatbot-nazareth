// Test della richiamata con Claude e SMTP simulati, attraverso il webhook Twilio.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const AUTH_TOKEN = 'token_di_test';
process.env.TWILIO_AUTH_TOKEN = AUTH_TOKEN;
process.env.TWILIO_VALIDATE_SIGNATURE = 'true';
process.env.RECEPTION_MODE = 'chiusa';
delete process.env.PUBLIC_BASE_URL;
delete process.env.SMTP_HOST;
delete process.env.TWILIO_PHONE_NUMBER;
delete process.env.CALLBACK_EMAIL_TO;

const twilio = require('twilio');
const { createApp } = require('../server');
const { creaAssistente, estraiRichiamata, SYSTEM_PROMPT, SYSTEM_PROMPT_SENZA_RICHIAMATA } = require('../src/claude');
const { componiEmail } = require('../src/notifiche/email-richiamata');
const { leggiNumero, numeroProponibile } = require('../src/centralino/numeri');

const NUMERO_CLIENTE = '+393331234567';
const BLOCCO = (dati) => `[RICHIAMATA]${JSON.stringify(dati)}[/RICHIAMATA]`;
const CONFERMA = 'Perfetto, ho lasciato il messaggio alla reception: la ricontatteranno in orario di apertura. I suoi dati servono solo per ricontattarla e vengono cancellati dopo la richiamata. Posso esserle utile in altro?';

// Claude simulato: risponde con i testi in coda e registra le richieste.
function claudeFinto(risposte) {
  const richieste = [];
  const client = {
    messages: {
      create: async (params) => {
        richieste.push(structuredClone(params));
        return { content: [{ type: 'text', text: risposte.shift() }], stop_reason: 'end_turn' };
      },
    },
  };
  return { assistente: creaAssistente({ client, timeoutMs: 1000 }), richieste };
}

// SMTP simulato: `ritardoMs` per verificare che l'invio non rallenti la risposta a Twilio.
function smtpFinto({ errore, ritardoMs = 0 } = {}) {
  const inviate = [];
  return {
    inviate,
    sendMail: async (email) => {
      await new Promise((r) => setTimeout(r, ritardoMs));
      if (errore) throw errore;
      inviate.push({ ...email, ts: Date.now() });
      return { messageId: 'x' };
    },
  };
}

let log;
let consoleLog;
beforeEach(() => {
  log = [];
  consoleLog = console.log;
  console.log = (riga) => log.push(String(riga));
});
afterEach(() => {
  console.log = consoleLog;
});

const eventi = () => log.map((r) => { try { return JSON.parse(r); } catch { return {}; } });
const attendi = (ms) => new Promise((r) => setTimeout(r, ms));

async function conServer(opzioni, corpo) {
  const app = createApp({ dashboardPassword: '', ...opzioni });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://localhost:${server.address().port}`;
  const parla = async (frase, { from = NUMERO_CLIENTE, callSid = 'CA_richiamata' } = {}) => {
    const url = `${base}/handle-speech`;
    const params = { CallSid: callSid, SpeechResult: frase, From: from };
    const inizio = Date.now();
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'X-Twilio-Signature': twilio.getExpectedTwilioSignature(AUTH_TOKEN, url, params),
      },
      body: new URLSearchParams(params).toString(),
    });
    return { status: res.status, body: await res.text(), ms: Date.now() - inizio, fine: Date.now() };
  };
  try {
    await corpo(parla);
  } finally {
    server.close();
  }
}

describe('richiamata', () => {
  test('accettazione: email alla reception dopo la risposta a Twilio, blocco mai letto al chiamante', async () => {
    const { assistente, richieste } = claudeFinto([
      'Non conosco i prezzi. Se vuole, lascio un messaggio alla reception e la ricontattiamo in orario di apertura, dalle sette alle venti.',
      'Certo. Mi dice il suo nome?',
      'Grazie. In breve, per cosa desidera essere ricontattato?',
      'Posso ricontattarla al numero da cui chiama, tre tre tre, uno due tre, quattro cinque sei sette?',
      'Riepilogo: Mario Rossi, preventivo per una doppia a ottobre, numero tre tre tre, uno due tre, quattro cinque sei sette. È corretto?',
      `${CONFERMA} ${BLOCCO({ nome: 'Mario Rossi', numero: '+393331234567', motivo: 'Preventivo per una camera doppia a ottobre' })}`,
    ]);
    const smtp = smtpFinto({ ritardoMs: 300 });

    await conServer({ assistente, trasportoEmail: smtp }, async (parla) => {
      await parla('Quanto costa una doppia?');
      await parla('Sì, grazie');
      await parla('Mario Rossi');
      await parla('Un preventivo per una doppia a ottobre');
      await parla('Sì, va bene');
      const conferma = await parla('Sì, è corretto');

      // Il numero del chiamante arriva a Claude già scritto a parole.
      assert.match(richieste[3].system, /Numero da cui chiama il cliente, da leggere così: "tre tre tre, uno due tre, quattro cinque sei sette"/);
      assert.ok(richieste[3].system.includes('Richiamata dalla reception:'));
      assert.ok(richieste[3].system.startsWith(SYSTEM_PROMPT));

      // Al chiamante arriva solo il testo parlato, poi l'ascolto continua.
      assert.equal(conferma.status, 200);
      assert.ok(conferma.body.includes('I suoi dati servono solo per ricontattarla e vengono cancellati dopo la richiamata.'));
      assert.doesNotMatch(conferma.body, /RICHIAMATA|\{|"nome"/);
      assert.match(conferma.body, /<Gather /);

      // La risposta a Twilio non aspetta l'SMTP (che impiega 300 ms).
      assert.ok(conferma.ms < 250, `risposta in ${conferma.ms} ms`);
      assert.equal(smtp.inviate.length, 0);
      await attendi(500);
      assert.equal(smtp.inviate.length, 1);
      assert.ok(smtp.inviate[0].ts > conferma.fine);

      const email = smtp.inviate[0];
      assert.equal(email.to, 'info@nazarethresidence.com');
      assert.equal(email.subject, 'Richiamata richiesta - Mario Rossi');
      assert.match(email.text, /Data e ora: \d{2}\/\d{2}\/\d{4} \d{2}:\d{2} \(ora di Roma\)/);
      assert.match(email.text, /Nome: Mario Rossi/);
      assert.match(email.text, /Numero da richiamare: \+393331234567/);
      assert.doesNotMatch(email.text, /Numero da cui ha chiamato/);
      assert.match(email.text, /Motivo: Preventivo per una camera doppia a ottobre/);
      assert.match(email.text, /Cliente: Quanto costa una doppia\?\nAssistente: Non conosco i prezzi/);
      assert.match(email.text, /Cliente: Sì, è corretto\nAssistente: Perfetto, ho lasciato il messaggio/);
      assert.doesNotMatch(email.text, /\[RICHIAMATA\]/);
    });

    // Log: solo eventi tecnici, nessun dato personale.
    assert.ok(eventi().some((e) => e.evento === 'richiamata_richiesta' && e.datiCompleti === true));
    assert.ok(eventi().some((e) => e.evento === 'richiamata_email_inviata'));
    assert.doesNotMatch(log.join('\n'), /Mario|3331234567|preventivo/i);
  });

  test('rifiuto: nessuna email', async () => {
    const { assistente } = claudeFinto([
      'Se vuole, lascio un messaggio alla reception e la ricontattiamo in orario di apertura, dalle sette alle venti.',
      'Va bene. Può anche scriverci su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre. Posso esserle utile in altro?',
    ]);
    const smtp = smtpFinto();
    await conServer({ assistente, trasportoEmail: smtp }, async (parla) => {
      await parla('Vorrei parlare con un operatore');
      const r = await parla('No, grazie');
      assert.match(r.body, /WhatsApp/);
      await attendi(100);
    });
    assert.equal(smtp.inviate.length, 0);
    assert.ok(!eventi().some((e) => e.evento === 'richiamata_richiesta'));
  });

  test('numero dettato diverso da quello da cui chiama: nell\'email ci sono entrambi', async () => {
    const { assistente } = claudeFinto([
      `${CONFERMA} ${BLOCCO({ nome: 'Anna Bianchi', numero: '+39 06 1234 5678', motivo: 'Ritiro parrocchiale per 40 persone' })}`,
    ]);
    const smtp = smtpFinto();
    await conServer({ assistente, trasportoEmail: smtp }, async (parla) => {
      await parla('Sì, confermo');
      await attendi(100);
    });
    assert.equal(smtp.inviate.length, 1);
    assert.match(smtp.inviate[0].text, /Numero da richiamare: \+390612345678/);
    assert.match(smtp.inviate[0].text, /Numero da cui ha chiamato: \+393331234567/);
  });

  test('chiamata trasferita con il numero della reception: il numero non viene proposto', async () => {
    const { assistente, richieste } = claudeFinto(['Mi può dettare il numero a cui ricontattarla?']);
    await conServer({ assistente, trasportoEmail: smtpFinto() }, async (parla) => {
      await parla('Mario Rossi', { from: '+3907611564612' });
    });
    assert.match(richieste[0].system, /Il numero da cui chiama il cliente non è disponibile/);
    const datiChiamata = richieste[0].system.split('<dati_chiamata>')[1];
    assert.doesNotMatch(datiChiamata, /da leggere così/);
  });

  test('SMTP non configurato: la richiamata non viene offerta; se il blocco arriva comunque, il chiamante non se ne accorge', async () => {
    const { assistente, richieste } = claudeFinto([
      `${CONFERMA} ${BLOCCO({ nome: 'Mario Rossi', numero: NUMERO_CLIENTE, motivo: 'Gruppo di 30 persone' })}`,
    ]);
    await conServer({ assistente }, async (parla) => {
      const r = await parla('Sì, è corretto');
      assert.equal(r.status, 200);
      assert.ok(r.body.includes('I suoi dati servono solo per ricontattarla'));
      assert.match(r.body, /<Gather /);
      await attendi(100);
    });
    const evento = eventi().find((e) => e.evento === 'richiamata_email_non_inviata');
    assert.ok(evento);
    assert.equal(evento.motivo, 'smtp_non_configurato');
    // Senza SMTP a Claude non arriva nessuna istruzione sulla richiamata.
    assert.equal(richieste[0].system, SYSTEM_PROMPT_SENZA_RICHIAMATA);
    assert.equal(evento.chiamataId, 'CA_richiamata');
    assert.doesNotMatch(log.join('\n'), /Mario|3331234567|Gruppo/);
  });

  test('SMTP in errore: il chiamante non se ne accorge, il log non contiene il messaggio d\'errore', async () => {
    const errore = Object.assign(new Error('Invalid login: 535 per Mario Rossi +393331234567'), { code: 'EAUTH', responseCode: 535 });
    const { assistente } = claudeFinto([
      `${CONFERMA} ${BLOCCO({ nome: 'Mario Rossi', numero: NUMERO_CLIENTE, motivo: 'Preventivo' })}`,
    ]);
    await conServer({ assistente, trasportoEmail: smtpFinto({ errore }) }, async (parla) => {
      const r = await parla('Sì');
      assert.equal(r.status, 200);
      assert.match(r.body, /<Gather /);
      await attendi(100);
    });
    const evento = eventi().find((e) => e.evento === 'richiamata_email_errore');
    assert.ok(evento);
    assert.equal(evento.codice, 'EAUTH');
    assert.equal(evento.risposta, 535);
    assert.doesNotMatch(log.join('\n'), /Mario|3331234567|Invalid login/);
  });

  test('blocco ripetuto nella stessa chiamata: una sola email', async () => {
    const blocco = BLOCCO({ nome: 'Mario Rossi', numero: NUMERO_CLIENTE, motivo: 'Preventivo' });
    const { assistente } = claudeFinto([`${CONFERMA} ${blocco}`, `Certo. ${blocco}`]);
    const smtp = smtpFinto();
    await conServer({ assistente, trasportoEmail: smtp }, async (parla) => {
      await parla('Sì');
      await parla('Grazie');
      await attendi(100);
    });
    assert.equal(smtp.inviate.length, 1);
    assert.ok(eventi().some((e) => e.evento === 'richiamata_duplicata_ignorata'));
  });

  test('saluto finale insieme alla conferma: email inviata e chiamata chiusa', async () => {
    const { assistente } = claudeFinto([
      `Ho lasciato il messaggio alla reception. I suoi dati servono solo per ricontattarla e vengono cancellati dopo la richiamata. Arrivederci. [FINE] ${BLOCCO({ nome: 'Luca', numero: NUMERO_CLIENTE, motivo: 'Info gruppi' })}`,
    ]);
    const smtp = smtpFinto();
    await conServer({ assistente, trasportoEmail: smtp }, async (parla) => {
      const r = await parla('Sì, grazie, arrivederci');
      assert.match(r.body, /Arrivederci\.<\/Say><Hangup\/>/);
      await attendi(100);
    });
    assert.equal(smtp.inviate.length, 1);
    assert.equal(smtp.inviate[0].subject, 'Richiamata richiesta - Luca');
  });
});

describe('richiamata: funzioni di supporto', () => {
  test('blocco con JSON non valido: testo pulito e campi vuoti, l\'email parte comunque', () => {
    const { parlato, richiamata } = estraiRichiamata('Ho lasciato il messaggio. [RICHIAMATA]{nome: Mario[/RICHIAMATA]');
    assert.equal(parlato.trim(), 'Ho lasciato il messaggio.');
    assert.deepEqual(richiamata, { nome: null, numero: null, motivo: null });

    const senzaChiusura = estraiRichiamata('Fatto. [RICHIAMATA]{"nome":"Mario"');
    assert.equal(senzaChiusura.parlato.trim(), 'Fatto.');

    assert.equal(estraiRichiamata('Nessun blocco qui.').richiamata, null);
  });

  test('email: oggetto su una riga e campi mancanti segnalati', () => {
    const { subject, text } = componiEmail({
      richiamata: { nome: 'Mario\r\nBcc: spam@example.com', numero: null, motivo: null },
      numeroChiamante: null,
      messages: [{ role: 'user', content: 'Ciao' }],
      ricevutaIl: Date.parse('2026-09-24T20:05:00Z'),
    });
    assert.equal(subject, 'Richiamata richiesta - Mario Bcc: spam@example.com');
    assert.doesNotMatch(subject, /[\r\n]/);
    assert.match(text, /Data e ora: 24\/09\/2026 22:05 \(ora di Roma\)/);
    assert.match(text, /Numero da richiamare: \(non rilevato: vedi conversazione\)/);
  });

  test('lettura del numero a gruppi e numeri da non proporre', () => {
    assert.equal(leggiNumero('+393331234567'), 'tre tre tre, uno due tre, quattro cinque sei sette');
    assert.equal(leggiNumero('+390761564612'), 'zero sette sei, uno cinque sei, quattro sei uno due');
    assert.equal(numeroProponibile('+393331234567', ['+3907611564612']), true);
    assert.equal(numeroProponibile('+3907611564612', ['+3907611564612']), false);
    assert.equal(numeroProponibile('anonymous'), false);
    assert.equal(numeroProponibile('sip:ospite@example.com'), false);
    assert.equal(numeroProponibile(null), false);
  });

  test('senza email configurata il prompt non nomina la richiamata e non raccoglie dati', () => {
    assert.doesNotMatch(SYSTEM_PROMPT_SENZA_RICHIAMATA, /richiamata|lascio un messaggio|\[RICHIAMATA\]/i);
    assert.match(SYSTEM_PROMPT_SENZA_RICHIAMATA, /Non chiedere né annotare nomi, numeri di telefono o altri dati personali e non offrire di far richiamare il cliente\./);
    assert.match(SYSTEM_PROMPT_SENZA_RICHIAMATA, /nessun operatore è disponibile e rimanda a WhatsApp/);
  });

  test('la richiamata si può lasciare a qualsiasi ora', () => {
    assert.match(SYSTEM_PROMPT, /La richiamata si può lasciare a qualsiasi ora, anche di notte\./);
    // Le regole generali restano fuori dalla sezione sulla richiamata.
    const [generali, richiamata] = SYSTEM_PROMPT.split('Richiamata dalla reception:');
    assert.match(generali, /Dai del lei al chiamante/);
    assert.doesNotMatch(richiamata.split('<base_di_conoscenza>')[0], /Dai del lei/);
  });

  test('il prompt descrive la richiamata e mantiene i limiti', () => {
    assert.match(SYSTEM_PROMPT, /Se vuole, lascio un messaggio alla reception e la ricontattiamo in orario di apertura, dalle sette alle venti\./);
    assert.match(SYSTEM_PROMPT, /I suoi dati servono solo per ricontattarla e vengono cancellati dopo la richiamata\./);
    assert.match(SYSTEM_PROMPT, /Non promettere mai un orario preciso di richiamata/);
    assert.match(SYSTEM_PROMPT, /Fuori dalla richiamata descritta più sotto, non chiedere né annotare nomi/);
    assert.doesNotMatch(SYSTEM_PROMPT, /Non chiedere né annotare nomi, date, numeri di telefono/);
  });
});
