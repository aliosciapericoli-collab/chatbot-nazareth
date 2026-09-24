// Argomenti delle domande dei clienti, per le statistiche della dashboard.
// Si conserva solo l'argomento, mai il testo della domanda.

const ARGOMENTI = [
  { id: 'prezzi', nome: 'Prezzi e disponibilità', parole: /prezz|cost[ao]|tariff|disponibil|liber[ae]|preventiv|quanto (viene|si paga)|camer[ae] per|notti?\b|weekend|fine settimana/ },
  { id: 'prenotazione', nome: 'Prenotazioni e cancellazioni', parole: /prenot|disdir|disdett|cancell|rimbors|caparr|modific/ },
  { id: 'checkin', nome: 'Check-in, check-out e orari', parole: /check.?in|check.?out|arriv|partenz|tardi|self|chiav/ },
  { id: 'arrivo', nome: 'Come arrivare e parcheggio', parole: /parchegg|auto|macchina|ztl|treno|stazion|autobus|bus|indirizz|dove (siete|si trova)|come (arriv|si arriva)/ },
  { id: 'colazione', nome: 'Colazione e ristoranti', parole: /colazion|pranz|cena|ristorant|mangiar|pasti|pranzo al sacco/ },
  { id: 'animali', nome: 'Animali', parole: /can[ei]\b|cagnol|gatt|animal/ },
  { id: 'gruppi', nome: 'Gruppi, eventi e ritiri', parole: /grupp|ritir|parrocch|convegn|sala|meeting|event|catering|matrimon|cerimon/ },
  { id: 'cammini', nome: 'Pellegrini, bici e studenti', parole: /francigena|pellegrin|credenzial|bici|cicl|unitus|universit|student/ },
  { id: 'servizi', nome: 'Servizi della struttura', parole: /wi.?fi|internet|aria condizionata|ascensor|lavanderi|fum|tass[ae]|terme|parco|chiesa|cappella/ },
  { id: 'persona', nome: 'Parlare con una persona', parole: /operator|person[ae] (vera|reale)|parlare con|reception|richiam|ricontatt/ },
];

const ALTRO = { id: 'altro', nome: 'Altro' };

/** Argomenti di una domanda: lista di id (almeno uno, "altro" se non riconosciuta). */
function classificaDomanda(testo) {
  const t = String(testo ?? '').toLowerCase();
  const trovati = ARGOMENTI.filter((a) => a.parole.test(t)).map((a) => a.id);
  return trovati.length ? trovati : [ALTRO.id];
}

const NOMI_ARGOMENTI = Object.fromEntries([...ARGOMENTI, ALTRO].map((a) => [a.id, a.nome]));

module.exports = { classificaDomanda, NOMI_ARGOMENTI };
