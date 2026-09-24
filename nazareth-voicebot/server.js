// Entry point del voicebot telefonico Nazareth.
// Collega il centralino (logica, indipendente dal provider) all'adattatore del provider scelto.
require('dotenv').config();

const express = require('express');
const { creaAssistente } = require('./src/claude');
const { creaConversationStore } = require('./src/conversation-store');
const { creaCentralino } = require('./src/centralino/centralino');
const { isReceptionChiusa, RECEPTION_MODE } = require('./src/centralino/orario');
const { MESSAGGIO_RIPIEGO } = require('./src/centralino/messaggi');
const { creaProvider } = require('./src/provider');

const PORT = process.env.PORT || 3000;

// Ultima difesa oltre al timeout interno di src/claude.js: la risposta al provider deve
// partire comunque prima dei suoi limiti (15 secondi per Twilio).
const LIMITE_RISPOSTA_MS = (Number.parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 8000) + 1000;

/**
 * Crea l'app Express. Le dipendenze si possono sostituire nei test.
 */
function createApp({
  assistente = creaAssistente(),
  conversazioni = creaConversationStore(),
  limiteRispostaMs = LIMITE_RISPOSTA_MS,
  provider = creaProvider(),
} = {}) {
  const centralino = creaCentralino({
    assistente,
    conversazioni,
    limiteRispostaMs,
    // Numero della reception in formato E.164 (+39 0761 156 4612).
    numeroReception: process.env.RECEPTION_PHONE_NUMBER || '+3907611564612',
    // Secondi di squillo verso la reception prima di passare all'assistente virtuale.
    squilloSec: Number.parseInt(process.env.RECEPTION_DIAL_TIMEOUT, 10) || 20,
    // false se la reception viene già fatta squillare prima (es. Asterisk con Messagenet).
    inoltroReception: process.env.RECEPTION_FORWARD !== 'false',
    // Domande massime per chiamata, per limitare durata e costi.
    maxTurni: Number.parseInt(process.env.CONVERSATION_MAX_TURNS, 10) || 10,
  });

  const app = express();

  // Dietro un proxy (Render, Railway, ecc.) serve per ricostruire l'URL https usato
  // nella verifica della firma del provider.
  app.set('trust proxy', true);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', provider: provider.nome });
  });

  app.use(provider.router(centralino));

  return app;
}

if (require.main === module) {
  const provider = creaProvider();
  if (provider.nome === 'twilio' && process.env.TWILIO_VALIDATE_SIGNATURE !== 'false' && !process.env.TWILIO_AUTH_TOKEN) {
    console.warn('TWILIO_AUTH_TOKEN non impostato: le richieste Twilio verranno rifiutate.');
  }
  if (RECEPTION_MODE !== 'auto') {
    console.warn(`RECEPTION_MODE=${RECEPTION_MODE}: l'orario della reception viene ignorato.`);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY non impostata: l\'assistente risponderà solo con il messaggio di ripiego.');
  }
  createApp({ provider }).listen(PORT, () => {
    console.log(`nazareth-voicebot in ascolto sulla porta ${PORT} (provider: ${provider.nome})`);
  });
}

module.exports = { createApp, isReceptionChiusa, MESSAGGIO_RIPIEGO };
