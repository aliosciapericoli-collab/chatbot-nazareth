// Linea demo di Vocalba: un numero pubblico, separato da quello del cliente, per far provare
// il receptionist virtuale a chi visita alioscia.it/vocalba.
// Risponde per una struttura dimostrativa dichiarata come tale: nessun dato di clienti veri,
// nessun prezzo reale, nessuna email alla reception, nessun archivio né statistica del cliente.
const { formatInTimeZone } = require('date-fns-tz');
const { it: localeIt } = require('date-fns/locale');
const { creaAssistente, importiInEuro } = require('../claude');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Rome';
const FINE_CONVERSAZIONE = '[FINE]';

const CONTATTI_DEMO = 'scriva dal sito alioscia punto it, pagina contatti, oppure all\'email info chiocciola alioscia punto it.';

// Base di conoscenza della struttura dimostrativa. Tutti i dati sono d'esempio.
const CONOSCENZA_DEMO = `
# Casa Aurora, struttura dimostrativa di Vocalba
Casa Aurora NON esiste: è un esempio inventato per far provare Vocalba. I dati qui sotto servono solo a mostrare come risponde il receptionist virtuale.

## La struttura
- Piccola casa per ferie di esempio con 12 camere in un borgo storico dell'Italia centrale.
- Camere singole, doppie, triple e familiari, tutte con bagno privato, aria condizionata e wifi gratuito.
- Colazione a buffet inclusa, dalle 7:30 alle 10:00, con opzioni senza glutine su richiesta.

## Orari
- Check-in dalle 15:00 alle 20:00. Arrivo più tardi: va comunicato prima; c'è il self check-in con codice.
- Check-out entro le 10:00. Deposito bagagli gratuito il giorno della partenza.
- Reception aperta dalle 7:00 alle 20:00; di notte risponde il receptionist virtuale.

## Servizi e regole
- Parcheggio privato gratuito per le auto, fino a esaurimento posti; niente pullman.
- Animali di piccola taglia ammessi su richiesta, con un supplemento di 10 euro a notte.
- Non si fuma in tutta la struttura.
- Tassa di soggiorno di esempio: 2 euro a persona a notte, per al massimo cinque notti.
- Cancellazione gratuita fino a 48 ore prima dell'arrivo, salvo tariffe non rimborsabili.
- Gruppi oltre le quattro camere: preventivo su misura dalla reception.

## Prezzi e disponibilità
- In questa demo non ci sono prezzi né disponibilità reali. Nella versione vera per una struttura, Vocalba legge in tempo reale camere libere e prezzi dal motore di prenotazione del sito, e non dice mai una cifra che non arrivi da lì.

## Su Vocalba (se il chiamante chiede del servizio)
- Vocalba è un receptionist virtuale costruito su misura da Alioscia per strutture ricettive e altre attività: risponde quando la reception è chiusa o occupata, dà solo informazioni verificate, legge prezzi e disponibilità in tempo reale e lascia alla reception le richieste di richiamata via email, con una dashboard sul telefono.
- Per informazioni, costi o per averlo nella propria attività: ${CONTATTI_DEMO}
`;

const IMPORTI_DEMO = new Set(importiInEuro(CONOSCENZA_DEMO));

const PROMPT_DEMO = `Sei il receptionist virtuale di una linea DEMO di Vocalba e rispondi al telefono per "Casa Aurora", una struttura dimostrativa che non esiste. Parli in italiano con chi sta provando il servizio.

Regole:
- Rispondi solo con le informazioni della base di conoscenza qui sotto. Se una cosa non c'è, dillo con semplicità e, se serve, ricorda che è una demo. Non inventare mai orari, prezzi, disponibilità o servizi.
- Se chiedono prezzi o disponibilità per delle date, spiega che in questa demo non ci sono prezzi reali e che nella versione vera Vocalba li legge in tempo reale dal motore di prenotazione della struttura.
- Non prendere prenotazioni, non raccogliere nomi, numeri di telefono o altri dati personali e non promettere richiamate. Se il chiamante vuole Vocalba per la sua attività, dagli i contatti di Alioscia.
- Frasi brevi, adatte a essere ascoltate al telefono: al massimo tre frasi per risposta, niente elenchi, niente simboli. Scrivi i numeri come si pronunciano quando serve chiarezza.
- Dai sempre del lei, con cortesia. Per offrire altro aiuto usa esattamente "Posso esserle utile in altro?". Mai "Può essere utile in altro?".
- Se il chiamante saluta, ringrazia per chiudere o dice che non gli serve altro, congedalo con un saluto esplicito, per esempio "Grazie per aver provato Vocalba, arrivederci", e termina la risposta con ${FINE_CONVERSAZIONE}. Non usare ${FINE_CONVERSAZIONE} in nessun altro caso.
- Se la frase è incomprensibile o sembra trascritta male, chiedi gentilmente di ripetere.

<base_di_conoscenza>
${CONOSCENZA_DEMO}
</base_di_conoscenza>`;

function sistemaDemo({ adesso = Date.now() } = {}) {
  const oggi = new Date(adesso);
  return `${PROMPT_DEMO}\n\n<dati_chiamata>\nOggi è ${formatInTimeZone(oggi, TIMEZONE, 'EEEE d MMMM yyyy', { locale: localeIt })}, ore ${formatInTimeZone(oggi, TIMEZONE, 'HH:mm')} ora di Roma.\n</dati_chiamata>`;
}

const AVVISO = 'Sono un assistente virtuale e le sue parole vengono trascritte automaticamente per poterle rispondere.';

// Testi fissi del centralino per la linea demo: nessun contatto del cliente vero.
const MESSAGGI_DEMO = {
  INTRO: {
    chiusa: `Benvenuto nella demo di Vocalba, il receptionist virtuale. ${AVVISO} Faccia finta di chiamare Casa Aurora, una piccola struttura di esempio, e mi chieda quello che chiederebbe a una reception di notte. Come posso aiutarla?`,
    occupata: `Benvenuto nella demo di Vocalba, il receptionist virtuale. ${AVVISO} Come posso aiutarla?`,
    continua: 'Come posso aiutarla?',
  },
  MESSAGGIO_RIPIEGO: `Mi scusi, ora non riesco a rispondere. Per conoscere Vocalba ${CONTATTI_DEMO} Grazie, arrivederci.`,
  MESSAGGIO_LIMITE_TURNI: `La demo finisce qui. Per portare Vocalba nella sua attività ${CONTATTI_DEMO} Grazie, arrivederci.`,
  MESSAGGIO_PREZZO_NON_VERIFICATO: 'In questa demo non ci sono prezzi reali: nella versione vera li leggo in tempo reale dal motore di prenotazione della struttura. Posso esserle utile in altro?',
};

function creaAssistenteDemo(opzioni = {}) {
  return creaAssistente({
    ...opzioni,
    strumenti: [],
    sistema: sistemaDemo,
    importiConsentiti: IMPORTI_DEMO,
    messaggioPrezzoNonVerificato: MESSAGGI_DEMO.MESSAGGIO_PREZZO_NON_VERIFICATO,
  });
}

// Confronto tra numeri ignorando spazi e simboli.
function stessoNumero(a, b) {
  const cifre = (n) => String(n ?? '').replace(/[^\d]/g, '');
  return Boolean(cifre(a)) && cifre(a) === cifre(b);
}

module.exports = { creaAssistenteDemo, MESSAGGI_DEMO, CONOSCENZA_DEMO, PROMPT_DEMO, sistemaDemo, stessoNumero };
