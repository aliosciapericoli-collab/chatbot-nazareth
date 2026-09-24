// Entry point del voicebot telefonico Nazareth.
// TODO: configurare Express, montare le route Twilio (src/twilio-handler.js) e avviare il server.
require('dotenv').config();

const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// TODO: middleware (urlencoded per i webhook Twilio) e route.

app.listen(PORT, () => {
  console.log(`nazareth-voicebot in ascolto sulla porta ${PORT}`);
});
