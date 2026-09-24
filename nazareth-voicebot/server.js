// Entry point del voicebot telefonico Nazareth.
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { formatInTimeZone } = require('date-fns-tz');
const { creaAssistente } = require('./src/claude');
const { creaConversationStore } = require('./src/conversation-store');

const { twiml } = twilio;

const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
// Numero della reception in formato E.164 (+39 0761 156 4612).
const RECEPTION_PHONE_NUMBER = process.env.RECEPTION_PHONE_NUMBER || '+3907611564612';
// Secondi di squillo verso la reception prima di passare all'assistente virtuale.
const RECEPTION_DIAL_TIMEOUT = Number.parseInt(process.env.RECEPTION_DIAL_TIMEOUT, 10) || 20;
// Voci it-IT disponibili: https://www.twilio.com/docs/voice/twiml/say/text-speech
const TTS_VOICE = process.env.TTS_VOICE || 'Polly.Bianca-Neural';
const LANGUAGE = 'it-IT';
// Tentativi di ascolto prima di chiudere la chiamata se il chiamante non parla.
const MAX_TENTATIVI = 2;
// Domande massime per chiamata, per limitare durata e costi.
const MAX_TURNI = Number.parseInt(process.env.CONVERSATION_MAX_TURNS, 10) || 10;
// Solo per i test: 'chiusa' o 'aperta' forzano la modalità, 'auto' (default) segue l'orario.
const RECEPTION_MODE = process.env.RECEPTION_MODE || 'auto';
// Da disattivare solo in locale, per provare gli endpoint con curl.
const VALIDATE_SIGNATURE = process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';
// URL pubblico con cui il webhook è configurato su Twilio (es. https://voicebot.example.com).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

// Prima frase: dichiarazione che risponde un assistente virtuale (art. 50 AI Act),
// poi avviso della trascrizione automatica del parlato.
const AVVISO_TRASCRIZIONE = 'Le sue parole vengono trascritte automaticamente per poterle rispondere.';
const INTRO = {
  chiusa: `Benvenuto al Nazareth Residence, sono l'assistente virtuale. Al momento la reception è chiusa. ${AVVISO_TRASCRIZIONE} Come posso aiutarla?`,
  occupata: `Benvenuto al Nazareth Residence, sono l'assistente virtuale. Al momento la reception non è disponibile. ${AVVISO_TRASCRIZIONE} Come posso aiutarla?`,
  continua: 'Come posso aiutarla?',
};

const RICHIESTA_DOPO_SILENZIO = {
  chiusa: 'Mi scusi, non ho sentito. Come posso aiutarla?',
  occupata: 'Mi scusi, non ho sentito. Come posso aiutarla?',
  continua: 'È ancora in linea? Posso esserle utile in altro?',
};

const CONTATTI_PARLATI =
  'Può scriverci su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre, oppure all\'email info chiocciola nazarethresidence punto com.';

const MESSAGGIO_RIPIEGO = `Mi scusi, in questo momento non riesco a rispondere. ${CONTATTI_PARLATI} Grazie per aver chiamato, arrivederci.`;

const MESSAGGIO_LIMITE_TURNI = `Per ulteriori informazioni ${CONTATTI_PARLATI} Grazie per aver chiamato, arrivederci.`;

// Esiti di <Dial> per cui la reception non ha risposto.
const DIAL_NON_RIUSCITO = new Set(['busy', 'no-answer', 'failed']);

// Reception chiusa dalle 20:00 alle 07:00, estremi inclusi (ora di Roma).
function isReceptionChiusa(date = new Date(), modalita = RECEPTION_MODE) {
  if (modalita === 'chiusa') return true;
  if (modalita === 'aperta') return false;
  const [ore, minuti] = formatInTimeZone(date, TIMEZONE, 'HH:mm').split(':').map(Number);
  const minutiDelGiorno = ore * 60 + minuti;
  return minutiDelGiorno >= 20 * 60 || minutiDelGiorno <= 7 * 60;
}

// Log minimale: solo CallSid ed esito tecnico, mai il parlato o il numero del chiamante.
function log(callSid, evento, dettagli = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), callSid, evento, ...dettagli }));
}

function say(response, testo) {
  response.say({ voice: TTS_VOICE, language: LANGUAGE }, testo);
}

function sendTwiml(res, response) {
  res.type('text/xml').send(response.toString());
}

// Ascolta il chiamante; se resta in silenzio riprova, poi chiude.
function ascolta(response, motivo, tentativo) {
  response.gather({
    input: 'speech',
    language: LANGUAGE,
    speechTimeout: 'auto',
    action: '/handle-speech',
    method: 'POST',
  });

  // Raggiunto solo se il Gather termina senza input vocale.
  if (tentativo < MAX_TENTATIVI) {
    response.redirect({ method: 'POST' }, `/assistente?motivo=${motivo}&tentativo=${tentativo + 1}`);
  } else {
    say(response, 'Non ho ricevuto risposta. La invitiamo a richiamare più tardi. Arrivederci.');
    response.hangup();
  }
}

// Assistente virtuale: messaggio iniziale (o nuova richiesta dopo un silenzio) e ascolto.
function rispondiConAssistente(response, motivo, tentativo) {
  say(response, tentativo === 1 ? INTRO[motivo] : RICHIESTA_DOPO_SILENZIO[motivo]);
  ascolta(response, motivo, tentativo);
}

/**
 * Crea l'app Express. `assistente` e `conversazioni` si possono sostituire nei test.
 */
function createApp({
  assistente = creaAssistente(),
  conversazioni = creaConversationStore(),
} = {}) {
  const app = express();

  // Dietro un proxy (Render, Railway, ecc.) serve per ricostruire l'URL https usato
  // nella verifica della firma Twilio.
  app.set('trust proxy', true);

  // Twilio invia i parametri dei webhook come application/x-www-form-urlencoded.
  app.use(express.urlencoded({ extended: false }));

  // Verifica che le richieste arrivino davvero da Twilio (header X-Twilio-Signature).
  const webhookOptions = { validate: VALIDATE_SIGNATURE };
  if (PUBLIC_BASE_URL) {
    const url = new URL(PUBLIC_BASE_URL);
    webhookOptions.host = url.host;
    webhookOptions.protocol = url.protocol.replace(':', '');
  }
  const twilioWebhook = twilio.webhook(webhookOptions);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
  });

  app.post('/voice', twilioWebhook, (req, res) => {
    const response = new twiml.VoiceResponse();

    if (isReceptionChiusa()) {
      log(req.body.CallSid, 'assistente', { motivo: 'chiusa' });
      rispondiConAssistente(response, 'chiusa', 1);
    } else {
      log(req.body.CallSid, 'inoltro_reception');
      // Se la reception non risponde, Twilio chiama /dial-status con l'esito.
      response.dial(
        { action: '/dial-status', method: 'POST', timeout: RECEPTION_DIAL_TIMEOUT },
        RECEPTION_PHONE_NUMBER
      );
    }

    sendTwiml(res, response);
  });

  app.post('/dial-status', twilioWebhook, (req, res) => {
    const response = new twiml.VoiceResponse();
    const esito = req.body.DialCallStatus;

    if (DIAL_NON_RIUSCITO.has(esito)) {
      log(req.body.CallSid, 'assistente', { motivo: 'occupata', esito });
      rispondiConAssistente(response, 'occupata', 1);
    } else {
      // Conversazione con la reception conclusa o chiamata annullata.
      response.hangup();
    }

    sendTwiml(res, response);
  });

  app.post('/assistente', twilioWebhook, (req, res) => {
    const response = new twiml.VoiceResponse();
    const motivo = req.query.motivo in INTRO ? req.query.motivo : 'chiusa';
    const tentativo = Math.min(Number.parseInt(req.query.tentativo, 10) || 1, MAX_TENTATIVI);

    log(req.body.CallSid, 'silenzio', { motivo, tentativo });
    rispondiConAssistente(response, motivo, tentativo);
    if (tentativo >= MAX_TENTATIVI) conversazioni.elimina(req.body.CallSid);
    sendTwiml(res, response);
  });

  // Riceve il parlato riconosciuto da Twilio e risponde con Claude.
  app.post('/handle-speech', twilioWebhook, async (req, res) => {
    const response = new twiml.VoiceResponse();
    const callSid = req.body.CallSid;
    const domanda = (req.body.SpeechResult || '').trim();

    if (!domanda) {
      log(callSid, 'parlato_vuoto');
      rispondiConAssistente(response, 'continua', MAX_TENTATIVI);
      return sendTwiml(res, response);
    }

    if (conversazioni.turniUtente(callSid) >= MAX_TURNI) {
      log(callSid, 'limite_turni', { turni: MAX_TURNI });
      say(response, MESSAGGIO_LIMITE_TURNI);
      response.hangup();
      conversazioni.elimina(callSid);
      return sendTwiml(res, response);
    }

    const messages = conversazioni.storico(callSid);
    messages.push({ role: 'user', content: domanda });

    const inizio = Date.now();
    try {
      const { testo, fine } = await assistente.rispondi(messages);
      log(callSid, 'risposta_claude', { ms: Date.now() - inizio, turno: messages.length, fine });

      say(response, testo);
      if (fine) {
        response.hangup();
        conversazioni.elimina(callSid);
      } else {
        messages.push({ role: 'assistant', content: testo });
        conversazioni.salva(callSid, messages);
        ascolta(response, 'continua', 1);
      }
    } catch (error) {
      log(callSid, 'errore_claude', { ms: Date.now() - inizio, tipo: error.name, status: error.status });
      say(response, MESSAGGIO_RIPIEGO);
      response.hangup();
      conversazioni.elimina(callSid);
    }

    sendTwiml(res, response);
  });

  return app;
}

if (require.main === module) {
  if (VALIDATE_SIGNATURE && !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('TWILIO_AUTH_TOKEN non impostato: le richieste Twilio verranno rifiutate.');
  }
  if (RECEPTION_MODE !== 'auto') {
    console.warn(`RECEPTION_MODE=${RECEPTION_MODE}: l'orario della reception viene ignorato.`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY non impostata: l\'assistente risponderà solo con il messaggio di ripiego.');
  }
  createApp().listen(PORT, () => {
    console.log(`nazareth-voicebot in ascolto sulla porta ${PORT}`);
  });
}

module.exports = { createApp, isReceptionChiusa, MESSAGGIO_RIPIEGO };
