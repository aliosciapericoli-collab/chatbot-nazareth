// Script della dashboard: legge /dashboard/api/stato e disegna la pagina.
// Tutto il testo passa da textContent: nessun HTML dai dati.
(function () {
  'use strict';

  const INTERVALLO_MS = 30000;
  const TZ = 'Europe/Rome';
  const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtOraSec = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtData = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const SVG = 'http://www.w3.org/2000/svg';

  const ESITI = {
    congedo: { etichetta: 'Conclusa con saluto', classe: 'good', icona: '✓' },
    reception: { etichetta: 'Risposta dalla reception', classe: 'good', icona: '✓' },
    in_corso: { etichetta: 'In corso', classe: 'info', icona: '•' },
    silenzio: { etichetta: 'Chiusa per silenzio', classe: 'warning', icona: '!' },
    limite_turni: { etichetta: 'Limite di domande', classe: 'warning', icona: '!' },
    chiusa_dal_chiamante: { etichetta: 'Riagganciata dal chiamante', classe: 'neutral', icona: '–' },
    annullata: { etichetta: 'Annullata', classe: 'neutral', icona: '–' },
    ripiego: { etichetta: 'Messaggio di ripiego (errore)', classe: 'critical', icona: '✕' },
  };
  // Stati della richiamata, mostrati con lo stesso stile degli esiti.
  Object.assign(ESITI, {
    richiamata_in_invio: { etichetta: 'In invio', classe: 'info', icona: '•' },
    richiamata_inviata: { etichetta: 'Email inviata', classe: 'good', icona: '✓' },
    richiamata_non_inviata: { etichetta: 'Email NON inviata', classe: 'critical', icona: '✕' },
  });
  const RICHIAMATE = {
    in_invio: 'richiamata_in_invio',
    email_inviata: 'richiamata_inviata',
    email_non_inviata: 'richiamata_non_inviata',
  };
  const INGRESSI = {
    reception_chiusa: 'Reception chiusa',
    reception_non_disponibile: 'Reception non disponibile',
    inoltro_reception: 'Inoltrata alla reception',
  };

  function el(tag, attrs, figli) {
    const nodo = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') nodo.textContent = v;
      else if (k === 'class') nodo.className = v;
      else nodo.setAttribute(k, v);
    }
    for (const f of [].concat(figli || [])) if (f) nodo.append(f);
    return nodo;
  }

  function svg(tag, attrs) {
    const nodo = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) nodo.setAttribute(k, v);
    return nodo;
  }

  function secondi(ms) {
    return ms == null ? '—' : `${(ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} s`;
  }

  function badge(chiave) {
    const e = ESITI[chiave] || { etichetta: chiave || '—', classe: 'neutral', icona: '–' };
    return el('span', { class: `badge ${e.classe}` }, [el('span', { class: 'icona', 'aria-hidden': 'true', text: e.icona }), e.etichetta]);
  }

  function tabella(intestazioni, righe, vuoto) {
    if (!righe.length) return el('div', { class: 'vuoto', text: vuoto });
    return el('table', {}, [
      el('thead', {}, el('tr', {}, intestazioni.map((h) => el('th', { text: h })))),
      el('tbody', {}, righe.map((r) => el('tr', {}, r.map((c) => el('td', {}, c instanceof Node ? c : String(c)))))),
    ]);
  }

  function sostituisci(id, contenuto) {
    document.getElementById(id).replaceChildren(...[].concat(contenuto));
  }

  function tile(etichetta, valore, sotto) {
    return el('div', { class: 'card tile' }, [
      el('div', { class: 'label', text: etichetta }),
      el('div', { class: 'value', text: valore }),
      sotto ? el('div', { class: 'sub', text: sotto }) : null,
    ]);
  }

  function pill(testo, colore) {
    const dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
    if (colore) dot.style.background = `var(${colore})`;
    return el('span', { class: 'pill' }, [dot, testo]);
  }

  // Barre verticali con angoli superiori arrotondati e base piatta sull'asse.
  function percorsoBarra(x, y, w, h, r) {
    const raggio = Math.min(r, w / 2, h);
    return `M${x},${y + h}V${y + raggio}Q${x},${y} ${x + raggio},${y}H${x + w - raggio}Q${x + w},${y} ${x + w},${y + raggio}V${y + h}Z`;
  }

  function disegnaGrafico(perOra) {
    const contenitore = document.getElementById('grafico');
    const W = 640, H = 220, sx = 28, dx = 4, alto = 12, basso = 24;
    const larghezza = W - sx - dx, altezza = H - alto - basso;
    const massimo = Math.max(1, ...perOra.map((p) => p.chiamate));
    const passo = massimo <= 5 ? 1 : Math.ceil(massimo / 4);
    const scalaMax = Math.ceil(massimo / passo) * passo;
    const slot = larghezza / 24, gap = 2, w = slot - gap;

    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    for (let v = 0; v <= scalaMax; v += passo) {
      const y = alto + altezza - (v / scalaMax) * altezza;
      s.append(svg('line', { class: 'gridline', x1: sx, x2: W - dx, y1: y, y2: y }));
      const t = svg('text', { class: 'axis', x: sx - 6, y: y + 4, 'text-anchor': 'end' });
      t.textContent = v;
      s.append(t);
    }

    const tooltip = el('div', { class: 'tooltip' });
    perOra.forEach((p, i) => {
      const x = sx + i * slot + gap / 2;
      const h = (p.chiamate / scalaMax) * altezza;
      const hit = svg('rect', { class: 'hit', x: sx + i * slot, y: alto, width: slot, height: altezza });
      const barra = h > 0 ? svg('path', { class: 'bar', d: percorsoBarra(x, alto + altezza - h, w, h, 4) }) : null;
      const mostra = () => {
        tooltip.textContent = `${String(p.ora).padStart(2, '0')}:00–${String(p.ora).padStart(2, '0')}:59 · ${p.chiamate} ${p.chiamate === 1 ? 'chiamata' : 'chiamate'}`;
        const box = contenitore.getBoundingClientRect();
        tooltip.style.left = `${((sx + i * slot + slot / 2) / W) * box.width}px`;
        tooltip.style.top = `${((alto + altezza - h) / H) * box.height - 6}px`;
        tooltip.style.display = 'block';
        if (barra) barra.classList.add('attiva');
      };
      const nascondi = () => {
        tooltip.style.display = 'none';
        if (barra) barra.classList.remove('attiva');
      };
      hit.addEventListener('mouseenter', mostra);
      hit.addEventListener('mouseleave', nascondi);
      s.append(hit);
      if (barra) s.append(barra);
      if (p.ora % 3 === 0) {
        const t = svg('text', { class: 'axis', x: sx + i * slot + slot / 2, y: H - 6, 'text-anchor': 'middle' });
        t.textContent = String(p.ora).padStart(2, '0');
        s.append(t);
      }
    });
    contenitore.replaceChildren(s, tooltip);
  }

  function disegna({ configurazione: c, metriche: m, twilio: t }) {
    const o = m.oggi;

    sostituisci('pills', [
      pill('Online', '--good'),
      pill(`Reception ${c.receptionAdesso}${c.receptionMode !== 'auto' ? ` (forzata: ${c.receptionMode})` : ''}`, c.receptionAdesso === 'aperta' ? '--good' : '--neutral'),
      pill(c.inoltroReception ? 'Il bot inoltra alla reception' : 'Reception provata prima del bot'),
    ]);
    document.getElementById('aggiornato').textContent =
      `Aggiornato alle ${fmtOraSec.format(new Date(m.generatoIl))} · metriche dal ${fmtData.format(new Date(m.datiDal))}`;

    const tiles = [
      tile('Chiamate oggi', o.chiamate, o.conAssistente !== o.chiamate ? `${o.conAssistente} con l'assistente` : null),
      tile('Domande a Claude', o.domande, o.conAssistente ? `${(o.domande / o.conAssistente).toLocaleString('it-IT', { maximumFractionDigits: 1 })} per chiamata` : null),
      tile('Tempo di risposta', secondi(o.latenzaMediaMs), o.latenzaP95Ms != null ? `95% entro ${secondi(o.latenzaP95Ms)}` : 'media di oggi'),
      tile('Risposte di ripiego', o.esiti.ripiego, o.esiti.ripiego ? 'errori o timeout: vedi sotto' : 'nessun errore oggi'),
    ];
    const rc = o.richiamate;
    tiles.push(tile('Richiamate richieste', rc.richieste,
      rc.emailNonInviate ? `${rc.emailNonInviate} email NON inviate: vedi errori` : c.emailRichiamata ? `email a ${c.emailRichiamata}` : 'email non configurata'));
    if (c.inoltroReception) tiles.push(tile('Inoltrate alla reception', o.inoltrateReception));
    sostituisci('tiles', tiles);

    disegnaGrafico(o.perOra);

    sostituisci('esiti', Object.keys(ESITI)
      .filter((k) => k in o.esiti)
      .map((k) => el('li', {}, [badge(k), el('span', { class: 'num', text: o.esiti[k] })])));

    sostituisci('chiamate', tabella(
      ['Ora', 'Chiamata', 'Ingresso', 'Domande', 'Risposta media', 'Esito', 'Richiamata'],
      m.ultimeChiamate.map((r) => [fmtData.format(new Date(r.inizio)), r.id, INGRESSI[r.ingresso] || '—', r.domande, secondi(r.latenzaMediaMs), badge(r.esito), RICHIAMATE[r.richiamata] ? badge(RICHIAMATE[r.richiamata]) : '—']),
      'Nessuna chiamata dal riavvio del server.'
    ));

    if (!t.disponibile) {
      document.getElementById('twilio-totali').textContent = '';
      sostituisci('twilio', el('div', { class: 'vuoto', text: 'Credenziali Twilio non configurate.' }));
    } else if (t.errore) {
      document.getElementById('twilio-totali').textContent = '';
      sostituisci('twilio', el('div', { class: 'avviso', text: `Registro Twilio non disponibile: ${t.errore}` }));
    } else {
      const costo = t.totale.valuta ? ` · costo Twilio ${t.totale.costo.toLocaleString('it-IT', { maximumFractionDigits: 2 })} ${t.totale.valuta}` : '';
      document.getElementById('twilio-totali').textContent = `ultime ${t.totale.chiamate} chiamate · ${t.totale.minuti} min${costo}`;
      sostituisci('twilio', tabella(
        ['Inizio', 'Da', 'Durata', 'Stato', 'Direzione', 'Costo'],
        t.chiamate.map((x) => [
          x.inizio ? fmtData.format(new Date(x.inizio)) : '—',
          x.da,
          `${Math.floor(x.durataSec / 60)}:${String(x.durataSec % 60).padStart(2, '0')}`,
          x.stato,
          x.direzione,
          x.costo == null ? '—' : `${x.costo.toLocaleString('it-IT', { maximumFractionDigits: 4 })} ${x.valuta || ''}`,
        ]),
        'Nessuna chiamata nel registro Twilio.'
      ));
    }

    sostituisci('errori', tabella(
      ['Ora', 'Chiamata', 'Tipo', 'Dettaglio'],
      m.errori.map((e) => [fmtOra.format(new Date(e.ts)), e.chiamata, e.status ? `${e.tipo} ${e.status}` : e.tipo, e.messaggio || '']),
      'Nessun errore dal riavvio del server.'
    ));

    const righe = [
      ['Provider', c.provider],
      ['Modello Claude', c.modello || '—'],
      ['Email richiamate', c.emailRichiamata || 'non configurata'],
      ['Prezzi WuBook', c.disponibilitaWuBook ? 'attivi' : 'disattivati'],
      ['Voce', c.voce],
      ['Timeout Claude', secondi(c.timeoutClaudeMs)],
      ['Domande massime', c.maxTurni],
      ['Orario reception', c.receptionMode === 'auto' ? '07:00–19:59 (automatico)' : `forzato: ${c.receptionMode}`],
      ['Versione', c.versione || '—'],
    ];
    sostituisci('config', righe.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]));
  }

  async function aggiorna() {
    try {
      const risposta = await fetch('/dashboard/api/stato', { cache: 'no-store', credentials: 'same-origin' });
      if (!risposta.ok) throw new Error(`HTTP ${risposta.status}`);
      disegna(await risposta.json());
    } catch (error) {
      document.getElementById('aggiornato').textContent = `Aggiornamento non riuscito (${error.message}). Nuovo tentativo tra 30 secondi.`;
    }
  }

  aggiorna();
  setInterval(aggiorna, INTERVALLO_MS);
})();
