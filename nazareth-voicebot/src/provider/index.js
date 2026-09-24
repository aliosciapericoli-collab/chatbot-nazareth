// Registro dei provider telefonici. Per aggiungerne uno: crea src/provider/<nome>.js
// con la stessa interfaccia di twilio.js e registralo qui.
const { creaProviderTwilio } = require('./twilio');

const PROVIDER = {
  twilio: () =>
    creaProviderTwilio({
      voce: process.env.TTS_VOICE || 'Polly.Bianca-Neural',
      // Da disattivare solo in locale, per provare gli endpoint con curl.
      validaFirma: process.env.TWILIO_VALIDATE_SIGNATURE !== 'false',
      publicBaseUrl: process.env.PUBLIC_BASE_URL,
    }),
};

function creaProvider(nome = process.env.TELEPHONY_PROVIDER || 'twilio') {
  const crea = PROVIDER[nome];
  if (!crea) {
    throw new Error(`Provider telefonico sconosciuto: "${nome}". Disponibili: ${Object.keys(PROVIDER).join(', ')}`);
  }
  return crea();
}

module.exports = { creaProvider, PROVIDER_DISPONIBILI: Object.keys(PROVIDER) };
