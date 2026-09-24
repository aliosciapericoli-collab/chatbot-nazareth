// Registro chiamate di Twilio: storico persistente (non si azzera ai riavvii) con durata e costo.
// Il numero del chiamante viene mascherato: in dashboard restano solo le ultime tre cifre.
const twilio = require('twilio');

const CACHE_MS = 60 * 1000;

function mascheraNumero(numero) {
  if (!numero) return '—';
  const cifre = String(numero).replace(/[^\d]/g, '');
  return cifre.length > 3 ? `•••${cifre.slice(-3)}` : '•••';
}

function creaRegistroTwilio({ accountSid, authToken, client, limite = 50, now = () => Date.now() } = {}) {
  const disponibile = Boolean(client || (accountSid && authToken));
  let api = client;
  let cache = null;

  async function ultimeChiamate() {
    if (!disponibile) return { disponibile: false };
    if (cache && now() - cache.ts < CACHE_MS) return cache.dati;

    api ??= twilio(accountSid, authToken);
    try {
      const calls = await api.calls.list({ limit: limite });
      const chiamate = calls.map((c) => ({
        inizio: c.startTime ? new Date(c.startTime).toISOString() : null,
        durataSec: Number(c.duration) || 0,
        stato: c.status,
        direzione: c.direction,
        da: mascheraNumero(c.from),
        // Twilio riporta i costi come numeri negativi; vuoto finché la chiamata non è tariffata.
        costo: c.price == null || c.price === '' ? null : Math.abs(Number(c.price)),
        valuta: c.priceUnit || null,
      }));
      const tariffate = chiamate.filter((c) => c.costo != null);
      const dati = {
        disponibile: true,
        chiamate,
        totale: {
          chiamate: chiamate.length,
          minuti: Math.round(chiamate.reduce((t, c) => t + c.durataSec, 0) / 60),
          costo: tariffate.reduce((t, c) => t + c.costo, 0),
          valuta: tariffate[0]?.valuta ?? null,
        },
      };
      cache = { ts: now(), dati };
      return dati;
    } catch (error) {
      return { disponibile: true, errore: `${error.status ?? ''} ${String(error.message).slice(0, 200)}`.trim() };
    }
  }

  return { ultimeChiamate };
}

module.exports = { creaRegistroTwilio, mascheraNumero };
