// Numeri di telefono: lettura a voce a gruppi di cifre e controllo del numero del chiamante.

const CIFRE = ['zero', 'uno', 'due', 'tre', 'quattro', 'cinque', 'sei', 'sette', 'otto', 'nove'];
// Valori che i provider usano quando il numero è nascosto o non è un telefono.
const NON_NUMERI = /^(anonymous|restricted|unknown|private|unavailable|client:|sip:)/i;

function soloCifre(numero) {
  return String(numero ?? '').replace(/\D/g, '');
}

// Gruppi da tre cifre; un'ultima cifra isolata si unisce al gruppo precedente.
function gruppi(cifre) {
  const g = cifre.match(/\d{1,3}/g) ?? [];
  if (g.length > 1 && g.at(-1).length === 1) g.splice(-2, 2, g.at(-2) + g.at(-1));
  return g;
}

/**
 * Numero scritto a parole per la sintesi vocale, a gruppi di cifre.
 * I numeri italiani (+39) si leggono senza prefisso internazionale.
 * "+393331234567" → "tre tre tre, uno due tre, quattro cinque sei sette"
 */
function leggiNumero(numero) {
  const testo = String(numero ?? '').trim();
  let cifre = soloCifre(testo);
  let prefisso = '';
  if (testo.startsWith('+39') || (testo.startsWith('0039'))) {
    cifre = cifre.replace(/^(00)?39/, '');
  } else if (testo.startsWith('+') || testo.startsWith('00')) {
    cifre = cifre.replace(/^00/, '');
    prefisso = 'più ';
  }
  return prefisso + gruppi(cifre).map((g) => [...g].map((c) => CIFRE[c]).join(' ')).join(', ');
}

/**
 * Il numero del chiamante si può proporre come recapito solo se è un vero numero
 * e non è uno dei numeri della struttura (per esempio quando il trasferimento di
 * chiamata presenta il numero della reception invece di quello del cliente).
 */
function numeroProponibile(numero, esclusi = []) {
  if (!numero || NON_NUMERI.test(String(numero).trim())) return false;
  const cifre = soloCifre(numero);
  if (cifre.length < 6) return false;
  return !esclusi.some((e) => {
    const c = soloCifre(e);
    return c && (cifre.endsWith(c) || c.endsWith(cifre));
  });
}

// Numero da mostrare nell'email: con "+" e cifre, senza altri caratteri.
function normalizzaNumero(numero) {
  const testo = String(numero ?? '').trim();
  const cifre = soloCifre(testo);
  if (cifre.length < 6) return null;
  return testo.startsWith('+') ? `+${cifre}` : cifre;
}

module.exports = { leggiNumero, numeroProponibile, normalizzaNumero, soloCifre };
