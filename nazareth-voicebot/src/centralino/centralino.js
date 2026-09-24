// Centralino: tutta la logica della chiamata, indipendente dal provider telefonico.
// Riceve eventi neutri e restituisce azioni neutre (vedi ./protocollo.js).
const { azioni } = require('./protocollo');
const { isReceptionChiusa: orarioReception } = require('./orario');
const {
  INTRO,
  RICHIESTA_DOPO_SILENZIO,
  MESSAGGIO_RIPIEGO,
  MESSAGGIO_LIMITE_TURNI,
  MESSAGGIO_NESSUNA_RISPOSTA,
} = require('./messaggi');

// Esiti dell'inoltro per cui la reception non ha risposto: passa all'assistente.
const INOLTRO_NON_RIUSCITO = new Set(['occupato', 'nessuna_risposta', 'fallito']);

class RispostaInRitardoError extends Error {
  constructor(ms) {
    super(`Nessuna risposta dall'assistente entro ${ms} ms`);
    this.name = 'RispostaInRitardoError';
  }
}

function conLimiteDiTempo(promessa, ms) {
  let timer;
  const scadenza = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new RispostaInRitardoError(ms)), ms);
  });
  return Promise.race([promessa, scadenza]).finally(() => clearTimeout(timer));
}

// Log minimale: solo id della chiamata ed esito tecnico, mai il parlato o il numero del chiamante.
function logPredefinito(chiamataId, evento, dettagli = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), chiamataId, evento, ...dettagli }));
}

/**
 * @param {object} opzioni
 * @param {{ rispondi(messages): Promise<{ testo: string, fine: boolean }> }} opzioni.assistente
 * @param {ReturnType<import('../conversation-store').creaConversationStore>} opzioni.conversazioni
 * @param {string} opzioni.numeroReception  numero E.164 a cui inoltrare in orario di apertura
 * @param {number} opzioni.squilloSec       secondi di squillo verso la reception
 * @param {boolean} opzioni.inoltroReception se false non inoltra mai: la reception è già stata provata a monte
 * @param {number} opzioni.maxTurni         domande massime per chiamata
 * @param {number} opzioni.maxTentativi     ascolti senza risposta prima di chiudere
 * @param {number} opzioni.limiteRispostaMs tempo massimo per la risposta dell'assistente
 */
function creaCentralino({
  assistente,
  conversazioni,
  numeroReception,
  squilloSec = 20,
  // false quando un centralino esterno (es. Asterisk) ha già fatto squillare la reception.
  inoltroReception = true,
  maxTurni = 10,
  maxTentativi = 2,
  limiteRispostaMs = 9000,
  lingua = 'it-IT',
  isReceptionChiusa = () => orarioReception(),
  log = logPredefinito,
}) {
  const parla = (testo) => azioni.parla(testo, lingua);
  const ascolta = (motivo, tentativo) => azioni.ascolta(lingua, { motivo, tentativo });

  function chiudi(chiamataId, testo) {
    conversazioni.elimina(chiamataId);
    return [parla(testo), azioni.riaggancia()];
  }

  function accogli(motivo) {
    return [parla(INTRO[motivo]), ascolta(motivo, 1)];
  }

  function chiamataInArrivo({ chiamataId }) {
    if (isReceptionChiusa()) {
      log(chiamataId, 'assistente', { motivo: 'chiusa' });
      return accogli('chiusa');
    }
    if (!inoltroReception) {
      // La chiamata arriva qui solo se la reception non ha risposto a monte.
      log(chiamataId, 'assistente', { motivo: 'occupata', inoltro: 'a_monte' });
      return accogli('occupata');
    }
    log(chiamataId, 'inoltro_reception');
    return [azioni.inoltra(numeroReception, squilloSec)];
  }

  function esitoInoltro({ chiamataId, esito }) {
    if (INOLTRO_NON_RIUSCITO.has(esito)) {
      log(chiamataId, 'assistente', { motivo: 'occupata', esito });
      return accogli('occupata');
    }
    // Conversazione con la reception conclusa o chiamata annullata.
    return [azioni.riaggancia()];
  }

  function silenzio({ chiamataId, contesto = {} }) {
    const motivo = contesto.motivo in INTRO ? contesto.motivo : 'chiusa';
    const tentativo = Number.parseInt(contesto.tentativo, 10) || 1;
    log(chiamataId, 'silenzio', { motivo, tentativo });

    if (tentativo >= maxTentativi) return chiudi(chiamataId, MESSAGGIO_NESSUNA_RISPOSTA);
    return [parla(RICHIESTA_DOPO_SILENZIO[motivo]), ascolta(motivo, tentativo + 1)];
  }

  async function parlato({ chiamataId, testo }) {
    const domanda = (testo || '').trim();
    if (!domanda) {
      log(chiamataId, 'parlato_vuoto');
      return silenzio({ chiamataId, contesto: { motivo: 'continua', tentativo: 1 } });
    }

    if (conversazioni.turniUtente(chiamataId) >= maxTurni) {
      log(chiamataId, 'limite_turni', { turni: maxTurni });
      return chiudi(chiamataId, MESSAGGIO_LIMITE_TURNI);
    }

    const messages = conversazioni.storico(chiamataId);
    messages.push({ role: 'user', content: domanda });

    const inizio = Date.now();
    try {
      const { testo: risposta, fine } = await conLimiteDiTempo(assistente.rispondi(messages), limiteRispostaMs);
      log(chiamataId, 'risposta_claude', { ms: Date.now() - inizio, turno: messages.length, fine });

      if (fine) return chiudi(chiamataId, risposta);

      messages.push({ role: 'assistant', content: risposta });
      conversazioni.salva(chiamataId, messages);
      return [parla(risposta), ascolta('continua', 1)];
    } catch (error) {
      // Il messaggio d'errore dell'API non contiene il parlato del chiamante.
      log(chiamataId, 'errore_claude', {
        ms: Date.now() - inizio,
        tipo: error.name,
        status: error.status,
        messaggio: String(error.message).slice(0, 300),
      });
      return chiudi(chiamataId, MESSAGGIO_RIPIEGO);
    }
  }

  const gestori = {
    chiamata_in_arrivo: chiamataInArrivo,
    esito_inoltro: esitoInoltro,
    silenzio,
    parlato,
  };

  return {
    /**
     * Unico punto d'ingresso per gli adattatori. Non lancia mai errori: in caso di
     * problemi il chiamante sente il messaggio di ripiego e la chiamata si chiude.
     * @param {import('./protocollo').Evento} evento
     * @returns {Promise<import('./protocollo').Azione[]>}
     */
    async gestisci(evento) {
      const gestore = gestori[evento?.tipo];
      try {
        if (!gestore) throw new Error(`Evento sconosciuto: ${evento?.tipo}`);
        return await gestore(evento);
      } catch (error) {
        log(evento?.chiamataId, 'errore_centralino', { tipo: error.name, messaggio: String(error.message).slice(0, 300) });
        return chiudi(evento?.chiamataId, MESSAGGIO_RIPIEGO);
      }
    },
  };
}

module.exports = { creaCentralino, RispostaInRitardoError };
