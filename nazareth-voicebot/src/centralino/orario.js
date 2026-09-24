// Orario della reception: chiusa dalle 20:00 alle 07:00, estremi inclusi.
const { formatInTimeZone } = require('date-fns-tz');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
// Solo per i test: 'chiusa' o 'aperta' forzano la modalità, 'auto' (default) segue l'orario.
const RECEPTION_MODE = process.env.RECEPTION_MODE || 'auto';

function isReceptionChiusa(date = new Date(), modalita = RECEPTION_MODE) {
  if (modalita === 'chiusa') return true;
  if (modalita === 'aperta') return false;
  const [ore, minuti] = formatInTimeZone(date, TIMEZONE, 'HH:mm').split(':').map(Number);
  const minutiDelGiorno = ore * 60 + minuti;
  return minutiDelGiorno >= 20 * 60 || minutiDelGiorno <= 7 * 60;
}

module.exports = { isReceptionChiusa, RECEPTION_MODE };
