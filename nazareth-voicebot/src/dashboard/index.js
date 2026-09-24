// Dashboard del voicebot su /dashboard, con pagina di accesso e sessione.
// Senza DASHBOARD_PASSWORD la dashboard è disattivata e risponde 404.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const { APP_NAME, CLIENT_NAME, TITOLO } = require('../marchio');

const leggi = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const SCRIPT = leggi('app.js');
const ICONA = leggi('icona.svg');

// Blocco dei tentativi di accesso falliti, per indirizzo IP.
const MAX_TENTATIVI_FALLITI = 10;
const FINESTRA_BLOCCO_MS = 15 * 60 * 1000;
// Durata della sessione: si resta collegati per 30 giorni sullo stesso dispositivo.
const DURATA_SESSIONE_MS = 30 * 24 * 60 * 60 * 1000;
const COOKIE = 'sessione_dashboard';

function escapeHtml(testo) {
  return String(testo).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Il nome del prodotto e del cliente entrano nelle pagine già con l'escape HTML.
function conMarchio(html) {
  return html
    .replaceAll('{{TITOLO}}', escapeHtml(TITOLO))
    .replaceAll('{{APP_NAME}}', escapeHtml(APP_NAME))
    .replaceAll('{{CLIENT_NAME}}', escapeHtml(CLIENT_NAME));
}

const PAGINA = conMarchio(leggi('pagina.html'));
const LOGIN = conMarchio(leggi('login.html'));

function uguali(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function leggiCookie(req, nome) {
  for (const parte of String(req.get('cookie') ?? '').split(';')) {
    const [k, ...v] = parte.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

/**
 * @param {object} opzioni
 * @param {string} [opzioni.password]        password di accesso (DASHBOARD_PASSWORD)
 * @param {{ riepilogo(): object }} opzioni.metriche
 * @param {{ ultimeChiamate(): Promise<object> }} opzioni.registroTwilio
 * @param {() => object} opzioni.configurazione impostazioni correnti da mostrare
 */
function creaDashboard({ password, metriche, registroTwilio, configurazione, now = () => Date.now() }) {
  const router = express.Router();
  const falliti = new Map(); // ip → { conteggio, dal }

  // La chiave delle sessioni dipende dalla password: cambiandola si esce da tutti i dispositivi.
  const chiave = crypto.createHash('sha256').update(`sessione-dashboard:${password ?? ''}:${process.env.SESSION_SECRET ?? ''}`).digest();
  const firma = (dati) => crypto.createHmac('sha256', chiave).update(dati).digest('base64url');

  function creaSessione() {
    const dati = Buffer.from(JSON.stringify({ scade: now() + DURATA_SESSIONE_MS })).toString('base64url');
    return `${dati}.${firma(dati)}`;
  }

  function sessioneValida(req) {
    const valore = leggiCookie(req, COOKIE);
    if (!valore) return false;
    const [dati, f] = valore.split('.');
    if (!dati || !f || !uguali(f, firma(dati))) return false;
    try {
      return JSON.parse(Buffer.from(dati, 'base64url').toString()).scade > now();
    } catch {
      return false;
    }
  }

  function cookieSessione(req, valore, maxAgeMs) {
    const sicuro = req.secure ? '; Secure' : '';
    return `${COOKIE}=${encodeURIComponent(valore)}; Path=/dashboard; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${sicuro}`;
  }

  function bloccato(ip) {
    const stato = falliti.get(ip);
    if (stato && now() - stato.dal > FINESTRA_BLOCCO_MS) falliti.delete(ip);
    return (falliti.get(ip)?.conteggio ?? 0) >= MAX_TENTATIVI_FALLITI;
  }

  function mostraLogin(res, { errore = '', stato = 200 } = {}) {
    res.status(stato).type('html').send(LOGIN.replace('{{ERRORE}}', escapeHtml(errore)));
  }

  router.use('/dashboard', (req, res, next) => {
    if (!password) return res.status(404).send('Not Found');
    res.set({
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });

  // Risorse pubbliche: servono per installare la dashboard come app sul telefono.
  router.get('/dashboard/icona.svg', (req, res) => res.type('image/svg+xml').send(ICONA));
  router.get('/dashboard/manifest.webmanifest', (req, res) => {
    res.type('application/manifest+json').send(JSON.stringify({
      name: TITOLO,
      short_name: APP_NAME,
      start_url: '/dashboard',
      scope: '/dashboard',
      display: 'standalone',
      background_color: '#0f1420',
      theme_color: '#0f1420',
      icons: [{ src: '/dashboard/icona.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }],
    }));
  });
  router.get('/dashboard/app.js', (req, res) => res.type('application/javascript').send(SCRIPT));

  router.post('/dashboard/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
    const ip = req.ip;
    if (bloccato(ip)) return mostraLogin(res, { errore: 'Troppi tentativi. Riprova tra 15 minuti.', stato: 429 });
    if (typeof req.body?.password === 'string' && uguali(req.body.password, password)) {
      falliti.delete(ip);
      res.set('Set-Cookie', cookieSessione(req, creaSessione(), DURATA_SESSIONE_MS));
      return res.redirect(303, '/dashboard');
    }
    const s = falliti.get(ip) ?? { conteggio: 0, dal: now() };
    s.conteggio += 1;
    falliti.set(ip, s);
    return mostraLogin(res, { errore: 'Password non corretta.', stato: 401 });
  });

  router.post('/dashboard/logout', (req, res) => {
    res.set('Set-Cookie', cookieSessione(req, '', 0));
    res.redirect(303, '/dashboard');
  });

  router.get('/dashboard', (req, res) => {
    if (!sessioneValida(req)) return mostraLogin(res);
    res.type('html').send(PAGINA);
  });

  router.get('/dashboard/api/stato', async (req, res) => {
    if (!sessioneValida(req)) return res.status(401).json({ errore: 'sessione_scaduta' });
    res.json({
      marchio: { app: APP_NAME, cliente: CLIENT_NAME },
      configurazione: configurazione(),
      metriche: metriche.riepilogo(),
      twilio: await registroTwilio.ultimeChiamate(),
    });
  });

  return router;
}

module.exports = { creaDashboard };
