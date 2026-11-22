// Domande a cui il bot non ha saputo rispondere perché l'informazione non è nella base
// di conoscenza. Ognuna arriva per email a chi gestisce il bot, che fornisce la risposta:
// così la base di conoscenza si completa con le domande vere dei clienti.
// Nell'email c'è solo la domanda riassunta dal bot, senza nomi né numeri del cliente.
const { formatInTimeZone } = require('date-fns-tz');

// Prefisso fisso dell'oggetto: serve anche per ritrovare le email in casella.
const OGGETTO = 'Vocalba – domanda senza risposta';
const MAX_RECENTI = 100;

function unaRiga(testo, max) {
  return String(testo ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/** Oggetto e testo dell'email. Funzione pura, usata anche nei test. */
function componiEmailMancante({ domanda, ts, cliente = 'la struttura', timezone = 'Europe/Rome' }) {
  const quando = formatInTimeZone(new Date(ts), timezone, 'dd/MM/yyyy HH:mm');
  return {
    subject: unaRiga(`${OGGETTO}: ${domanda}`, 140),
    text: [
      `Il receptionist virtuale di ${cliente} non ha saputo rispondere a questa domanda,`,
      'perché l\'informazione non è nella sua base di conoscenza.',
      '',
      `Domanda: ${unaRiga(domanda, 200)}`,
      `Data e ora: ${quando} (ora di Roma)`,
      '',
      'Cosa fare: rispondi con l\'informazione corretta (a Claude, oppure a chi gestisce il bot)',
      'e verrà aggiunta alla base di conoscenza: la prossima volta il bot saprà rispondere.',
      '',
      'Al cliente il bot ha già detto di non avere l\'informazione e gli ha dato i contatti',
      '(WhatsApp, email, sito) o ha offerto la richiamata.',
    ].join('\n'),
  };
}

/**
 * @param {object} opzioni
 * @param {(email: { to: string, subject: string, text: string }) => Promise<void>} [opzioni.inviaEmail]
 * @param {string} [opzioni.destinatario] indirizzo a cui mandare le domande
 * @param {{ attivo: boolean, mancante?: Function }} [opzioni.archivio]
 * @param {string} [opzioni.cliente] nome della struttura per il testo dell'email
 * @param {(chiamataId: string, evento: string, dettagli?: object) => void} opzioni.log
 */
function creaSegnalatoreMancanti({ inviaEmail, destinatario, archivio, cliente, log = () => {} }) {
  const recenti = [];

  /** Non lancia mai: restituisce true se l'email è partita. */
  async function segnala({ chiamataId, domanda, ts = Date.now() }) {
    recenti.unshift({ ts: new Date(ts).toISOString(), domanda });
    if (recenti.length > MAX_RECENTI) recenti.pop();
    if (archivio?.attivo) archivio.mancante(chiamataId, domanda);

    if (!inviaEmail || !destinatario) {
      log(chiamataId, 'informazione_mancante_non_inviata', { motivo: 'email_non_configurata' });
      return false;
    }
    try {
      const { subject, text } = componiEmailMancante({ domanda, ts, cliente });
      await inviaEmail({ to: destinatario, subject, text });
      log(chiamataId, 'informazione_mancante_inviata');
      return true;
    } catch (error) {
      log(chiamataId, 'informazione_mancante_non_inviata', { tipo: error.name, codice: error.code });
      return false;
    }
  }

  return { segnala, recenti: () => [...recenti], configurato: Boolean(inviaEmail && destinatario) };
}

module.exports = { creaSegnalatoreMancanti, componiEmailMancante, OGGETTO };
