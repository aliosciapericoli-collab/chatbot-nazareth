// Centralino: tutta la logica della chiamata, indipendente dal provider telefonico.
// Riceve eventi neutri e restituisce azioni neutre (vedi ./protocollo.js).
const { azioni } = require('./protocollo');
const { leggiNumero, numeroProponibile, normalizzaNumero } = require('./numeri');
const { classificaDomanda } = require('./argomenti');
const { isReceptionChiusa: orarioReception } = require('./orario');
const {
  INTRO,
  creaIntro,
  RICHIESTA_DOPO_SILENZIO,
  MESSAGGIO_RIPIEGO,
  MESSAGGIO_LIMITE_TURNI,
  MESSAGGIO_NESSUNA_RISPOSTA,
  MESSAGGIO_ATTESA_VERIFICA,
  MESSAGGIO_RIPETA,
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
 * @param {(dati: object) => Promise<boolean>} [opzioni.notificaRichiamata] invio della richiesta
 *   di richiamata alla reception; chiamata dopo la risposta al provider, non deve mai lanciare
 * @param {boolean} [opzioni.richiamataDisponibile] se false il bot non offre la richiamata
 * @param {number} [opzioni.limiteVerificaMs] tempo massimo per completare una verifica con strumenti
 * @param {string[]} [opzioni.numeriEsclusi] numeri della struttura da non proporre come recapito
 * @param {(chiamataId: string, ruolo: 'cliente'|'assistente', testo: string, extra?: { numero?: string }) => void} [opzioni.trascrivi]
 *   riceve ogni battuta della conversazione, per l'archivio; non deve mai lanciare né bloccare
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
  notificaRichiamata = async () => false,
  // La richiamata si offre solo se c'è un modo di consegnarla (email configurata).
  richiamataDisponibile = false,
  numeriEsclusi = [],
  // Tempo massimo per completare una verifica (strumenti + risposta finale di Claude),
  // dal momento in cui è partita. Deve restare sotto il limite del provider (15 s Twilio).
  limiteVerificaMs = 13000,
  log = logPredefinito,
  trascrivi = () => {},
  // Giorni di conservazione delle conversazioni (0 = non conservate): cambia l'avviso iniziale.
  giorniConservazione = 0,
  // Testi fissi sostituibili (INTRO, MESSAGGIO_RIPIEGO, ...), per esempio per la linea demo.
  messaggi = {},
}) {
  const testi = {
    RICHIESTA_DOPO_SILENZIO,
    MESSAGGIO_RIPIEGO,
    MESSAGGIO_LIMITE_TURNI,
    MESSAGGIO_NESSUNA_RISPOSTA,
    MESSAGGIO_ATTESA_VERIFICA,
    MESSAGGIO_RIPETA,
    ...messaggi,
  };
  const intro = messaggi.INTRO ?? (giorniConservazione ? creaIntro(giorniConservazione) : INTRO);
  // Verifiche in corso: la risposta arriva con l'evento "prosegui".
  const verificheInCorso = new Map(); // chiamataId → { promessa, messages, numeroAffidabile, inizio }
  const parla = (testo) => azioni.parla(testo, lingua);
  const ascolta = (motivo, tentativo) => azioni.ascolta(lingua, { motivo, tentativo });

  function chiudi(chiamataId, testo, causa) {
    log(chiamataId, 'chiusura', { causa });
    conversazioni.elimina(chiamataId);
    return [parla(testo), azioni.riaggancia()];
  }

  function accogli(motivo) {
    return [parla(intro[motivo]), ascolta(motivo, 1)];
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
    log(chiamataId, 'chiusura', { causa: esito === 'risposto' ? 'reception' : 'annullata' });
    return [azioni.riaggancia()];
  }

  function silenzio({ chiamataId, contesto = {} }) {
    const motivo = contesto.motivo in intro ? contesto.motivo : 'chiusa';
    const tentativo = Number.parseInt(contesto.tentativo, 10) || 1;
    log(chiamataId, 'silenzio', { motivo, tentativo });

    if (tentativo >= maxTentativi) return chiudi(chiamataId, testi.MESSAGGIO_NESSUNA_RISPOSTA, 'silenzio');
    return [parla(testi.RICHIESTA_DOPO_SILENZIO[motivo]), ascolta(motivo, tentativo + 1)];
  }

  // Registra la richiamata confermata e invia l'email dopo la risposta al provider.
  function gestisciRichiamata(chiamataId, richiamata, messages, numeroChiamante) {
    if (conversazioni.segnato(chiamataId, 'richiamata')) {
      log(chiamataId, 'richiamata_duplicata_ignorata');
      return;
    }
    conversazioni.segna(chiamataId, 'richiamata');
    log(chiamataId, 'richiamata_richiesta', { datiCompleti: Boolean(richiamata.nome && richiamata.numero && richiamata.motivo) });

    const dati = {
      chiamataId,
      richiamata: { ...richiamata, numero: normalizzaNumero(richiamata.numero) ?? richiamata.numero },
      numeroChiamante,
      messages: [...messages],
      ricevutaIl: Date.now(),
    };
    setImmediate(() => {
      Promise.resolve()
        .then(() => notificaRichiamata(dati))
        .catch((error) => log(chiamataId, 'richiamata_email_errore', { tipo: error?.name }));
    });
  }

  async function parlato({ chiamataId, testo, numeroChiamante }) {
    const domanda = (testo || '').trim();
    if (!domanda) {
      log(chiamataId, 'parlato_vuoto');
      return silenzio({ chiamataId, contesto: { motivo: 'continua', tentativo: 1 } });
    }

    if (conversazioni.turniUtente(chiamataId) >= maxTurni) {
      log(chiamataId, 'limite_turni', { turni: maxTurni });
      return chiudi(chiamataId, testi.MESSAGGIO_LIMITE_TURNI, 'limite_turni');
    }

    // Per le statistiche si registra solo l'argomento, non il testo.
    log(chiamataId, 'domanda', { argomenti: classificaDomanda(domanda) });

    const messages = conversazioni.storico(chiamataId);
    messages.push({ role: 'user', content: domanda });

    // Il numero del chiamante si propone come recapito solo se è affidabile.
    const numeroAffidabile = numeroProponibile(numeroChiamante, numeriEsclusi) ? normalizzaNumero(numeroChiamante) : null;
    const datiChiamata = {
      numeroChiamanteLetto: numeroAffidabile ? leggiNumero(numeroAffidabile) : null,
      richiamataDisponibile,
    };

    const inizio = Date.now();
    try {
      const risposta = await conLimiteDiTempo(
        assistente.rispondi(messages, { ...datiChiamata, chiamataId }),
        limiteRispostaMs
      );

      if (risposta.inVerifica) {
        // Claude usa uno strumento: si risponde subito al provider e si completa dopo.
        avviaVerifica(chiamataId, risposta.completa, messages, numeroAffidabile);
        return [parla(testi.MESSAGGIO_ATTESA_VERIFICA), azioni.prosegui({ motivo: 'verifica' })];
      }

      log(chiamataId, 'risposta_claude', { ms: Date.now() - inizio, turno: messages.length, fine: risposta.fine });
      return concludi(chiamataId, risposta, messages, numeroAffidabile);
    } catch (error) {
      return erroreClaude(chiamataId, error, inizio);
    }
  }

  function erroreClaude(chiamataId, error, inizio) {
    // Il messaggio d'errore dell'API non contiene il parlato del chiamante.
    log(chiamataId, 'errore_claude', {
      ms: Date.now() - inizio,
      tipo: error.name,
      status: error.status,
      messaggio: String(error.message).slice(0, 300),
    });
    return chiudi(chiamataId, testi.MESSAGGIO_RIPIEGO, 'ripiego');
  }

  // Risposta finale di Claude: richiamata, congedo oppure nuovo ascolto.
  function concludi(chiamataId, { testo: risposta, fine, richiamata, prezzoBloccato }, messages, numeroAffidabile) {
    if (prezzoBloccato) log(chiamataId, 'prezzo_bloccato');
    if (richiamata) {
      gestisciRichiamata(chiamataId, richiamata, [...messages, { role: 'assistant', content: risposta }], numeroAffidabile);
    }

    if (fine) return chiudi(chiamataId, risposta, 'congedo');

    // Nello storico resta solo il testo detto al chiamante: i dati degli strumenti no,
    // così i prezzi vengono sempre riverificati.
    messages.push({ role: 'assistant', content: risposta });
    conversazioni.salva(chiamataId, messages);
    return [parla(risposta), ascolta('continua', 1)];
  }

  function avviaVerifica(chiamataId, completa, messages, numeroAffidabile) {
    const inizio = Date.now();
    const promessa = conLimiteDiTempo(Promise.resolve().then(completa), limiteVerificaMs);
    promessa.catch(() => {}); // l'esito viene letto in "prosegui"
    verificheInCorso.set(chiamataId, { promessa, messages, numeroAffidabile, inizio });
    // Se il chiamante riaggancia, il risultato non viene mai letto: si libera la memoria.
    setTimeout(() => {
      if (verificheInCorso.get(chiamataId)?.promessa === promessa) verificheInCorso.delete(chiamataId);
    }, limiteVerificaMs + 60000).unref();
  }

  async function prosegui({ chiamataId }) {
    const verifica = verificheInCorso.get(chiamataId);
    if (!verifica) {
      // Per esempio dopo un riavvio del server: si chiede di ripetere.
      log(chiamataId, 'verifica_non_trovata');
      return [parla(testi.MESSAGGIO_RIPETA), ascolta('continua', 1)];
    }
    verificheInCorso.delete(chiamataId);
    try {
      const risposta = await verifica.promessa;
      log(chiamataId, 'risposta_claude', {
        ms: Date.now() - verifica.inizio,
        turno: verifica.messages.length,
        fine: risposta.fine,
        strumenti: risposta.esitiStrumenti,
      });
      return concludi(chiamataId, risposta, verifica.messages, verifica.numeroAffidabile);
    } catch (error) {
      return erroreClaude(chiamataId, error, verifica.inizio);
    }
  }

  // Per l'archivio: le parole del cliente come le ha trascritte il provider, poi quello
  // che il bot gli ha detto. Un errore qui non deve mai toccare la chiamata.
  function registraBattute(evento, risposta) {
    const chiamataId = evento?.chiamataId;
    if (!chiamataId) return;
    try {
      const detto = evento.tipo === 'parlato' ? (evento.testo || '').trim() : '';
      if (detto) {
        const numero = numeroProponibile(evento.numeroChiamante, []) ? normalizzaNumero(evento.numeroChiamante) : null;
        trascrivi(chiamataId, 'cliente', detto, { numero });
      }
      for (const azione of risposta || []) {
        if (azione.tipo === 'parla' && azione.testo) trascrivi(chiamataId, 'assistente', azione.testo);
      }
    } catch (error) {
      log(chiamataId, 'archivio_errore', { operazione: 'trascrizione', codice: error.name });
    }
  }

  const gestori = {
    chiamata_in_arrivo: chiamataInArrivo,
    esito_inoltro: esitoInoltro,
    silenzio,
    parlato,
    prosegui,
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
      let risposta;
      try {
        if (!gestore) throw new Error(`Evento sconosciuto: ${evento?.tipo}`);
        risposta = await gestore(evento);
      } catch (error) {
        log(evento?.chiamataId, 'errore_centralino', { tipo: error.name, messaggio: String(error.message).slice(0, 300) });
        risposta = chiudi(evento?.chiamataId, testi.MESSAGGIO_RIPIEGO, 'ripiego');
      }
      registraBattute(evento, risposta);
      return risposta;
    },
  };
}

module.exports = { creaCentralino, RispostaInRitardoError, logPredefinito };
