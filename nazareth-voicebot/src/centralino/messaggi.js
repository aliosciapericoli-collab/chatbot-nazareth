// Testi fissi letti dal centralino.

// Prima frase: dichiarazione che risponde un assistente virtuale (art. 50 AI Act),
// poi avviso della trascrizione automatica del parlato.
const AVVISO_TRASCRIZIONE = 'Le sue parole vengono trascritte automaticamente per poterle rispondere.';

// Giorni di conservazione detti a voce; per altri valori si resta generici.
const GIORNI_A_PAROLE = { 7: 'sette', 15: 'quindici', 30: 'trenta', 60: 'sessanta', 90: 'novanta', 180: 'centottanta', 365: 'trecentosessantacinque' };

// Con l'archivio attivo il chiamante sa anche che la conversazione viene conservata, e per quanto.
function avvisoTrascrizione(giorniConservazione = 0) {
  if (!giorniConservazione) return AVVISO_TRASCRIZIONE;
  const periodo = GIORNI_A_PAROLE[giorniConservazione] ? `per ${GIORNI_A_PAROLE[giorniConservazione]} giorni` : 'per un periodo limitato';
  return `Le sue parole vengono trascritte automaticamente per poterle rispondere, e la conversazione viene conservata ${periodo}.`;
}

function creaIntro(giorniConservazione = 0) {
  const avviso = avvisoTrascrizione(giorniConservazione);
  return {
    chiusa: `Benvenuto al Nazareth Residence, sono l'assistente virtuale. Al momento la reception è chiusa. ${avviso} Come posso aiutarla?`,
    occupata: `Benvenuto al Nazareth Residence, sono l'assistente virtuale. Al momento la reception non è disponibile. ${avviso} Come posso aiutarla?`,
    continua: 'Come posso aiutarla?',
  };
}

const INTRO = creaIntro();

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
  creaIntro,
  RICHIESTA_DOPO_SILENZIO,
  MESSAGGIO_RIPIEGO,
  MESSAGGIO_LIMITE_TURNI,
  MESSAGGIO_NESSUNA_RISPOSTA,
  MESSAGGIO_ATTESA_VERIFICA,
  MESSAGGIO_RIPETA,
};
