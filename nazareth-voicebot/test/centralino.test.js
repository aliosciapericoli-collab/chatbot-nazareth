// Test del centralino senza HTTP e senza provider: solo eventi neutri e azioni neutre.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const { creaCentralino } = require('../src/centralino/centralino');
const { verificaAzioni } = require('../src/centralino/protocollo');
const { creaConversationStore } = require('../src/conversation-store');
const { MESSAGGIO_RIPIEGO, MESSAGGIO_NESSUNA_RISPOSTA, INTRO } = require('../src/centralino/messaggi');
const { creaProviderTwilio } = require('../src/provider/twilio');

function creaTest({ chiusa = true, inoltroReception = true, rispondi = async () => ({ testo: 'Risposta.', fine: false }) } = {}) {
  const log = [];
  const conversazioni = creaConversationStore();
  const centralino = creaCentralino({
    assistente: { rispondi },
    conversazioni,
    numeroReception: '+3907611564612',
    squilloSec: 20,
    inoltroReception,
    limiteRispostaMs: 100,
    isReceptionChiusa: () => chiusa,
    log: (...args) => log.push(args),
  });
  const gestisci = async (evento) => verificaAzioni(await centralino.gestisci(evento));
  return { gestisci, conversazioni, log };
}

describe('centralino', () => {
  test('reception aperta: inoltro alla reception', async () => {
    const { gestisci } = creaTest({ chiusa: false });
    assert.deepEqual(await gestisci({ tipo: 'chiamata_in_arrivo', chiamataId: 'C1' }), [
      { tipo: 'inoltra', numero: '+3907611564612', squilloSec: 20 },
    ]);
  });

  test('inoltro disattivato (reception già provata a monte): risponde subito l\'assistente', async () => {
    const aperta = creaTest({ chiusa: false, inoltroReception: false });
    const azioni = await aperta.gestisci({ tipo: 'chiamata_in_arrivo', chiamataId: 'C1' });
    assert.equal(azioni[0].testo, INTRO.occupata);
    assert.equal(azioni[1].tipo, 'ascolta');
    assert.ok(!azioni.some((a) => a.tipo === 'inoltra'));

    const chiusa = creaTest({ chiusa: true, inoltroReception: false });
    assert.equal((await chiusa.gestisci({ tipo: 'chiamata_in_arrivo', chiamataId: 'C2' }))[0].testo, INTRO.chiusa);
  });

  test('reception chiusa: accoglienza e ascolto', async () => {
    const { gestisci } = creaTest();
    assert.deepEqual(await gestisci({ tipo: 'chiamata_in_arrivo', chiamataId: 'C1' }), [
      { tipo: 'parla', testo: INTRO.chiusa, lingua: 'it-IT' },
      { tipo: 'ascolta', lingua: 'it-IT', contesto: { motivo: 'chiusa', tentativo: 1 } },
    ]);
  });

  test('esiti dell\'inoltro', async () => {
    const { gestisci } = creaTest({ chiusa: false });
    for (const esito of ['occupato', 'nessuna_risposta', 'fallito']) {
      const azioni = await gestisci({ tipo: 'esito_inoltro', chiamataId: 'C1', esito });
      assert.equal(azioni[0].testo, INTRO.occupata, esito);
      assert.equal(azioni[1].tipo, 'ascolta');
    }
    for (const esito of ['risposto', 'annullato']) {
      assert.deepEqual(await gestisci({ tipo: 'esito_inoltro', chiamataId: 'C1', esito }), [{ tipo: 'riaggancia' }]);
    }
  });

  test('silenzio: una nuova richiesta, poi saluto e chiusura', async () => {
    const { gestisci } = creaTest();
    const primo = await gestisci({ tipo: 'silenzio', chiamataId: 'C1', contesto: { motivo: 'chiusa', tentativo: 1 } });
    assert.equal(primo[0].testo, 'Mi scusi, non ho sentito. Come posso aiutarla?');
    assert.deepEqual(primo[1].contesto, { motivo: 'chiusa', tentativo: 2 });

    const secondo = await gestisci({ tipo: 'silenzio', chiamataId: 'C1', contesto: { motivo: 'chiusa', tentativo: 2 } });
    assert.deepEqual(secondo, [
      { tipo: 'parla', testo: MESSAGGIO_NESSUNA_RISPOSTA, lingua: 'it-IT' },
      { tipo: 'riaggancia' },
    ]);
  });

  test('contesto di silenzio manomesso: valori normalizzati', async () => {
    const { gestisci } = creaTest();
    const azioni = await gestisci({ tipo: 'silenzio', chiamataId: 'C1', contesto: { motivo: '<script>', tentativo: 'x' } });
    assert.deepEqual(azioni[1].contesto, { motivo: 'chiusa', tentativo: 2 });
  });

  test('parlato: risposta, storico salvato e nuovo ascolto', async () => {
    const { gestisci, conversazioni } = creaTest();
    const azioni = await gestisci({ tipo: 'parlato', chiamataId: 'C1', testo: ' Avete il parcheggio? ' });
    assert.deepEqual(azioni, [
      { tipo: 'parla', testo: 'Risposta.', lingua: 'it-IT' },
      { tipo: 'ascolta', lingua: 'it-IT', contesto: { motivo: 'continua', tentativo: 1 } },
    ]);
    assert.deepEqual(conversazioni.storico('C1'), [
      { role: 'user', content: 'Avete il parcheggio?' },
      { role: 'assistant', content: 'Risposta.' },
    ]);
  });

  test('assistente bloccato o evento sconosciuto: ripiego, mai un errore', async () => {
    const bloccato = creaTest({ rispondi: () => new Promise(() => {}) });
    assert.equal((await bloccato.gestisci({ tipo: 'parlato', chiamataId: 'C1', testo: 'ciao' }))[0].testo, MESSAGGIO_RIPIEGO);

    const { gestisci } = creaTest();
    assert.equal((await gestisci({ tipo: 'boh', chiamataId: 'C1' }))[0].testo, MESSAGGIO_RIPIEGO);
    assert.equal((await gestisci(undefined))[0].testo, MESSAGGIO_RIPIEGO);
  });
});

describe('adattatore Twilio', () => {
  const { renderizza } = creaProviderTwilio({ voce: 'Polly.Bianca-Neural' });

  test('traduce ogni azione in TwiML', () => {
    assert.equal(
      renderizza([{ tipo: 'parla', testo: 'Ciao', lingua: 'it-IT' }, { tipo: 'ascolta', lingua: 'it-IT', contesto: { motivo: 'chiusa', tentativo: 1 } }]),
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Bianca-Neural" language="it-IT">Ciao</Say>' +
        '<Gather input="speech" language="it-IT" speechTimeout="auto" action="/handle-speech" method="POST"/>' +
        '<Redirect method="POST">/assistente?motivo=chiusa&amp;tentativo=1</Redirect></Response>'
    );
    assert.match(renderizza([{ tipo: 'inoltra', numero: '+3907611564612', squilloSec: 20 }]),
      /<Dial action="\/dial-status" method="POST" timeout="20">\+3907611564612<\/Dial>/);
    assert.match(renderizza([{ tipo: 'riaggancia' }]), /<Response><Hangup\/><\/Response>/);
  });
});

describe('indipendenza dal provider', () => {
  test('lo stesso centralino funziona con un adattatore diverso', async () => {
    // Adattatore minimo di prova (formato JSON inventato): nessuna modifica al centralino.
    const adattatoreJson = (lista) => JSON.stringify(lista.map((a) => ({ verbo: a.tipo, ...a })));
    const { gestisci } = creaTest();
    const uscita = JSON.parse(adattatoreJson(await gestisci({ tipo: 'chiamata_in_arrivo', chiamataId: 'X1' })));
    assert.deepEqual(uscita.map((a) => a.verbo), ['parla', 'ascolta']);
  });
});
