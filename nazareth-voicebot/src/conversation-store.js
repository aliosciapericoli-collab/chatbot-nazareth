// Storico delle conversazioni in memoria, una per chiamata (CallSid).
// I dati si perdono al riavvio del server: vanno bene per chiamate di pochi minuti.

const DEFAULT_TTL_MS = 30 * 60 * 1000;

function creaConversationStore({ ttlMs = DEFAULT_TTL_MS, now = () => Date.now() } = {}) {
  const conversazioni = new Map();

  function pulisciScadute() {
    const limite = now() - ttlMs;
    for (const [callSid, conversazione] of conversazioni) {
      if (conversazione.aggiornataIl < limite) conversazioni.delete(callSid);
    }
  }

  // Pulizia periodica; unref per non tenere vivo il processo (es. nei test).
  const intervallo = setInterval(pulisciScadute, Math.min(ttlMs, 60 * 1000));
  intervallo.unref();

  return {
    // Restituisce una copia dello storico (Anthropic.MessageParam[]).
    storico(callSid) {
      pulisciScadute();
      return [...(conversazioni.get(callSid)?.messages ?? [])];
    },
    salva(callSid, messages) {
      conversazioni.set(callSid, { messages, aggiornataIl: now() });
    },
    turniUtente(callSid) {
      return (conversazioni.get(callSid)?.messages ?? []).filter((m) => m.role === 'user').length;
    },
    elimina(callSid) {
      conversazioni.delete(callSid);
    },
    get size() {
      return conversazioni.size;
    },
    pulisciScadute,
  };
}

module.exports = { creaConversationStore };
