// Script della dashboard: legge /dashboard/api/stato e disegna la pagina.
// Tutto il testo passa da textContent: nessun HTML dai dati.
(function () {
  'use strict';

  const INTERVALLO_MS = 30000;
  const TZ = 'Europe/Rome';
  const SVG = 'http://www.w3.org/2000/svg';
  const fmtOra = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtOraSec = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtGiorno = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: 'numeric', month: 'short' });
  const fmtGiornoSettimana = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, weekday: 'short' });
  const fmtData = new Intl.DateTimeFormat('it-IT', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const fmtEuro = new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
  const oraRoma = () => Number(new Intl.DateTimeFormat('it-IT', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  const giornoRoma = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(d);

  const ESITI = {
    congedo: { etichetta: 'Conclusa con saluto', classe: 'good', icona: '✓' },
    reception: { etichetta: 'Passata alla reception', classe: 'good', icona: '✓' },
    in_corso: { etichetta: 'In corso', classe: 'info', icona: '•' },
    silenzio: { etichetta: 'Nessuna risposta', classe: 'warning', icona: '!' },
    limite_turni: { etichetta: 'Troppe domande', classe: 'warning', icona: '!' },
    chiusa_dal_chiamante: { etichetta: 'Ha riagganciato', classe: 'neutral', icona: '–' },
    annullata: { etichetta: 'Annullata', classe: 'neutral', icona: '–' },
    ripiego: { etichetta: 'Errore, dati i contatti', classe: 'critical', icona: '✕' },
  };
  const RICHIAMATE = {
    in_invio: { etichetta: 'Richiamata in invio', classe: 'info', icona: '•' },
    email_inviata: { etichetta: 'Richiamata inviata', classe: 'good', icona: '✓' },
    email_non_inviata: { etichetta: 'Richiamata NON inviata', classe: 'critical', icona: '✕' },
  };
  const INGRESSI = {
    reception_chiusa: 'Reception chiusa',
    reception_non_disponibile: 'Reception non disponibile',
    inoltro_reception: 'Passata alla reception',
  };
  const SERVIZI = [
    ['claude', 'Assistente vocale', 'Risposte ai clienti'],
    ['wubook', 'Prezzi e disponibilità', 'Motore di prenotazione'],
    ['email', 'Email di richiamata', 'Messaggi alla reception'],
  ];

  function el(tag, attrs, figli) {
    const nodo = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (k === 'text') nodo.textContent = v;
      else if (k === 'class') nodo.className = v;
      else nodo.setAttribute(k, v);
    }
    for (const f of [].concat(figli || [])) if (f !== null && f !== undefined && f !== false) nodo.append(f);
    return nodo;
  }

  function svg(tag, attrs) {
    const nodo = document.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs || {})) nodo.setAttribute(k, v);
    return nodo;
  }

  const sostituisci = (id, contenuto) => document.getElementById(id).replaceChildren(...[].concat(contenuto));
  const testo = (id, t) => { document.getElementById(id).textContent = t; };
  const plurale = (n, uno, molti) => `${n} ${n === 1 ? uno : molti}`;
  const secondi = (ms) => (ms == null ? '—' : `${(ms / 1000).toLocaleString('it-IT', { maximumFractionDigits: 1 })} s`);

  function badge(def) {
    const d = def || { etichetta: '—', classe: 'neutral', icona: '–' };
    return el('span', { class: `badge ${d.classe}` }, [el('span', { class: 'icona', 'aria-hidden': 'true', text: d.icona }), d.etichetta]);
  }

  // Icone delle schede (tratti in stile lucide), disegnate con nodi SVG e non con HTML.
  const SIMBOLI = {
    telefono: ['M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8 9.8a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z'],
    euro: ['M4 10h12', 'M4 14h9', 'M19 6a7.7 7.7 0 0 0-5.2-2A7.9 7.9 0 0 0 6 12c0 4.4 3.5 8 7.8 8 2 0 3.8-.8 5.2-2'],
    richiamata: ['M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9', 'M10.3 21a1.94 1.94 0 0 0 3.4 0'],
    tempo: ['M12 6v6l4 2', 'M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0z'],
  };

  function simbolo(nome) {
    const s = svg('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' });
    for (const d of SIMBOLI[nome] || []) s.append(svg('path', { d }));
    return el('span', { class: 'simbolo' }, s);
  }

  function tile(etichetta, valore, nota, allarme, icona) {
    return el('div', { class: `card tile${allarme ? ' allarme' : ''}` }, [
      icona ? simbolo(icona) : null,
      el('div', { class: 'etichetta', text: etichetta }),
      el('div', { class: 'valore', text: valore }),
      nota ? el('div', { class: `nota${allarme ? ' allarme' : ''}`, text: nota }) : null,
    ]);
  }

  function saluto() {
    const h = oraRoma();
    if (h < 6) return 'Buonanotte';
    if (h < 13) return 'Buongiorno';
    if (h < 18) return 'Buon pomeriggio';
    return 'Buonasera';
  }

  // La giornata raccontata in una frase, per chi apre l'app dal telefono.
  function raccontaGiornata(marchio, o) {
    const gestite = o.conAssistente;
    if (!o.chiamate) {
      return {
        titolo: `Nelle ultime 24 ore ${marchio.app} non ha ricevuto chiamate.`,
        sotto: 'Quando la reception è chiusa o occupata risponde lei, a qualsiasi ora.',
      };
    }
    const titolo = `Nelle ultime 24 ore ${marchio.app} ha risposto a ${plurale(gestite, 'chiamata', 'chiamate')}` +
      (o.inoltrateReception ? `, ${plurale(o.inoltrateReception, 'passata', 'passate')} alla reception.` : '.');
    const parti = [];
    if (o.preventivi.chiamate) {
      parti.push(`${plurale(o.preventivi.chiamate, 'cliente ha', 'clienti hanno')} ricevuto un preventivo` +
        (o.preventivi.valoreEuro ? ` per un valore indicativo di ${fmtEuro.format(o.preventivi.valoreEuro)}` : ''));
    }
    if (o.richiamate.richieste) parti.push(`${plurale(o.richiamate.richieste, 'richiamata', 'richiamate')} da fare`);
    if (o.argomenti[0]) parti.push(`l'argomento più chiesto è «${o.argomenti[0].nome.toLowerCase()}»`);
    return { titolo, sotto: parti.length ? `${parti.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()) : '' };
  }

  function barreVerticali(contenitoreId, dati, { etichetta, valore, descrivi, ogni = 1 }) {
    const contenitore = document.getElementById(contenitoreId);
    const W = 640, H = 200, sx = 28, dx = 4, alto = 12, basso = 24;
    const larghezza = W - sx - dx, altezza = H - alto - basso;
    const massimo = Math.max(1, ...dati.map(valore));
    const passo = massimo <= 5 ? 1 : Math.ceil(massimo / 4);
    const scala = Math.ceil(massimo / passo) * passo;
    const slot = larghezza / dati.length, gap = 2, w = Math.max(2, slot - gap);
    const s = svg('svg', { viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });

    for (let v = 0; v <= scala; v += passo) {
      const y = alto + altezza - (v / scala) * altezza;
      s.append(svg('line', { class: 'linea', x1: sx, x2: W - dx, y1: y, y2: y }));
      const t = svg('text', { class: 'asse', x: sx - 6, y: y + 4, 'text-anchor': 'end' });
      t.textContent = v;
      s.append(t);
    }

    const suggerimento = el('div', { class: 'suggerimento' });
    dati.forEach((d, i) => {
      const x = sx + i * slot + gap / 2;
      const h = (valore(d) / scala) * altezza;
      const zona = svg('rect', { class: 'zona', x: sx + i * slot, y: alto, width: slot, height: altezza });
      let barra = null;
      if (h > 0) {
        const r = Math.min(4, w / 2, h);
        const y = alto + altezza - h;
        barra = svg('path', { class: 'barra', d: `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z` });
      }
      const mostra = () => {
        suggerimento.textContent = descrivi(d);
        const box = contenitore.getBoundingClientRect();
        suggerimento.style.display = 'block';
        // L'etichetta resta dentro il riquadro anche sulle prime e ultime barre.
        const meta = suggerimento.offsetWidth / 2;
        const x = ((sx + i * slot + slot / 2) / W) * box.width;
        suggerimento.style.left = `${Math.min(Math.max(x, meta), box.width - meta)}px`;
        suggerimento.style.top = `${((alto + altezza - h) / H) * box.height - 6}px`;
        if (barra) barra.classList.add('attiva');
      };
      const nascondi = () => {
        suggerimento.style.display = 'none';
        if (barra) barra.classList.remove('attiva');
      };
      zona.addEventListener('mouseenter', mostra);
      zona.addEventListener('mouseleave', nascondi);
      zona.addEventListener('touchstart', mostra, { passive: true });
      s.append(zona);
      if (barra) s.append(barra);
      if (i % ogni === 0) {
        const t = svg('text', { class: 'asse', x: sx + i * slot + slot / 2, y: H - 6, 'text-anchor': 'middle' });
        t.textContent = etichetta(d);
        s.append(t);
      }
    });
    contenitore.replaceChildren(s, suggerimento);
  }

  function disegnaArgomenti(argomenti) {
    if (!argomenti.length) return sostituisci('argomenti', el('div', { class: 'vuoto', text: 'Nessuna domanda nelle ultime 24 ore.' }));
    const massimo = Math.max(...argomenti.map((a) => a.chiamate));
    sostituisci('argomenti', el('ul', { class: 'argomenti' }, argomenti.slice(0, 7).map((a) => {
      const riempimento = el('span');
      riempimento.style.width = `${Math.max(4, (a.chiamate / massimo) * 100)}%`;
      return el('li', {}, [
        el('span', { text: a.nome }),
        el('span', { class: 'num', text: plurale(a.chiamate, 'chiamata', 'chiamate') }),
        el('div', { class: 'barra-arg', 'aria-hidden': 'true' }, riempimento),
      ]);
    })));
  }

  function disegnaChiamate(chiamate) {
    if (!chiamate.length) return sostituisci('chiamate', el('li', { class: 'vuoto', text: 'Nessuna chiamata dal riavvio del servizio.' }));
    sostituisci('chiamate', chiamate.slice(0, 12).map((c) => {
      const inizio = new Date(c.inizio);
      const oggi = giornoRoma(inizio) === giornoRoma(new Date());
      const chips = (c.argomenti || []).map((a) => el('span', { class: 'chip', text: a }));
      if (c.preventivo) chips.push(el('span', { class: 'chip euro', text: `Preventivo da ${fmtEuro.format(c.preventivo)}` }));
      return el('li', {}, [
        el('div', {}, [el('div', { class: 'ora', text: fmtOra.format(inizio) }), el('div', { class: 'data', text: oggi ? 'oggi' : fmtGiorno.format(inizio) })]),
        el('div', {}, [
          el('div', { class: 'titolo', text: INGRESSI[c.ingresso] || 'Chiamata' }),
          el('div', { class: 'dettagli', text: c.domande ? `${plurale(c.domande, 'risposta', 'risposte')} · in media ${secondi(c.latenzaMediaMs)}` : 'nessuna domanda' }),
          chips.length ? el('div', {}, chips) : null,
        ]),
        el('div', { class: 'colonna-destra' }, [badge(ESITI[c.esito]), c.richiamata ? badge(RICHIAMATE[c.richiamata]) : null]),
      ]);
    }));
  }

  function disegnaSalute(salute, configurazione) {
    const descrizioni = {
      ok: 'Funziona',
      problema: 'Problema nelle ultime ore: vedi errori',
      nessun_dato: 'Nessuna attività finora',
    };
    sostituisci('salute', SERVIZI.map(([id, nome, ruolo]) => {
      let s = salute[id] || { stato: 'nessun_dato' };
      if (id === 'wubook' && !configurazione.disponibilitaWuBook) s = { stato: 'spento' };
      if (id === 'email' && !configurazione.emailRichiamata) s = { stato: 'spento' };
      const testoStato = s.stato === 'spento' ? 'Disattivato' : descrizioni[s.stato];
      return el('li', {}, [
        el('span', { class: `punto ${s.stato === 'ok' ? 'ok' : s.stato === 'problema' ? 'problema' : ''}`, 'aria-hidden': 'true' }),
        el('div', {}, [el('div', { class: 'nome', text: `${nome} · ${testoStato}` }), el('div', { class: 'descrizione', text: ruolo })]),
      ]);
    }));
    const problemi = Object.values(salute).filter((s) => s.stato === 'problema').length;
    const generale = document.getElementById('stato-generale');
    generale.replaceChildren(
      el('span', { class: `punto ${problemi ? 'problema' : 'ok'}`, 'aria-hidden': 'true' }),
      problemi ? `${plurale(problemi, 'problema', 'problemi')}` : 'In servizio'
    );
  }

  function tabella(intestazioni, righe, vuoto) {
    if (!righe.length) return el('div', { class: 'vuoto', text: vuoto });
    return el('table', {}, [
      el('thead', {}, el('tr', {}, intestazioni.map((h) => el('th', { text: h })))),
      el('tbody', {}, righe.map((r) => el('tr', {}, r.map((c) => el('td', {}, c instanceof Node ? c : String(c)))))),
    ]);
  }

  function disegna({ marchio, configurazione: c, metriche: m, twilio: t }) {
    const o = m.ultime24h;
    document.getElementById('saluto').textContent = `${saluto()}, ${marchio.cliente}`;
    const racconto = raccontaGiornata(marchio, o);
    testo('titolo-giornata', racconto.titolo);
    testo('sottotitolo-giornata', racconto.sotto);

    const vp = o.verifichePrezzi;
    const rc = o.richiamate;
    sostituisci('kpi', [
      tile('Chiamate gestite', String(o.conAssistente), o.chiamate > o.conAssistente ? `${o.chiamate} in totale nelle 24 ore` : 'ultime 24 ore, senza personale', false, 'telefono'),
      tile('Preventivi dati', String(o.preventivi.chiamate),
        vp.nonRiuscite ? `${plurale(vp.nonRiuscite, 'verifica non riuscita', 'verifiche non riuscite')}` :
          o.preventivi.valoreEuro ? `valore indicativo ${fmtEuro.format(o.preventivi.valoreEuro)}` : 'prezzi reali dal sito',
        Boolean(vp.nonRiuscite), 'euro'),
      tile('Richiamate da fare', String(rc.richieste),
        rc.emailNonInviate ? `${rc.emailNonInviate} email NON inviate` : c.emailRichiamata ? 'arrivano per email' : 'richiamata non attiva',
        Boolean(rc.emailNonInviate), 'richiamata'),
      tile('Tempo di risposta', secondi(o.latenzaMediaMs),
        o.esiti.ripiego ? `${plurale(o.esiti.ripiego, 'errore', 'errori')} nelle 24 ore` : o.latenzaP95Ms != null ? `quasi sempre entro ${secondi(o.latenzaP95Ms)}` : 'media delle 24 ore',
        Boolean(o.esiti.ripiego), 'tempo'),
    ]);

    disegnaArgomenti(o.argomenti);
    disegnaChiamate(m.ultimeChiamate);
    disegnaSalute(m.salute, c);

    barreVerticali('grafico-ore', o.perOra, {
      etichetta: (d) => String(d.ora).padStart(2, '0'),
      valore: (d) => d.chiamate,
      descrivi: (d) => `${String(d.ora).padStart(2, '0')}:00–${String(d.ora).padStart(2, '0')}:59 · ${plurale(d.chiamate, 'chiamata', 'chiamate')}`,
      ogni: 3,
    });

    if (t.disponibile && !t.errore && t.perGiorno) {
      barreVerticali('grafico-settimana', t.perGiorno, {
        etichetta: (d) => fmtGiornoSettimana.format(new Date(`${d.giorno}T12:00:00Z`)),
        valore: (d) => d.chiamate,
        descrivi: (d) => `${fmtGiorno.format(new Date(`${d.giorno}T12:00:00Z`))} · ${plurale(d.chiamate, 'chiamata', 'chiamate')} · ${d.minuti} min`,
      });
      const totale = t.perGiorno.reduce((s, d) => s + d.chiamate, 0);
      testo('sotto-settimana', `${plurale(totale, 'chiamata', 'chiamate')} · registro telefonico`);
    } else {
      sostituisci('grafico-settimana', el('div', { class: 'vuoto', text: t.errore ? 'Registro telefonico non disponibile al momento.' : 'Registro telefonico non collegato.' }));
    }

    testo('conta-errori', m.errori.length ? `· ${m.errori.length}` : '· nessuno');
    sostituisci('errori', tabella(
      ['Ora', 'Chiamata', 'Tipo', 'Dettaglio'],
      m.errori.map((e) => [fmtOra.format(new Date(e.ts)), e.chiamata, e.status ? `${e.tipo} ${e.status}` : e.tipo, e.messaggio || '']),
      'Nessun errore dal riavvio del servizio.'
    ));

    if (!t.disponibile) {
      testo('twilio-totali', '');
      sostituisci('twilio', el('div', { class: 'vuoto', text: 'Credenziali del registro telefonico non configurate.' }));
    } else if (t.errore) {
      testo('twilio-totali', '');
      sostituisci('twilio', el('div', { class: 'avviso', text: `Registro non disponibile: ${t.errore}` }));
    } else {
      const costo = t.totale.valuta ? ` · costo ${t.totale.costo.toLocaleString('it-IT', { maximumFractionDigits: 2 })} ${t.totale.valuta}` : '';
      testo('twilio-totali', `· 7 giorni, ${t.totale.minuti} min${costo}`);
      sostituisci('twilio', tabella(
        ['Inizio', 'Da', 'Durata', 'Stato', 'Costo'],
        t.chiamate.map((x) => [
          x.inizio ? fmtData.format(new Date(x.inizio)) : '—',
          x.da,
          `${Math.floor(x.durataSec / 60)}:${String(x.durataSec % 60).padStart(2, '0')}`,
          x.stato,
          x.costo == null ? '—' : `${x.costo.toLocaleString('it-IT', { maximumFractionDigits: 4 })} ${x.valuta || ''}`,
        ]),
        'Nessuna chiamata negli ultimi 7 giorni.'
      ));
    }

    const righe = [
      ['Orario reception', c.receptionMode === 'auto' ? `07:00–19:59, adesso ${c.receptionAdesso}` : `forzato: ${c.receptionMode}`],
      ['Inoltro alla reception', c.inoltroReception ? 'lo fa l\'assistente' : 'la reception squilla prima dell\'assistente'],
      ['Prezzi e disponibilità', c.disponibilitaWuBook ? 'in tempo reale dal motore di prenotazione' : 'disattivati'],
      ['Email richiamate', c.emailRichiamata || 'non configurata'],
      ['Modello', c.modello || '—'],
      ['Voce', c.voce],
      ['Tempo massimo di risposta', secondi(c.timeoutClaudeMs)],
      ['Domande massime per chiamata', c.maxTurni],
      ['Versione', c.versione || '—'],
    ];
    sostituisci('impostazioni', righe.flatMap(([k, v]) => [el('dt', { text: k }), el('dd', { text: String(v) })]));

    testo('piede', `${marchio.app} · ${marchio.cliente} — aggiornato alle ${fmtOraSec.format(new Date(m.generatoIl))}, dati del servizio dal ${fmtData.format(new Date(m.datiDal))}. Nessuna conversazione viene registrata.`);
  }

  async function aggiorna() {
    try {
      const risposta = await fetch('/dashboard/api/stato', { cache: 'no-store', credentials: 'same-origin' });
      if (risposta.status === 401) return window.location.reload();
      if (!risposta.ok) throw new Error(`HTTP ${risposta.status}`);
      disegna(await risposta.json());
    } catch (error) {
      const generale = document.getElementById('stato-generale');
      generale.replaceChildren(el('span', { class: 'punto problema', 'aria-hidden': 'true' }), 'Non raggiungibile');
      testo('piede', `Aggiornamento non riuscito (${error.message}). Nuovo tentativo tra 30 secondi.`);
    }
  }

  aggiorna();
  setInterval(aggiorna, INTERVALLO_MS);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) aggiorna(); });
})();
