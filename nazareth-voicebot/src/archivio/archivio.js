// Archivio delle chiamate su Postgres: conversazione completa, copia delle email di
// richiamata ed esito di ogni chiamata, consultabili dalla dashboard.
// Senza DATABASE_URL l'archivio è spento e il voicebot funziona come prima.
//
// Regole:
// - le scritture non bloccano mai la chiamata: partono in coda, una chiamata alla volta
//   nell'ordine in cui accadono, e un errore del database non arriva al chiamante;
// - nei log finiscono solo codici tecnici, mai il testo delle conversazioni;
// - dopo GIORNI di conservazione (predefinito 90) tutto viene cancellato in automatico.
const { Pool } = require('pg');

const GIORNI_PREDEFINITI = 90;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS vocalba_chiamate (
  call_sid     text PRIMARY KEY,
  inizio       timestamptz NOT NULL DEFAULT now(),
  fine         timestamptz,
  numero       text,
  ingresso     text,
  esito        text,
  argomenti    text[] NOT NULL DEFAULT '{}',
  preventivo   numeric,
  richiamata   text,
  durata_sec   integer,
  stato_linea  text,
  costo        numeric,
  valuta       text,
  aggiornata   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vocalba_chiamate_inizio ON vocalba_chiamate (inizio DESC);
CREATE TABLE IF NOT EXISTS vocalba_messaggi (
  id        bigserial PRIMARY KEY,
  call_sid  text NOT NULL REFERENCES vocalba_chiamate (call_sid) ON DELETE CASCADE,
  ts        timestamptz NOT NULL DEFAULT now(),
  ruolo     text NOT NULL,
  testo     text NOT NULL
);
CREATE INDEX IF NOT EXISTS vocalba_messaggi_chiamata ON vocalba_messaggi (call_sid, id);
CREATE TABLE IF NOT EXISTS vocalba_email (
  id            bigserial PRIMARY KEY,
  call_sid      text NOT NULL REFERENCES vocalba_chiamate (call_sid) ON DELETE CASCADE,
  ts            timestamptz NOT NULL DEFAULT now(),
  destinatario  text,
  oggetto       text NOT NULL,
  testo         text NOT NULL,
  esito         text NOT NULL
);
CREATE INDEX IF NOT EXISTS vocalba_email_chiamata ON vocalba_email (call_sid);
`;

// Riga della chiamata: si crea al primo evento e poi si aggiorna.
const ASSICURA = 'INSERT INTO vocalba_chiamate (call_sid) VALUES ($1) ON CONFLICT (call_sid) DO NOTHING';

// Stato della richiamata per evento del centralino.
const RICHIAMATE = {
  richiamata_richiesta: 'in_invio',
  richiamata_email_inviata: 'email_inviata',
  richiamata_email_non_inviata: 'email_non_inviata',
  richiamata_email_errore: 'email_non_inviata',
};

const TESTO_MAX = 4000;
const testoLimitato = (t) => String(t ?? '').slice(0, TESTO_MAX);

// Il servizio interno di Render ha un nome host senza punti e non usa TLS; da fuori serve.
function opzioniSsl(databaseUrl) {
  if (process.env.DATABASE_SSL === 'false') return false;
  if (process.env.DATABASE_SSL === 'true') return { rejectUnauthorized: false };
  try {
    const host = new URL(databaseUrl).hostname;
    if (!host.includes('.') || host === '127.0.0.1') return false;
    return { rejectUnauthorized: false };
  } catch {
    return false;
  }
}

function archivioSpento() {
  const nulla = () => {};
  const vuoto = async () => null;
  return {
    attivo: false,
    giorni: 0,
    evento: nulla,
    trascrivi: nulla,
    email: nulla,
    sincronizza: vuoto,
    pulisci: vuoto,
    elenco: vuoto,
    dettaglio: vuoto,
    attendi: async () => {},
    avvia: nulla,
    chiudi: async () => {},
  };
}

/**
 * @param {object} opzioni
 * @param {string} [opzioni.databaseUrl] DATABASE_URL; senza URL né pool l'archivio è spento
 * @param {import('pg').Pool} [opzioni.pool] pool già creato (test)
 * @param {number} [opzioni.giorni] giorni di conservazione (ARCHIVIO_GIORNI)
 * @param {(chiamataId: string|null, evento: string, dettagli?: object) => void} [opzioni.log]
 */
function creaArchivio({ databaseUrl, pool, giorni = GIORNI_PREDEFINITI, log = () => {} } = {}) {
  if (!pool && !databaseUrl) return archivioSpento();

  const db = pool ?? new Pool({
    connectionString: databaseUrl,
    ssl: opzioniSsl(databaseUrl),
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });
  // Un errore su una connessione inattiva non deve far cadere il processo.
  db.on('error', (error) => log(null, 'archivio_errore', { operazione: 'connessione', codice: error.code }));

  // Lo schema si crea una volta; se il database non risponde si riprova alla scrittura dopo.
  let schema = null;
  function pronto() {
    schema ??= db.query(SCHEMA).catch((error) => {
      schema = null;
      throw error;
    });
    return schema;
  }

  // Code per chiamata: le scritture della stessa chiamata restano in ordine.
  const code = new Map();
  const inVolo = new Set();
  function accoda(chiamataId, operazione, lavoro) {
    if (!chiamataId) return;
    const precedente = code.get(chiamataId) ?? Promise.resolve();
    const prossima = precedente
      .then(pronto)
      .then(lavoro)
      .catch((error) => log(chiamataId, 'archivio_errore', { operazione, codice: error.code ?? error.name }));
    code.set(chiamataId, prossima);
    inVolo.add(prossima);
    prossima.finally(() => {
      inVolo.delete(prossima);
      if (code.get(chiamataId) === prossima) code.delete(chiamataId);
    });
  }

  // Crea la riga se manca, poi la aggiorna: così vale anche il primo evento della chiamata.
  async function aggiorna(chiamataId, set, valori = []) {
    await db.query(ASSICURA, [chiamataId]);
    await db.query(`UPDATE vocalba_chiamate SET ${set}, aggiornata = now() WHERE call_sid = $1`, [chiamataId, ...valori]);
  }

  /** Eventi del centralino (gli stessi dei log): esito, argomenti, preventivi, richiamate. */
  function evento(chiamataId, nome, dettagli = {}) {
    switch (nome) {
      case 'assistente':
        return accoda(chiamataId, nome, () => aggiorna(chiamataId, 'ingresso = $2',
          [dettagli.motivo === 'chiusa' ? 'reception_chiusa' : 'reception_non_disponibile']));
      case 'inoltro_reception':
        return accoda(chiamataId, nome, () => aggiorna(chiamataId, "ingresso = COALESCE(vocalba_chiamate.ingresso, 'inoltro_reception')"));
      case 'domanda':
        if (!dettagli.argomenti?.length) return undefined;
        return accoda(chiamataId, nome, () => aggiorna(chiamataId,
          'argomenti = ARRAY(SELECT DISTINCT unnest(vocalba_chiamate.argomenti || $2::text[]))', [dettagli.argomenti]));
      case 'verifica_disponibilita':
        if (dettagli.esito !== 'disponibile' || typeof dettagli.prezzoMinimo !== 'number') return undefined;
        return accoda(chiamataId, nome, () => aggiorna(chiamataId, 'preventivo = $2', [dettagli.prezzoMinimo]));
      case 'chiusura':
        return accoda(chiamataId, nome, () => aggiorna(chiamataId, 'esito = $2, fine = now()', [dettagli.causa ?? null]));
      default:
        if (RICHIAMATE[nome]) return accoda(chiamataId, nome, () => aggiorna(chiamataId, 'richiamata = $2', [RICHIAMATE[nome]]));
        return undefined;
    }
  }

  /** Una battuta della conversazione, esattamente come è stata detta o trascritta. */
  function trascrivi(chiamataId, ruolo, testo, { numero } = {}) {
    if (!testo) return;
    accoda(chiamataId, 'trascrizione', async () => {
      if (numero) await aggiorna(chiamataId, 'numero = COALESCE(vocalba_chiamate.numero, $2)', [numero]);
      else await db.query(ASSICURA, [chiamataId]);
      await db.query('INSERT INTO vocalba_messaggi (call_sid, ruolo, testo) VALUES ($1, $2, $3)', [chiamataId, ruolo, testoLimitato(testo)]);
    });
  }

  /** Copia identica dell'email di richiamata inviata (o non inviata) alla reception. */
  function email(chiamataId, { destinatario, oggetto, testo, esito }) {
    accoda(chiamataId, 'email', async () => {
      await db.query(ASSICURA, [chiamataId]);
      await db.query(
        'INSERT INTO vocalba_email (call_sid, destinatario, oggetto, testo, esito) VALUES ($1, $2, $3, $4, $5)',
        [chiamataId, destinatario ?? null, oggetto, testo, esito]
      );
    });
  }

  /**
   * Sincronizza il registro del provider: ogni chiamata ricevuta entra nell'archivio,
   * anche quelle chiuse prima di parlare, con durata, stato e costo.
   * @param {Array<{ sid: string, from?: string, startTime?: Date|string, endTime?: Date|string,
   *   duration?: string|number, status?: string, price?: string|number|null, priceUnit?: string,
   *   direction?: string, parentCallSid?: string|null }>} chiamate
   */
  async function sincronizza(chiamate) {
    await pronto();
    let importate = 0;
    for (const c of chiamate) {
      // Solo le chiamate in arrivo: gli inoltri sono tratte figlie della stessa telefonata.
      if (!c.sid || (c.direction && c.direction !== 'inbound') || c.parentCallSid) continue;
      await db.query(
        `INSERT INTO vocalba_chiamate (call_sid, inizio, fine, numero, durata_sec, stato_linea, costo, valuta)
         VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7, $8)
         ON CONFLICT (call_sid) DO UPDATE SET
           inizio = COALESCE($2, vocalba_chiamate.inizio),
           fine = COALESCE(vocalba_chiamate.fine, $3),
           numero = COALESCE(vocalba_chiamate.numero, $4),
           durata_sec = $5, stato_linea = $6, costo = $7, valuta = $8, aggiornata = now()`,
        [
          c.sid,
          c.startTime ? new Date(c.startTime) : null,
          c.endTime ? new Date(c.endTime) : null,
          c.from || null,
          Number(c.duration) || 0,
          c.status || null,
          // Il provider riporta i costi come numeri negativi; vuoto finché non è tariffata.
          c.price == null || c.price === '' ? null : Math.abs(Number(c.price)),
          c.priceUnit || null,
        ]
      );
      importate += 1;
    }
    return importate;
  }

  /** Cancella tutto ciò che è più vecchio del periodo di conservazione. */
  async function pulisci() {
    await pronto();
    const r = await db.query("DELETE FROM vocalba_chiamate WHERE inizio < now() - make_interval(days => $1)", [giorni]);
    return r.rowCount;
  }

  /**
   * Elenco per la dashboard, dalla più recente, a pagine.
   * @param {{ prima?: string, cerca?: string, limite?: number }} filtri
   */
  async function elenco({ prima, cerca, limite = 25 } = {}) {
    await pronto();
    const testoCerca = cerca ? `%${String(cerca).slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
    const righe = await db.query(
      `SELECT c.call_sid, c.inizio, c.fine, c.numero, c.ingresso, c.esito, c.argomenti, c.preventivo,
              c.richiamata, c.durata_sec, c.stato_linea, c.costo, c.valuta,
              (SELECT count(*) FROM vocalba_messaggi m WHERE m.call_sid = c.call_sid AND m.ruolo = 'cliente')::int AS domande,
              (SELECT m.testo FROM vocalba_messaggi m WHERE m.call_sid = c.call_sid AND m.ruolo = 'cliente' ORDER BY m.id LIMIT 1) AS prima_domanda,
              EXISTS (SELECT 1 FROM vocalba_email e WHERE e.call_sid = c.call_sid) AS con_email
         FROM vocalba_chiamate c
        WHERE ($1::timestamptz IS NULL OR c.inizio < $1)
          AND ($2::text IS NULL OR c.numero ILIKE $2
               OR EXISTS (SELECT 1 FROM vocalba_messaggi m WHERE m.call_sid = c.call_sid AND m.testo ILIKE $2))
        ORDER BY c.inizio DESC
        LIMIT $3`,
      [prima ? new Date(prima) : null, testoCerca, Math.min(Math.max(Number(limite) || 25, 1), 100) + 1]
    );
    const altre = righe.rows.length > limite;
    const chiamate = righe.rows.slice(0, limite).map(riga);
    const totale = await db.query('SELECT count(*)::int AS n FROM vocalba_chiamate');
    return {
      chiamate,
      altre,
      prossima: altre ? chiamate.at(-1).inizio : null,
      totale: totale.rows[0].n,
      giorni,
    };
  }

  /** Una chiamata con tutta la conversazione e le email. */
  async function dettaglio(chiamataId) {
    await pronto();
    const c = await db.query('SELECT * FROM vocalba_chiamate WHERE call_sid = $1', [chiamataId]);
    if (!c.rows.length) return null;
    const messaggi = await db.query('SELECT ts, ruolo, testo FROM vocalba_messaggi WHERE call_sid = $1 ORDER BY id', [chiamataId]);
    const email = await db.query('SELECT ts, destinatario, oggetto, testo, esito FROM vocalba_email WHERE call_sid = $1 ORDER BY id', [chiamataId]);
    return {
      ...riga(c.rows[0]),
      messaggi: messaggi.rows.map((m) => ({ ts: m.ts.toISOString(), ruolo: m.ruolo, testo: m.testo })),
      email: email.rows.map((e) => ({ ts: e.ts.toISOString(), destinatario: e.destinatario, oggetto: e.oggetto, testo: e.testo, esito: e.esito })),
    };
  }

  function riga(r) {
    return {
      id: r.call_sid,
      inizio: r.inizio.toISOString(),
      fine: r.fine ? r.fine.toISOString() : null,
      numero: r.numero,
      ingresso: r.ingresso,
      esito: r.esito,
      argomenti: r.argomenti ?? [],
      preventivo: r.preventivo == null ? null : Number(r.preventivo),
      richiamata: r.richiamata,
      durataSec: r.durata_sec,
      statoLinea: r.stato_linea,
      costo: r.costo == null ? null : Number(r.costo),
      valuta: r.valuta,
      domande: r.domande ?? undefined,
      primaDomanda: r.prima_domanda ?? undefined,
      conEmail: r.con_email ?? undefined,
    };
  }

  /**
   * Avvia i lavori periodici: sincronizzazione del registro telefonico e pulizia.
   * @param {{ leggiRegistro?: () => Promise<Array<object>>, ogniMs?: number }} opzioni
   */
  function avvia({ leggiRegistro, ogniMs = 10 * 60 * 1000 } = {}) {
    const giro = async () => {
      try {
        if (leggiRegistro) {
          const importate = await sincronizza(await leggiRegistro());
          log(null, 'archivio_sincronizzato', { chiamate: importate });
        }
        const cancellate = await pulisci();
        if (cancellate) log(null, 'archivio_pulito', { chiamate: cancellate });
      } catch (error) {
        log(null, 'archivio_errore', { operazione: 'sincronizzazione', codice: error.code ?? error.name, status: error.status });
      }
    };
    giro();
    setInterval(giro, ogniMs).unref();
  }

  return {
    attivo: true,
    giorni,
    evento,
    trascrivi,
    email,
    sincronizza,
    pulisci,
    elenco,
    dettaglio,
    // Attende le scritture in coda (test e chiusura ordinata).
    attendi: async () => { while (inVolo.size) await Promise.allSettled([...inVolo]); },
    avvia,
    chiudi: async () => {
      while (inVolo.size) await Promise.allSettled([...inVolo]);
      if (!pool) await db.end();
    },
  };
}

module.exports = { creaArchivio, GIORNI_PREDEFINITI, SCHEMA };
