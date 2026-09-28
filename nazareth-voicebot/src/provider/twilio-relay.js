// Voce in streaming con Twilio ConversationRelay (VOICE_STREAMING=true).
// Twilio trascrive e legge la voce; il server riceve le frasi del cliente su un WebSocket
// e risponde con il testo, che Twilio comincia a leggere subito. Così spariscono i passaggi
// webhook → TwiML → sintesi completa di ogni turno.
//
// La logica resta nel centralino: questo file traduce il protocollo WebSocket in eventi
// (parlato, silenzio, prosegui) e le azioni in messaggi. Congedi e inoltri non passano dal
// WebSocket: la sessione si chiude con "end" e il resto lo legge il webhook di fine sessione,
// così la frase di saluto non viene mai tagliata.
// https://www.twilio.com/docs/voice/twiml/connect/conversationrelay
// https://www.twilio.com/docs/voice/conversationrelay/websocket-messages
const crypto = require('node:crypto');
const twilio = require('twilio');
const { WebSocketServer } = require('ws');

const PERCORSO_WS = '/relay';
const PERCORSO_FINE = '/relay-fine';
const VALIDITA_GETTONE_MS = 2 * 60 * 1000;
const ATTESA_SETUP_MS = 10000;

// Gettone monouso legato alla chiamata: entra nel TwiML (risposta a un webhook firmato da
// Twilio) e torna nel messaggio "setup". Senza gettone valido la connessione si chiude.
function creaGettone(segreto, callSid, adesso = Date.now()) {
  const scade = adesso + VALIDITA_GETTONE_MS;
  const firma = crypto.createHmac('sha256', segreto).update(`${callSid}.${scade}`).digest('base64url');
  return `${scade}.${firma}`;
}

function gettoneValido(segreto, callSid, gettone, adesso = Date.now()) {
  if (typeof gettone !== 'string' || !callSid) return false;
  const [scade, firma] = gettone.split('.');
  if (!scade || !firma || Number(scade) < adesso) return false;
  const attesa = crypto.createHmac('sha256', segreto).update(`${callSid}.${scade}`).digest();
  const ricevuta = Buffer.from(firma, 'base64url');
  return ricevuta.length === attesa.length && crypto.timingSafeEqual(ricevuta, attesa);
}

// TTS_VOICE è nel formato di <Say> ("Google.it-IT-Chirp3-HD-Aoede", "Polly.Bianca-Neural"):
// ConversationRelay vuole provider e voce separati.
function voceRelay(ttsVoice) {
  const [prefisso, ...resto] = String(ttsVoice || '').split('.');
  const provider = { Google: 'Google', Polly: 'Amazon' }[prefisso];
  return provider && resto.length ? { ttsProvider: provider, voice: resto.join('.') } : {};
}

/**
 * TwiML che apre la sessione ConversationRelay, con il benvenuto letto da Twilio.
 * @param {object} opzioni
 */
function twimlRelay({ wssUrl, benvenuto, gettone, lingua, config }) {
  const response = new twilio.twiml.VoiceResponse();
  const connect = response.connect({ action: PERCORSO_FINE, method: 'POST' });
  const attributi = {
    url: wssUrl,
    language: lingua,
    transcriptionProvider: config.transcriptionProvider || 'Google',
    // Il benvenuto contiene la dichiarazione di assistente virtuale: si ascolta per intero.
    welcomeGreetingInterruptible: 'none',
    interruptible: 'speech',
    ...(config.ttsProvider ? { ttsProvider: config.ttsProvider } : {}),
    ...(config.voice ? { voice: config.voice } : {}),
  };
  if (benvenuto) attributi.welcomeGreeting = benvenuto;
  const relay = connect.conversationRelay(attributi);
  relay.parameter({ name: 'gettone', value: gettone });
  return response.toString();
}

/**
 * Server WebSocket della sessione. Una coda per chiamata tiene in ordine gli eventi.
 * @param {object} opzioni
 * @param {() => { gestisci(evento: object): Promise<object[]> }} opzioni.centralino
 * @param {string} opzioni.segreto        TWILIO_AUTH_TOKEN
 * @param {number} [opzioni.silenzioMs]    attesa dopo la risposta prima di "è ancora in linea?"
 * @param {(evento: string, dettagli?: object) => void} [opzioni.log]
 */
function creaServerRelay({ centralino, segreto, silenzioMs = 10000, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const usati = new Map(); // gettone → scadenza, per l'uso singolo

  function giàUsato(gettone) {
    const adesso = Date.now();
    for (const [g, scade] of usati) if (scade < adesso) usati.delete(g);
    if (usati.has(gettone)) return true;
    usati.set(gettone, adesso + VALIDITA_GETTONE_MS);
    return false;
  }

  wss.on('connection', (ws) => {
    let chiamata = null; // { chiamataId, numeroChiamante, numeroChiamato }
    let coda = Promise.resolve();
    let timerSilenzio = null;
    let chiusa = false;

    const invia = (messaggio) => {
      if (!chiusa && ws.readyState === ws.OPEN) ws.send(JSON.stringify(messaggio));
    };
    const fermaSilenzio = () => {
      clearTimeout(timerSilenzio);
      timerSilenzio = null;
    };
    const attesaSetup = setTimeout(() => ws.close(1008, 'setup mancante'), ATTESA_SETUP_MS);

    const evento = (dati) => ({ ...dati, ...chiamata });

    // Esegue le azioni del centralino sulla sessione.
    async function esegui(azioni) {
      // Congedo o inoltro: tutto passa al webhook di fine sessione, frase compresa.
      if (azioni.some((a) => a.tipo === 'riaggancia' || a.tipo === 'inoltra')) {
        fermaSilenzio();
        invia({ type: 'end', handoffData: JSON.stringify({ azioni }) });
        chiusa = true;
        return;
      }
      let detto = '';
      for (const azione of azioni) {
        if (azione.tipo === 'parla') {
          invia({ type: 'text', token: azione.testo, last: true });
          detto += azione.testo;
        } else if (azione.tipo === 'ascolta') {
          // Se il cliente non dice nulla, dopo la risposta arriva il silenzio del centralino.
          // Il tempo tiene conto della frase ancora da leggere (circa 60 ms a carattere).
          fermaSilenzio();
          const contesto = azione.contesto;
          timerSilenzio = setTimeout(() => {
            accoda(() => centralino().gestisci(evento({ tipo: 'silenzio', contesto })));
          }, silenzioMs + detto.length * 60);
          timerSilenzio.unref?.();
        } else if (azione.tipo === 'prosegui') {
          // Verifica in corso: il WebSocket non ha il limite dei 15 secondi, si aspetta qui.
          const seguito = await centralino().gestisci(evento({ tipo: 'prosegui', contesto: azione.contesto ?? {} }));
          await esegui(seguito);
          return;
        }
      }
    }

    function accoda(produci) {
      coda = coda
        .then(async () => {
          if (chiusa) return;
          await esegui(await produci());
        })
        .catch((error) => log('relay_errore', { chiamataId: chiamata?.chiamataId, tipo: error.name }));
    }

    ws.on('message', (dati) => {
      let msg;
      try {
        msg = JSON.parse(dati);
      } catch {
        return;
      }
      if (!chiamata) {
        clearTimeout(attesaSetup);
        const callSid = msg.callSid;
        const gettone = msg.customParameters?.gettone;
        if (msg.type !== 'setup' || !gettoneValido(segreto, callSid, gettone) || giàUsato(gettone)) {
          log('relay_rifiutato', { motivo: msg.type !== 'setup' ? 'senza_setup' : 'gettone' });
          chiusa = true;
          ws.close(1008, 'non autorizzato');
          return;
        }
        chiamata = { chiamataId: callSid, numeroChiamante: msg.from || null, numeroChiamato: msg.to || null };
        log('relay_aperto', { chiamataId: callSid });
        return;
      }
      switch (msg.type) {
        case 'prompt':
          if (msg.last === false) return;
          fermaSilenzio();
          accoda(() => centralino().gestisci(evento({ tipo: 'parlato', testo: msg.voicePrompt || '' })));
          break;
        case 'interrupt':
          // Il cliente parla sopra la risposta: si ascolta, nessun silenzio da contare.
          fermaSilenzio();
          break;
        case 'error':
          log('relay_errore', { chiamataId: chiamata.chiamataId, descrizione: String(msg.description ?? '').slice(0, 200) });
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      chiusa = true;
      fermaSilenzio();
      clearTimeout(attesaSetup);
    });
    ws.on('error', () => {});
  });

  /** Aggancia il WebSocket al server HTTP: solo il percorso /relay. */
  function collega(server) {
    server.on('upgrade', (req, socket, head) => {
      const percorso = new URL(req.url, 'http://x').pathname;
      if (percorso !== PERCORSO_WS) return;
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });
  }

  return { collega, chiudi: () => wss.close() };
}

module.exports = {
  creaGettone,
  gettoneValido,
  voceRelay,
  twimlRelay,
  creaServerRelay,
  PERCORSO_WS,
  PERCORSO_FINE,
};
