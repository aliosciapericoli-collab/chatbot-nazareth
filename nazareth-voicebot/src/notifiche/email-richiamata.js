// Email alla reception con la richiesta di richiamata.
// L'invio avviene dopo la risposta a Twilio e non blocca mai la chiamata: se SMTP manca
// o l'invio fallisce, resta solo un log tecnico con il CallSid, senza dati personali.
const nodemailer = require('nodemailer');
const { formatInTimeZone } = require('date-fns-tz');

const DESTINATARIO_PREDEFINITO = 'info@nazarethresidence.com';

function unaRiga(testo, max) {
  return String(testo ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, max);
}

/**
 * Oggetto e testo dell'email. Funzione pura, usata anche nei test.
 * @param {object} dati
 * @param {{ nome: string|null, numero: string|null, motivo: string|null }} dati.richiamata
 * @param {string|null} dati.numeroChiamante numero da cui è arrivata la chiamata, se affidabile
 * @param {Array<{ role: string, content: string }>} dati.messages conversazione della chiamata
 * @param {number} dati.ricevutaIl timestamp della conferma
 */
function componiEmail({ richiamata, numeroChiamante, messages, ricevutaIl, timezone = 'Europe/Rome' }) {
  const nome = richiamata.nome || 'nome non rilevato';
  const quando = formatInTimeZone(new Date(ricevutaIl), timezone, 'dd/MM/yyyy HH:mm');
  const conversazione = messages
    .map((m) => `${m.role === 'user' ? 'Cliente' : 'Assistente'}: ${unaRiga(m.content, 600)}`)
    .join('\n');

  const righe = [
    'Richiesta di richiamata lasciata al voicebot telefonico.',
    '',
    `Data e ora: ${quando} (ora di Roma)`,
    `Nome: ${richiamata.nome || '(non rilevato: vedi conversazione)'}`,
    `Numero da richiamare: ${richiamata.numero || '(non rilevato: vedi conversazione)'}`,
  ];
  if (numeroChiamante && numeroChiamante !== richiamata.numero) {
    righe.push(`Numero da cui ha chiamato: ${numeroChiamante}`);
  }
  righe.push(
    `Motivo: ${richiamata.motivo || '(non rilevato: vedi conversazione)'}`,
    '',
    'Conversazione:',
    conversazione,
    '',
    '---',
    'Al cliente è stato detto che verrà ricontattato in orario di apertura (7-20), senza un orario preciso,',
    'e che i suoi dati servono solo per ricontattarlo e vengono cancellati dopo la richiamata.',
    'Dopo la richiamata cancellate questa email.'
  );

  return {
    subject: unaRiga(`Richiamata richiesta - ${nome}`, 120),
    text: righe.join('\n'),
  };
}

/**
 * @param {object} opzioni
 * @param {string} [opzioni.host]  SMTP_HOST; senza host la notifica è disattivata
 * @param {number} [opzioni.port]  SMTP_PORT (465 = TLS diretto, altrimenti STARTTLS)
 * @param {string} [opzioni.user]  SMTP_USER
 * @param {string} [opzioni.pass]  SMTP_PASS
 * @param {string} [opzioni.to]    CALLBACK_EMAIL_TO
 * @param {string} [opzioni.from]  CALLBACK_EMAIL_FROM (default SMTP_USER)
 * @param {object} [opzioni.transport] trasporto nodemailer (sostituibile nei test)
 * @param {(chiamataId: string, evento: string, dettagli?: object) => void} opzioni.log
 */
function creaNotificatoreRichiamata({ host, port, user, pass, to, from, transport, log, timezone } = {}) {
  const destinatario = to || DESTINATARIO_PREDEFINITO;
  const mittente = from || user;
  const configurato = Boolean(transport || (host && mittente));
  let trasporto = transport;

  /** Non lancia mai: restituisce true se l'email è partita. */
  async function invia({ chiamataId, ...dati }) {
    if (!configurato) {
      log(chiamataId, 'richiamata_email_non_inviata', { motivo: 'smtp_non_configurato' });
      return false;
    }
    try {
      const porta = Number.parseInt(port, 10) || 587;
      trasporto ??= nodemailer.createTransport({
        host,
        port: porta,
        secure: porta === 465,
        auth: user ? { user, pass } : undefined,
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });
      const { subject, text } = componiEmail({ ...dati, timezone });
      await trasporto.sendMail({ from: mittente, to: destinatario, subject, text });
      log(chiamataId, 'richiamata_email_inviata');
      return true;
    } catch (error) {
      // Solo codici tecnici: il messaggio d'errore SMTP può contenere indirizzi o testo.
      log(chiamataId, 'richiamata_email_errore', { tipo: error.name, codice: error.code, risposta: error.responseCode });
      return false;
    }
  }

  return { invia, configurato };
}

module.exports = { creaNotificatoreRichiamata, componiEmail, DESTINATARIO_PREDEFINITO };
