// Registro chiamate di Twilio: storico persistente (non si azzera ai riavvii) con durata e costo.
// Il numero del chiamante viene mascherato: in dashboard restano solo le ultime tre cifre.
const twilio = require('twilio');

const { formatInTimeZone } = require('date-fns-tz');

const CACHE_MS = 60 * 1000;
const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
const GIORNI_ANDAMENTO = 7;

function mascheraNumero(numero) {
  if (!numero) return '—';
  const cifre = String(numero).replace(/[^\d]/g, '');
  return cifre.length > 3 ? `•••${cifre.slice(-3)}` : '•••';
}

function creaRegistroTwilio({ accountSid, authToken, client, limite = 500, mostrate = 20, now = () => Date.now() } = {}) {
  const disponibile = Boolean(client || (accountSid && authToken));
  let api = client;
  let cache = null;

  async function ultimeChiamate() {
    if (!disponibile) return { disponibile: false };
    if (cache && now() - cache.ts < CACHE_MS) return cache.dati;

    api ??= twilio(accountSid, authToken);
    try {
      // Ultimi 7 giorni: bastano per l'andamento e restano entro una sola pagina di Twilio.
      const calls = await api.calls.list({ limit: limite, startTimeAfter: new Date(now() - GIORNI_ANDAMENTO * 86400000) });
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

      // Andamento per giorno (ora di Roma), dal più vecchio a oggi.
      const perGiorno = Array.from({ length: GIORNI_ANDAMENTO }, (_, i) => {
        const giorno = formatInTimeZone(new Date(now() - (GIORNI_ANDAMENTO - 1 - i) * 86400000), TIMEZONE, 'yyyy-MM-dd');
        return { giorno, chiamate: 0, minuti: 0 };
      });
      const indice = new Map(perGiorno.map((g, i) => [g.giorno, i]));
      for (const c of chiamate) {
        // Solo le chiamate in arrivo: gli inoltri sono tratte figlie della stessa telefonata.
        if (!c.inizio || (c.direzione && c.direzione !== 'inbound')) continue;
        const i = indice.get(formatInTimeZone(new Date(c.inizio), TIMEZONE, 'yyyy-MM-dd'));
        if (i === undefined) continue;
        perGiorno[i].chiamate += 1;
        perGiorno[i].minuti += c.durataSec / 60;
      }
      for (const g of perGiorno) g.minuti = Math.round(g.minuti);

      const dati = {
        disponibile: true,
        perGiorno,
        chiamate: chiamate.slice(0, mostrate),
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

  /**
   * Chiamate degli ultimi giorni con i dati completi, per l'archivio: il numero non è
   * mascherato perché l'archivio è consultabile solo dopo l'accesso alla dashboard.
   */
  async function chiamateRecenti({ giorni = 2 } = {}) {
    if (!disponibile) return [];
    api ??= twilio(accountSid, authToken);
    const calls = await api.calls.list({ limit: limite, startTimeAfter: new Date(now() - giorni * 86400000) });
    return calls.map((c) => ({
      sid: c.sid,
      from: c.from,
      startTime: c.startTime,
      endTime: c.endTime,
      duration: c.duration,
      status: c.status,
      price: c.price,
      priceUnit: c.priceUnit,
      direction: c.direction,
      parentCallSid: c.parentCallSid,
    }));
  }

  return { ultimeChiamate, chiamateRecenti, disponibile };
}

module.exports = { creaRegistroTwilio, mascheraNumero };
