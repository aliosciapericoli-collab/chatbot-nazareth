// Simulatore di chiamata da terminale: parla con il centralino senza nessun provider
// telefonico. Usa Claude vero (serve ANTHROPIC_API_KEY nel file .env).
//
//   npm run simula            reception chiusa: risponde l'assistente
//   npm run simula -- --aperta reception aperta: prova l'inoltro
//   npm run simula -- --da +393331234567   numero del chiamante (per la richiamata)
//
// Le email di richiamata usano le variabili SMTP del file .env, se presenti.
//
// Scrivi la tua frase e premi Invio; una riga vuota simula il silenzio.
require('dotenv').config();

const readline = require('node:readline/promises');
const { creaAssistente } = require('../src/claude');
const { creaConversationStore } = require('../src/conversation-store');
const { creaCentralino } = require('../src/centralino/centralino');
const { ESITI_INOLTRO } = require('../src/centralino/protocollo');
const { creaNotificatoreRichiamata } = require('../src/notifiche/email-richiamata');

async function main() {
  const aperta = process.argv.includes('--aperta');
  const indiceDa = process.argv.indexOf('--da');
  const numeroChiamante = indiceDa === -1 ? null : process.argv[indiceDa + 1];
  const logEmail = (id, evento, dettagli = {}) => console.log(`[${evento}${dettagli.motivo ? `: ${dettagli.motivo}` : ''}]`);
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let finita = false;
  rl.on('close', () => {
    if (!finita) console.log('\n[simulazione interrotta]');
    process.exit(0);
  });
  const centralino = creaCentralino({
    assistente: creaAssistente(),
    conversazioni: creaConversationStore(),
    numeroReception: process.env.RECEPTION_PHONE_NUMBER || '+3907611564612',
    isReceptionChiusa: () => !aperta,
    numeriEsclusi: [process.env.RECEPTION_PHONE_NUMBER || '+3907611564612'],
    // In simulazione la richiamata si prova anche senza SMTP: l'esito dell'invio compare a video.
    richiamataDisponibile: true,
    notificaRichiamata: creaNotificatoreRichiamata({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      to: process.env.CALLBACK_EMAIL_TO,
      from: process.env.CALLBACK_EMAIL_FROM,
      log: logEmail,
    }).invia,
    log: () => {},
  });

  const chiamataId = `SIM-${Date.now()}`;
  let evento = { tipo: 'chiamata_in_arrivo', chiamataId };
  console.log(`Chiamata simulata ${chiamataId} (reception ${aperta ? 'aperta' : 'chiusa'})\n`);

  for (;;) {
    const azioni = await centralino.gestisci(evento);
    const ultima = azioni.at(-1);
    for (const azione of azioni) {
      if (azione.tipo === 'parla') console.log(`BOT: ${azione.testo}`);
    }

    if (ultima.tipo === 'riaggancia') {
      console.log('\n[chiamata chiusa]');
      finita = true;
      break;
    }
    if (ultima.tipo === 'inoltra') {
      console.log(`[inoltro a ${ultima.numero}, squillo ${ultima.squilloSec} s]`);
      let esito;
      do {
        esito = (await rl.question(`Esito (${ESITI_INOLTRO.join(', ')}): `)).trim();
      } while (!ESITI_INOLTRO.includes(esito));
      evento = { tipo: 'esito_inoltro', chiamataId, esito };
      continue;
    }

    const frase = (await rl.question('TU> ')).trim();
    evento = frase
      ? { tipo: 'parlato', chiamataId, testo: frase, numeroChiamante }
      : { tipo: 'silenzio', chiamataId, contesto: ultima.contesto };
  }

  rl.close();
}

main();
