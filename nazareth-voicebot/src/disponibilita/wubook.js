// Prezzi e disponibilità in tempo reale dal motore di prenotazione WuBook del Nazareth.
//
// Usa la stessa chiamata della pagina pubblica di prenotazione
// (https://wubook.net/nneb/bk/?ep=...): POST form-urlencoded a /nneb/bk/inv?ep=...,
// ricostruita dallo script della pagina (static.wubook.net/js/neb/nserp.jgz,
// funzione neb_serp_inventory_loader). La risposta è un JSON codificato in base64:
//
//   inventory.inventory[idTariffa][idProdotto] = [ una voce per notte ]
//     voce = { p: prezzo della notte, a/sa: alloggi disponibili, c: chiuso,
//              ni: arrivo non consentito, m/M: soggiorno minimo/massimo, ... }
//   inventory.products[]   → prodotto = tipologia (id_zak_room_type) + occupazione (adulti)
//   inventory.room_types[] → nome della tipologia (content.texts.it.name)
//   inventory.rates[]      → tariffe con trattamento (board: "bb" = colazione inclusa)
//
// Le regole di disponibilità seguono quelle della pagina (invs.compiled.jgz,
// _chain_is_available_infos); "ultimo alloggio" = una sola camera libera di quel tipo.
// Nessuna prenotazione e nessun blocco: si leggono solo i dati pubblici.

const EP_PREDEFINITO = '17104f2c';
const TIMEOUT_MS = 4000;
const CACHE_MS = 5 * 60 * 1000;

class WuBookNonRaggiungibileError extends Error {
  constructor(motivo) {
    super(`WuBook non raggiungibile: ${motivo}`);
    this.name = 'WuBookNonRaggiungibileError';
  }
}

class WuBookFormatoError extends Error {
  constructor(motivo) {
    super(`Risposta WuBook in formato inatteso: ${motivo}`);
    this.name = 'WuBookFormatoError';
  }
}

// "2026-10-01" → "01/10/2026", il formato della pagina WuBook.
function dataWuBook(iso) {
  const [a, m, g] = iso.split('-');
  return `${g}/${m}/${a}`;
}

/** Decodifica e controlla la risposta: lancia WuBookFormatoError se la struttura è cambiata. */
function decodificaRisposta(testo) {
  let dati;
  try {
    dati = JSON.parse(Buffer.from(String(testo).trim(), 'base64').toString('utf8'));
  } catch {
    throw new WuBookFormatoError('non è JSON in base64');
  }
  const inv = dati?.inventory;
  if (!inv || typeof inv !== 'object') throw new WuBookFormatoError('manca inventory');
  if (!inv.inventory || typeof inv.inventory !== 'object' || Array.isArray(inv.inventory)) {
    throw new WuBookFormatoError('manca inventory.inventory');
  }
  for (const campo of ['products', 'room_types', 'rates']) {
    if (!Array.isArray(inv[campo])) throw new WuBookFormatoError(`manca inventory.${campo}`);
  }
  if (!Number.isInteger(inv.user_request?.nights)) throw new WuBookFormatoError('manca user_request.nights');
  for (const tariffa of Object.values(inv.inventory)) {
    for (const notti of Object.values(tariffa ?? {})) {
      if (!Array.isArray(notti) || notti.some((n) => typeof n?.p !== 'number')) {
        throw new WuBookFormatoError('voci per notte senza prezzo');
      }
    }
  }
  return inv;
}

// Stessa logica della pagina: 0 = prenotabile, altrimenti un motivo.
function motivoNonPrenotabile(voci, notti, adesso, arrivoEpoch) {
  if (voci.length !== notti) return 'notti_mancanti';
  const prima = voci[0];
  if (prima.ni) return 'arrivo_non_consentito';
  for (const v of voci) {
    if (!v.sa) return 'esaurito';
    if (v.c) return 'chiuso';
    if (typeof v.m === 'number' && v.m > notti) return 'soggiorno_minimo';
    if (typeof v.M === 'number' && v.M < notti) return 'soggiorno_massimo';
  }
  if (Number.isInteger(prima.Ma) && prima.Ma < notti) return 'soggiorno_massimo';
  if (Number.isInteger(prima.ma) && prima.ma > notti) return 'soggiorno_minimo';
  const oreAllArrivo = arrivoEpoch ? (arrivoEpoch + 86400 - adesso / 1000) / 3600 : null;
  if (oreAllArrivo != null) {
    if (Number.isInteger(prima.Mx) && prima.Mx && oreAllArrivo > prima.Mx) return 'troppo_in_anticipo';
    if (Number.isInteger(prima.mx) && prima.mx && oreAllArrivo < prima.mx) return 'troppo_tardi';
  }
  return null;
}

function nomeTipologia(rt) {
  return rt?.content?.texts?.it?.name || rt?.content?.texts?.default?.name || 'Camera';
}

/**
 * Offerte per una camera con `persone` ospiti: per ogni tipologia il prezzo totale più
 * basso tra le tariffe con colazione inclusa, e se è l'ultima camera libera.
 */
function calcolaOfferte(inv, { persone, adesso = Date.now() }) {
  const notti = inv.user_request.nights;
  const tipologie = new Map(inv.room_types.map((rt) => [rt.id, rt]));
  const prodotti = new Map(inv.products.map((p) => [p.id, p]));
  const tariffeBB = new Set(inv.rates.filter((r) => r.board === 'bb').map((r) => String(r.id)));
  const capienzaMassima = Math.max(0, ...inv.products.map((p) => p.occupancy?.adults ?? 0));

  const migliori = new Map(); // idTipologia → offerta
  for (const [idTariffa, perProdotto] of Object.entries(inv.inventory)) {
    if (!tariffeBB.has(String(idTariffa))) continue;
    for (const [idProdotto, voci] of Object.entries(perProdotto)) {
      const prodotto = prodotti.get(Number(idProdotto));
      if (!prodotto || prodotto.is_super || prodotto.occupancy?.adults !== persone) continue;
      if (motivoNonPrenotabile(voci, notti, adesso, inv.user_request.dfrom)) continue;

      const totale = Math.round(voci.reduce((t, v) => t + v.p, 0));
      const libere = Math.min(...voci.map((v) => v.a ?? v.sa));
      const idTipologia = prodotto.id_zak_room_type;
      const attuale = migliori.get(idTipologia);
      if (!attuale || totale < attuale.prezzoTotale) {
        migliori.set(idTipologia, {
          tipologia: nomeTipologia(tipologie.get(idTipologia)),
          prezzoTotale: totale,
          ultimaCamera: libere === 1,
        });
      }
    }
  }

  return {
    notti,
    capienzaMassima,
    offerte: [...migliori.values()].sort((a, b) => a.prezzoTotale - b.prezzoTotale),
  };
}

/**
 * @param {object} [opzioni]
 * @param {string} [opzioni.ep]        id del motore di prenotazione (WUBOOK_EP)
 * @param {number} [opzioni.timeoutMs] tempo massimo per WuBook
 * @param {number} [opzioni.cacheMs]   durata della cache per coppia di date
 * @param {typeof fetch} [opzioni.fetch] sostituibile nei test
 */
function creaClientWuBook({
  ep = EP_PREDEFINITO,
  baseUrl = 'https://wubook.net',
  timeoutMs = TIMEOUT_MS,
  cacheMs = CACHE_MS,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
} = {}) {
  // La risposta WuBook contiene tutte le occupazioni: la cache basta per coppia di date.
  const cache = new Map(); // "arrivo|partenza" → { ts, promessa }

  async function scarica(arrivo, partenza) {
    const corpo = new URLSearchParams({
      dfrom: dataWuBook(arrivo),
      dto: dataWuBook(partenza),
      'occupancy[adults]': '2',
      'occupancy[teens]': '0',
      'occupancy[children]': '0',
      'occupancy[babies]': '0',
      currency: 'EUR',
      lang: 'it',
      board: 'bb',
    });
    // Un solo limite per connessione e lettura della risposta.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let testo;
    try {
      const risposta = await fetchImpl(`${baseUrl}/nneb/bk/inv?ep=${encodeURIComponent(ep)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8', 'x-requested-with': 'XMLHttpRequest' },
        body: corpo,
        signal: controller.signal,
      });
      if (!risposta.ok) throw new WuBookNonRaggiungibileError(`HTTP ${risposta.status}`);
      testo = await risposta.text();
    } catch (error) {
      if (error instanceof WuBookNonRaggiungibileError) throw error;
      throw new WuBookNonRaggiungibileError(controller.signal.aborted ? `timeout ${timeoutMs} ms` : error.cause?.code || error.name);
    } finally {
      clearTimeout(timer);
    }
    return decodificaRisposta(testo);
  }

  /** Inventario per le date (con cache di 5 minuti). Restituisce anche se veniva dalla cache. */
  async function inventario(arrivo, partenza) {
    const chiave = `${arrivo}|${partenza}`;
    const voce = cache.get(chiave);
    if (voce && now() - voce.ts < cacheMs) return { inv: await voce.promessa, daCache: true };

    const promessa = scarica(arrivo, partenza);
    cache.set(chiave, { ts: now(), promessa });
    try {
      return { inv: await promessa, daCache: false };
    } catch (error) {
      cache.delete(chiave); // gli errori non restano in cache
      throw error;
    }
  }

  return { inventario, calcolaOfferte: (inv, opz) => calcolaOfferte(inv, { adesso: now(), ...opz }) };
}

module.exports = {
  creaClientWuBook,
  decodificaRisposta,
  calcolaOfferte,
  dataWuBook,
  WuBookNonRaggiungibileError,
  WuBookFormatoError,
};
