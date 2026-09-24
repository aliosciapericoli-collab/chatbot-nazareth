// Nome del prodotto e del cliente: ogni installazione mostra "<prodotto> · <cliente>".
const APP_NAME = (process.env.APP_NAME || 'Vocalba').trim();
const CLIENT_NAME = (process.env.CLIENT_NAME || 'Nazareth Residence').trim();

module.exports = {
  APP_NAME,
  CLIENT_NAME,
  TITOLO: `${APP_NAME} · ${CLIENT_NAME}`,
};
