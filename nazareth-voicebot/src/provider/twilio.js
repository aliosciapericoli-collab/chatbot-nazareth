// Adattatore Twilio: traduce i webhook Twilio in eventi del centralino e le azioni in TwiML.
// È l'unico file che conosce Twilio; per cambiare provider si scrive un adattatore nuovo.
const express = require('express');
const twilio = require('twilio');

const { twiml } = twilio;

// Percorsi dei webhook: /voice è quello da configurare nella console Twilio.
const PERCORSI = {
  chiamataInArrivo: '/voice',
  esitoInoltro: '/dial-status',
  silenzio: '/assistente',
  parlato: '/handle-speech',
  prosegui: '/prosegui',
};

// DialCallStatus di Twilio → esito neutro.
// https://www.twilio.com/docs/voice/twiml/dial
const ESITI_DIAL = {
  completed: 'risposto',
  answered: 'risposto',
  busy: 'occupato',
  'no-answer': 'nessuna_risposta',
  failed: 'fallito',
  canceled: 'annullato',
};

/**
 * @param {object} opzioni
 * @param {string} opzioni.voce            voce TTS, es. Polly.Bianca-Neural
 * @param {boolean} opzioni.validaFirma    verifica X-Twilio-Signature (true in produzione)
 * @param {string} [opzioni.publicBaseUrl] URL pubblico configurato su Twilio
 * @param {string} [opzioni.authToken]     default: TWILIO_AUTH_TOKEN
 */
function creaProviderTwilio({ voce, validaFirma = true, publicBaseUrl, authToken } = {}) {
  function renderizza(listaAzioni) {
    const response = new twiml.VoiceResponse();

    for (const azione of listaAzioni) {
      switch (azione.tipo) {
        case 'parla':
          response.say({ voice: voce, language: azione.lingua }, azione.testo);
          break;
        case 'ascolta': {
          response.gather({
            input: 'speech',
            language: azione.lingua,
            speechTimeout: 'auto',
            action: PERCORSI.parlato,
            method: 'POST',
          });
          // Raggiunto solo se il Gather termina senza input vocale.
          const query = new URLSearchParams({
            motivo: azione.contesto.motivo,
            tentativo: String(azione.contesto.tentativo),
          });
          response.redirect({ method: 'POST' }, `${PERCORSI.silenzio}?${query}`);
          break;
        }
        case 'inoltra':
          response.dial(
            { action: PERCORSI.esitoInoltro, method: 'POST', timeout: azione.squilloSec },
            azione.numero
          );
          break;
        case 'riaggancia':
          response.hangup();
          break;
        case 'prosegui':
          response.redirect(
            { method: 'POST' },
            `${PERCORSI.prosegui}?${new URLSearchParams({ motivo: azione.contesto?.motivo ?? '' })}`
          );
          break;
        default:
          throw new Error(`Azione non supportata da Twilio: ${azione.tipo}`);
      }
    }

    return response.toString();
  }

  function router(centralino) {
    const r = express.Router();

    // Twilio invia i parametri dei webhook come application/x-www-form-urlencoded.
    r.use(express.urlencoded({ extended: false }));

    // Verifica che le richieste arrivino davvero da Twilio (header X-Twilio-Signature).
    const webhookOptions = { validate: validaFirma };
    if (publicBaseUrl) {
      const url = new URL(publicBaseUrl);
      webhookOptions.host = url.host;
      webhookOptions.protocol = url.protocol.replace(':', '');
    }
    const verificaTwilio = authToken ? twilio.webhook(authToken, webhookOptions) : twilio.webhook(webhookOptions);

    // Il numero chiamato serve a distinguere più linee sullo stesso server (per esempio la demo).
    const gestisci = (creaEvento) => async (req, res) => {
      const azioni = await centralino.gestisci({ ...creaEvento(req), numeroChiamato: req.body.To || null });
      res.type('text/xml').send(renderizza(azioni));
    };

    r.post(PERCORSI.chiamataInArrivo, verificaTwilio, gestisci((req) => ({
      tipo: 'chiamata_in_arrivo',
      chiamataId: req.body.CallSid,
    })));

    r.post(PERCORSI.esitoInoltro, verificaTwilio, gestisci((req) => ({
      tipo: 'esito_inoltro',
      chiamataId: req.body.CallSid,
      esito: ESITI_DIAL[req.body.DialCallStatus] ?? 'fallito',
    })));

    r.post(PERCORSI.silenzio, verificaTwilio, gestisci((req) => ({
      tipo: 'silenzio',
      chiamataId: req.body.CallSid,
      contesto: { motivo: req.query.motivo, tentativo: Number.parseInt(req.query.tentativo, 10) || 1 },
    })));

    r.post(PERCORSI.prosegui, verificaTwilio, gestisci((req) => ({
      tipo: 'prosegui',
      chiamataId: req.body.CallSid,
      contesto: { motivo: String(req.query.motivo ?? '') },
    })));

    r.post(PERCORSI.parlato, verificaTwilio, gestisci((req) => ({
      tipo: 'parlato',
      chiamataId: req.body.CallSid,
      testo: req.body.SpeechResult || '',
      numeroChiamante: req.body.From || null,
    })));

    return r;
  }

  return { nome: 'twilio', router, renderizza, PERCORSI };
}

module.exports = { creaProviderTwilio, ESITI_DIAL };
