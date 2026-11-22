// Test del report giornaliero (senza database e senza rete).
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  creaReportGiornaliero,
  componiReport,
  componiPromptClaudeCode,
  calcolaStatistiche,
  periodoIeri,
} = require('../src/notifiche/report-giornaliero');

const IERI = { giorno: '2026-11-21', da: new Date('2026-11-20T23:00:00Z'), a: new Date('2026-11-21T23:00:00Z') };

function datiCompleti() {
  return {
    completo: true,
    chiamate: [
      { ingresso: 'reception_chiusa', esito: 'congedo', argomenti: ['prezzi', 'colazione'], preventivo: 120, richiamata: null, durataSec: 120, costo: 0.1, valuta: 'USD' },
      { ingresso: 'reception_chiusa', esito: 'congedo', argomenti: ['prezzi'], preventivo: 180, richiamata: 'email_inviata', durataSec: 240, costo: 0.2, valuta: 'USD' },
      { ingresso: 'inoltro_reception', esito: 'reception', argomenti: [], preventivo: null, richiamata: null, durataSec: 60, costo: 0.05, valuta: 'USD' },
    ],
    mancanti: [
      { ts: '2026-11-21T08:15:00Z', domanda: "C'è una piscina?" },
      { ts: '2026-11-21T19:40:00Z', domanda: "C'è una piscina?" },
      { ts: '2026-11-21T20:05:00Z', domanda: 'Si può noleggiare una bici elettrica?' },
    ],
    frasiClienti: [],
  };
}

describe('report giornaliero', () => {
  test('periodo di ieri in ora di Roma, anche con il cambio d\'ora', () => {
    const p = periodoIeri(new Date('2026-11-22T06:30:00Z'));
    assert.equal(p.giorno, '2026-11-21');
    assert.equal(p.da.toISOString(), '2026-11-20T23:00:00.000Z');
    assert.equal(p.a.toISOString(), '2026-11-21T23:00:00.000Z');
    const estate = periodoIeri(new Date('2026-07-10T05:00:00Z'));
    assert.equal(estate.giorno, '2026-07-09');
    assert.equal(estate.da.toISOString(), '2026-07-08T22:00:00.000Z');
  });

  test('statistiche con archivio attivo', () => {
    const s = calcolaStatistiche(datiCompleti());
    assert.equal(s.chiamate, 3);
    assert.equal(s.minuti, 7);
    assert.equal(s.conAssistente, 2);
    assert.deepEqual(s.argomenti[0], ['prezzi', 2]);
    assert.deepEqual(s.preventivi, [120, 180]);
    assert.equal(s.richiamate, 1);
    assert.equal(s.mancanti, 3);
  });

  test('il prompt per Claude Code elenca ogni domanda una volta, con risposta da compilare', () => {
    const prompt = componiPromptClaudeCode({ mancanti: datiCompleti().mancanti, branch: 'ramo-prova' });
    assert.match(prompt, /chatbot-nazareth, cartella nazareth-voicebot, branch ramo-prova/);
    assert.equal(prompt.match(/C'è una piscina\?/g).length, 1);
    assert.equal(prompt.match(/\[DA COMPILARE\]/g).length - 1, 2); // una citazione nelle istruzioni
    assert.match(prompt, /npm test/);
    assert.equal(componiPromptClaudeCode({ mancanti: [] }), null);
  });

  test('testo dell\'email: numeri, domande senza risposta, analisi e prompt', () => {
    const dati = datiCompleti();
    const { subject, text } = componiReport({ periodo: IERI, dati, stat: calcolaStatistiche(dati), analisi: 'Molte domande sui prezzi.', cliente: 'Nazareth Residence' });
    assert.equal(subject, 'Vocalba – report del 21/11/2026: 3 chiamate, 3 senza risposta');
    assert.match(text, /Chiamate ricevute: 3 \(gestite dall'assistente: 2\)/);
    assert.match(text, /Argomenti più chiesti: Prezzi e disponibilità 2/);
    assert.match(text, /Preventivi dati al telefono: 2 \(prezzo minimo medio 150 euro\)/);
    assert.match(text, /09:15 – C'è una piscina\?/);
    assert.match(text, /ANALISI DELLE RICHIESTE \(Claude\)\nMolte domande sui prezzi\./);
    assert.match(text, /PROMPT PRONTO PER CLAUDE CODE/);
    assert.doesNotMatch(text, /archivio delle conversazioni è spento/);
  });

  test('senza archivio: registro Twilio e domande in memoria, con nota', async () => {
    const email = [];
    const report = creaReportGiornaliero({
      archivio: { attivo: false },
      registroTwilio: {
        disponibile: true,
        chiamateRecenti: async () => [
          { sid: 'CA1', startTime: '2026-11-21T10:00:00Z', duration: '90', direction: 'inbound', price: '-0.04', priceUnit: 'USD' },
          { sid: 'CA2', startTime: '2026-11-21T10:00:30Z', duration: '80', direction: 'outbound-dial', parentCallSid: 'CA1' },
          { sid: 'CA3', startTime: '2026-11-22T06:00:00Z', duration: '30', direction: 'inbound' },
        ],
      },
      mancantiRecenti: () => [{ ts: '2026-11-21T12:00:00Z', domanda: 'Avete la sauna?' }],
      inviaEmail: async (e) => email.push(e),
      destinatario: 'gestore@example.com',
      now: () => new Date('2026-11-22T06:30:00Z'),
    });
    assert.equal(await report.controlla(), true);
    assert.equal(email.length, 1);
    assert.equal(email[0].to, 'gestore@example.com');
    assert.match(email[0].subject, /1 chiamate, 1 senza risposta/);
    assert.match(email[0].text, /Avete la sauna\?/);
    assert.match(email[0].text, /archivio delle conversazioni è spento/);
    // Stesso giorno: nessun doppione.
    assert.equal(await report.controlla(), false);
    assert.equal(email.length, 1);
  });

  test('senza archivio, nel pomeriggio (es. dopo un deploy) non rimanda il report', async () => {
    const email = [];
    const report = creaReportGiornaliero({
      archivio: { attivo: false },
      inviaEmail: async (e) => email.push(e),
      destinatario: 'gestore@example.com',
      now: () => new Date('2026-11-22T12:30:00Z'), // 13:30 a Roma
    });
    assert.equal(await report.controlla(), false);
    assert.equal(email.length, 0);
  });

  test('prima dell\'ora indicata non parte nulla', async () => {
    const email = [];
    const report = creaReportGiornaliero({
      inviaEmail: async (e) => email.push(e),
      destinatario: 'gestore@example.com',
      now: () => new Date('2026-11-22T05:30:00Z'), // 06:30 a Roma
    });
    assert.equal(await report.controlla(), false);
    assert.equal(email.length, 0);
  });

  test('con archivio: se il giorno è già segnato non rimanda', async () => {
    const email = [];
    const archivio = { attivo: true, reportGiaInviato: async () => true, segnaReport: async () => true };
    const report = creaReportGiornaliero({
      archivio,
      inviaEmail: async (e) => email.push(e),
      destinatario: 'gestore@example.com',
      now: () => new Date('2026-11-22T07:00:00Z'),
    });
    assert.equal(await report.controlla(), false);
    assert.equal(email.length, 0);
  });

  test('senza email configurata il report è spento', async () => {
    const report = creaReportGiornaliero({ destinatario: 'gestore@example.com' });
    assert.equal(report.attivo, false);
    assert.equal(await report.controlla(), false);
  });
});
