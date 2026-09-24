// Entry point del voicebot telefonico Nazareth.
require('dotenv').config();

const express = require('express');
const { twiml } = require('twilio');
const { formatInTimeZone } = require('date-fns-tz');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
// Numero della reception in formato E.164 (+39 0761 156 4612).
const RECEPTION_PHONE_NUMBER = process.env.RECEPTION_PHONE_NUMBER || '+3907611564612';
const LANGUAGE = 'it-IT';
// Tentativi di ascolto prima di chiudere la chiamata se il chiamante non parla.
const MAX_TENTATIVI = 2;

// Twilio invia i parametri dei webhook come application/x-www-form-urlencoded.
app.use(express.urlencoded({ extended: false }));

// Reception chiusa dalle 20:00 alle 07:00, estremi inclusi (ora di Roma).
function isReceptionChiusa(date = new Date()) {
  const [ore, minuti] = formatInTimeZone(date, TIMEZONE, 'HH:mm').split(':').map(Number);
  const minutiDelGiorno = ore * 60 + minuti;
  return minutiDelGiorno >= 20 * 60 || minutiDelGiorno <= 7 * 60;
}

app.post('/voice', (req, res) => {
  const response = new twiml.VoiceResponse();

  if (!isReceptionChiusa()) {
    response.dial(RECEPTION_PHONE_NUMBER);
    return res.type('text/xml').send(response.toString());
  }

  const tentativo = Number.parseInt(req.query.tentativo, 10) || 1;

  if (tentativo === 1) {
    response.say(
      { language: LANGUAGE },
      'Benvenuto al Nazareth Residence. Al momento la reception è chiusa. Sono un assistente virtuale, come posso aiutarla?'
    );
  } else {
    response.say({ language: LANGUAGE }, 'Mi scusi, non ho sentito. Come posso aiutarla?');
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
    response.redirect({ method: 'POST' }, `/voice?tentativo=${tentativo + 1}`);
  } else {
    response.say(
      { language: LANGUAGE },
      'Non ho ricevuto risposta. La invitiamo a richiamare più tardi. Arrivederci.'
    );
    response.hangup();
  }

  res.type('text/xml').send(response.toString());
});

// TODO: elaborare req.body.SpeechResult con Claude (src/claude.js).
// Placeholder per non far cadere la chiamata con un errore 404.
app.post('/handle-speech', (req, res) => {
  const response = new twiml.VoiceResponse();
  response.say(
    { language: LANGUAGE },
    'Grazie, ho ricevuto la sua richiesta. Il servizio è in fase di attivazione, la invitiamo a richiamare durante l\'orario di apertura della reception. Arrivederci.'
  );
  response.hangup();
  res.type('text/xml').send(response.toString());
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`nazareth-voicebot in ascolto sulla porta ${PORT}`);
  });
}

module.exports = { app, isReceptionChiusa };
