// Entry point del voicebot telefonico Nazareth.
require('dotenv').config();

const express = require('express');
const twilio = require('twilio');
const { formatInTimeZone } = require('date-fns-tz');

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
// Da disattivare solo in locale, per provare gli endpoint con curl.
const VALIDATE_SIGNATURE = process.env.TWILIO_VALIDATE_SIGNATURE !== 'false';
// URL pubblico con cui il webhook è configurato su Twilio (es. https://voicebot.example.com).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

const INTRO = {
  chiusa: 'Benvenuto al Nazareth Residence. Al momento la reception è chiusa. Sono un assistente virtuale, come posso aiutarla?',
  occupata: 'Benvenuto al Nazareth Residence. Al momento la reception non è disponibile. Sono un assistente virtuale, come posso aiutarla?',
};

// Esiti di <Dial> per cui la reception non ha risposto.
const DIAL_NON_RIUSCITO = new Set(['busy', 'no-answer', 'failed']);

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

// Reception chiusa dalle 20:00 alle 07:00, estremi inclusi (ora di Roma).
function isReceptionChiusa(date = new Date()) {
  const [ore, minuti] = formatInTimeZone(date, TIMEZONE, 'HH:mm').split(':').map(Number);
  const minutiDelGiorno = ore * 60 + minuti;
  return minutiDelGiorno >= 20 * 60 || minutiDelGiorno <= 7 * 60;
}

function say(response, testo) {
  response.say({ voice: TTS_VOICE, language: LANGUAGE }, testo);
}

function sendTwiml(res, response) {
  res.type('text/xml').send(response.toString());
}

// Assistente virtuale: messaggio, ascolto della richiesta e gestione del silenzio.
function rispondiConAssistente(response, motivo, tentativo) {
  if (tentativo === 1) {
    say(response, INTRO[motivo]);
  } else {
    say(response, 'Mi scusi, non ho sentito. Come posso aiutarla?');
  }

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

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/voice', twilioWebhook, (req, res) => {
  const response = new twiml.VoiceResponse();

  if (isReceptionChiusa()) {
    rispondiConAssistente(response, 'chiusa', 1);
  } else {
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

  if (DIAL_NON_RIUSCITO.has(req.body.DialCallStatus)) {
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

  rispondiConAssistente(response, motivo, tentativo);
  sendTwiml(res, response);
});

// TODO: elaborare req.body.SpeechResult con Claude (src/claude.js).
// Placeholder per non far cadere la chiamata con un errore 404.
app.post('/handle-speech', twilioWebhook, (req, res) => {
  const response = new twiml.VoiceResponse();
  say(
    response,
    'Grazie, ho ricevuto la sua richiesta. Il servizio è in fase di attivazione, la invitiamo a richiamare più tardi. Arrivederci.'
  );
  response.hangup();
  sendTwiml(res, response);
});

if (require.main === module) {
  if (VALIDATE_SIGNATURE && !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('TWILIO_AUTH_TOKEN non impostato: le richieste Twilio verranno rifiutate.');
  }
  app.listen(PORT, () => {
    console.log(`nazareth-voicebot in ascolto sulla porta ${PORT}`);
  });
}

module.exports = { app, isReceptionChiusa };
