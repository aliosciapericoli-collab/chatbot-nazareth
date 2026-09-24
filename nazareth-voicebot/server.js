// Entry point del voicebot telefonico Nazareth.
// Collega il centralino (logica, indipendente dal provider) all'adattatore del provider scelto.
require('dotenv').config();

const express = require('express');
const { creaAssistente } = require('./src/claude');
const { creaConversationStore } = require('./src/conversation-store');
const { creaCentralino, logPredefinito } = require('./src/centralino/centralino');
const { isReceptionChiusa, RECEPTION_MODE } = require('./src/centralino/orario');
const { MESSAGGIO_RIPIEGO } = require('./src/centralino/messaggi');
const { creaProvider } = require('./src/provider');
const { creaMetriche } = require('./src/dashboard/metriche');
const { creaRegistroTwilio } = require('./src/dashboard/registro-twilio');
const { creaDashboard } = require('./src/dashboard');
const { creaNotificatoreRichiamata } = require('./src/notifiche/email-richiamata');

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
  metriche = creaMetriche(),
  registroTwilio = creaRegistroTwilio({
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
  }),
  dashboardPassword = process.env.DASHBOARD_PASSWORD,
  // Trasporto email sostituibile nei test; di default SMTP dalle variabili d'ambiente.
  trasportoEmail,
} = {}) {
  // Ogni evento va nei log e nelle metriche della dashboard.
  const log = (chiamataId, evento, dettagli) => {
    logPredefinito(chiamataId, evento, dettagli);
    metriche.registra(chiamataId, evento, dettagli);
  };

  const notificatore = creaNotificatoreRichiamata({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
    to: process.env.CALLBACK_EMAIL_TO,
    from: process.env.CALLBACK_EMAIL_FROM,
    transport: trasportoEmail,
    log,
  });

  const inoltroReception = process.env.RECEPTION_FORWARD !== 'false';
  const maxTurni = Number.parseInt(process.env.CONVERSATION_MAX_TURNS, 10) || 10;

  const centralino = creaCentralino({
    assistente,
    conversazioni,
    limiteRispostaMs,
    // Numero della reception in formato E.164 (+39 0761 156 4612).
    numeroReception: process.env.RECEPTION_PHONE_NUMBER || '+3907611564612',
    // Secondi di squillo verso la reception prima di passare all'assistente virtuale.
    squilloSec: Number.parseInt(process.env.RECEPTION_DIAL_TIMEOUT, 10) || 20,
    // false se la reception viene già fatta squillare prima (es. Asterisk con Messagenet).
    inoltroReception,
    // Domande massime per chiamata, per limitare durata e costi.
    maxTurni,
    notificaRichiamata: notificatore.invia,
    richiamataDisponibile: notificatore.configurato,
    // Numeri della struttura: se il trasferimento li presenta come chiamante, non vanno proposti.
    numeriEsclusi: [process.env.RECEPTION_PHONE_NUMBER || '+3907611564612', process.env.TWILIO_PHONE_NUMBER].filter(Boolean),
    log,
  });

  const app = express();

  // Dietro un proxy (Render, Railway, ecc.) serve per ricostruire l'URL https usato
  // nella verifica della firma del provider.
  app.set('trust proxy', true);

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', provider: provider.nome });
  });

  app.use(creaDashboard({
    password: dashboardPassword,
    metriche,
    registroTwilio,
    configurazione: () => ({
      provider: provider.nome,
      modello: assistente.model ?? null,
      receptionAdesso: isReceptionChiusa() ? 'chiusa' : 'aperta',
      receptionMode: RECEPTION_MODE,
      inoltroReception,
      timeoutClaudeMs: Number.parseInt(process.env.CLAUDE_TIMEOUT_MS, 10) || 8000,
      maxTurni,
      voce: process.env.TTS_VOICE || 'Polly.Bianca-Neural',
      emailRichiamata: notificatore.configurato ? process.env.CALLBACK_EMAIL_TO || 'info@nazarethresidence.com' : null,
      versione: process.env.RENDER_GIT_COMMIT?.slice(0, 7) ?? null,
    }),
  }));

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
  if (!process.env.SMTP_HOST) {
    console.warn('SMTP_HOST non impostato: il bot non offre la richiamata finché l\'email non è configurata.');
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ANTHROPIC_API_KEY non impostata: l\'assistente risponderà solo con il messaggio di ripiego.');
  }
  createApp({ provider }).listen(PORT, () => {
    console.log(`nazareth-voicebot in ascolto sulla porta ${PORT} (provider: ${provider.nome})`);
  });
}

module.exports = { createApp, isReceptionChiusa, MESSAGGIO_RIPIEGO };
