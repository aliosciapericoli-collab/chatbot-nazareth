// Testi fissi letti dal centralino.

// Prima frase: dichiarazione che risponde un assistente virtuale (art. 50 AI Act),
// poi avviso della trascrizione automatica del parlato.
const AVVISO_TRASCRIZIONE = 'Le sue parole vengono trascritte automaticamente per poterle rispondere.';

const INTRO = {
  chiusa: `Benvenuto al Nazareth Residence, sono l'assistente virtuale. Al momento la reception è chiusa. ${AVVISO_TRASCRIZIONE} Come posso aiutarla?`,
  occupata: `Benvenuto al Nazareth Residence, sono l'assistente virtuale. Al momento la reception non è disponibile. ${AVVISO_TRASCRIZIONE} Come posso aiutarla?`,
  continua: 'Come posso aiutarla?',
};

const RICHIESTA_DOPO_SILENZIO = {
  chiusa: 'Mi scusi, non ho sentito. Come posso aiutarla?',
  occupata: 'Mi scusi, non ho sentito. Come posso aiutarla?',
  continua: 'È ancora in linea? Posso esserle utile in altro?',
};

const CONTATTI_PARLATI =
  'ci scriva su WhatsApp al tre quattro otto, nove zero cinque, quattro sette due tre, o all\'email info chiocciola nazarethresidence punto com.';

// Messaggi di chiusura: brevi, sempre con i contatti e un saluto finale.
const MESSAGGIO_RIPIEGO = `Mi scusi, ora non riesco a rispondere: ${CONTATTI_PARLATI} Grazie, arrivederci.`;
const MESSAGGIO_LIMITE_TURNI = `Per altre informazioni ${CONTATTI_PARLATI} Grazie, arrivederci.`;
const MESSAGGIO_NESSUNA_RISPOSTA = 'Non ho ricevuto risposta. La invitiamo a richiamare più tardi. Arrivederci.';
// Detto mentre si verificano prezzi e disponibilità, per non superare i tempi del provider.
const MESSAGGIO_ATTESA_VERIFICA = 'Un attimo, controllo la disponibilità.';
const MESSAGGIO_RIPETA = 'Mi scusi, può ripetere la domanda?';

module.exports = {
  INTRO,
  RICHIESTA_DOPO_SILENZIO,
  MESSAGGIO_RIPIEGO,
  MESSAGGIO_LIMITE_TURNI,
  MESSAGGIO_NESSUNA_RISPOSTA,
  MESSAGGIO_ATTESA_VERIFICA,
  MESSAGGIO_RIPETA,
};
