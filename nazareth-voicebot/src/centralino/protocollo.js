// Protocollo neutro tra il centralino e i provider telefonici.
//
// Il centralino riceve EVENTI e restituisce una lista di AZIONI. Non sa nulla di
// Twilio, TwiML, URL o firme: tutto questo è compito dell'adattatore del provider
// (src/provider/*), che traduce le richieste del provider in eventi e le azioni
// nel formato del provider.

/**
 * Eventi che l'adattatore consegna al centralino.
 *
 * @typedef {{ tipo: 'chiamata_in_arrivo', chiamataId: string }} EventoChiamataInArrivo
 * @typedef {{ tipo: 'esito_inoltro', chiamataId: string, esito: EsitoInoltro }} EventoEsitoInoltro
 * @typedef {{ tipo: 'parlato', chiamataId: string, testo: string, numeroChiamante?: string|null }} EventoParlato
 *   numeroChiamante: numero da cui arriva la chiamata (E.164), se il provider lo fornisce
 * @typedef {{ tipo: 'silenzio', chiamataId: string, contesto: ContestoAscolto }} EventoSilenzio
 * @typedef {{ tipo: 'prosegui', chiamataId: string, contesto: { motivo: string } }} EventoProsegui
 * @typedef {EventoChiamataInArrivo | EventoEsitoInoltro | EventoParlato | EventoSilenzio | EventoProsegui} Evento
 *
 * @typedef {'risposto' | 'occupato' | 'nessuna_risposta' | 'fallito' | 'annullato'} EsitoInoltro
 *
 * Dati opachi che l'adattatore deve restituire identici nell'evento `silenzio`.
 * Contiene solo stringhe e numeri, così si può passare in una query string.
 * @typedef {{ motivo: string, tentativo: number }} ContestoAscolto
 */

/**
 * Azioni che il centralino chiede all'adattatore di eseguire, in ordine.
 *
 * - parla: legge `testo` con la sintesi vocale nella `lingua` indicata.
 * - ascolta: ascolta il chiamante; se parla, l'adattatore invia un evento `parlato`,
 *   se resta in silenzio invia un evento `silenzio` con lo stesso `contesto`.
 *   Deve essere l'ultima azione della lista.
 * - inoltra: trasferisce la chiamata a `numero` (E.164) per `squilloSec` secondi;
 *   alla fine l'adattatore invia un evento `esito_inoltro`. Ultima azione della lista.
 * - prosegui: l'adattatore invia subito un evento `prosegui` con lo stesso `contesto`,
 *   dopo aver eseguito le azioni precedenti (serve a spezzare un'elaborazione lunga in due
 *   richieste del provider). Ultima azione della lista.
 * - riaggancia: chiude la chiamata. Ultima azione della lista.
 *
 * @typedef {{ tipo: 'parla', testo: string, lingua: string }} AzioneParla
 * @typedef {{ tipo: 'ascolta', lingua: string, contesto: ContestoAscolto }} AzioneAscolta
 * @typedef {{ tipo: 'inoltra', numero: string, squilloSec: number }} AzioneInoltra
 * @typedef {{ tipo: 'riaggancia' }} AzioneRiaggancia
 * @typedef {{ tipo: 'prosegui', contesto: { motivo: string } }} AzioneProsegui
 * @typedef {AzioneParla | AzioneAscolta | AzioneInoltra | AzioneRiaggancia | AzioneProsegui} Azione
 */

const TIPI_EVENTO = ['chiamata_in_arrivo', 'esito_inoltro', 'parlato', 'silenzio', 'prosegui'];
const ESITI_INOLTRO = ['risposto', 'occupato', 'nessuna_risposta', 'fallito', 'annullato'];
const AZIONI_FINALI = new Set(['ascolta', 'inoltra', 'riaggancia', 'prosegui']);

const azioni = {
  parla: (testo, lingua) => ({ tipo: 'parla', testo, lingua }),
  ascolta: (lingua, contesto) => ({ tipo: 'ascolta', lingua, contesto }),
  inoltra: (numero, squilloSec) => ({ tipo: 'inoltra', numero, squilloSec }),
  riaggancia: () => ({ tipo: 'riaggancia' }),
  prosegui: (contesto) => ({ tipo: 'prosegui', contesto }),
};

// Controlla che la lista rispetti il protocollo: usata nei test e dagli adattatori.
function verificaAzioni(lista) {
  if (!Array.isArray(lista) || lista.length === 0) {
    throw new Error('Il centralino deve restituire almeno un\'azione');
  }
  lista.forEach((azione, i) => {
    if (!['parla', 'ascolta', 'inoltra', 'riaggancia', 'prosegui'].includes(azione.tipo)) {
      throw new Error(`Azione sconosciuta: ${azione.tipo}`);
    }
    if (AZIONI_FINALI.has(azione.tipo) && i !== lista.length - 1) {
      throw new Error(`L'azione ${azione.tipo} deve essere l'ultima`);
    }
  });
  if (!AZIONI_FINALI.has(lista.at(-1).tipo)) {
    throw new Error('La lista deve finire con ascolta, inoltra, riaggancia o prosegui');
  }
  return lista;
}

module.exports = { azioni, verificaAzioni, TIPI_EVENTO, ESITI_INOLTRO };
