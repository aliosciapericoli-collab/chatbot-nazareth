// Dashboard del voicebot: pagina protetta da password su /dashboard.
// Senza DASHBOARD_PASSWORD la dashboard è disattivata e risponde 404.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');

const PAGINA = fs.readFileSync(path.join(__dirname, 'pagina.html'), 'utf8');
const SCRIPT = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// Blocco dei tentativi di accesso falliti, per indirizzo IP.
const MAX_TENTATIVI_FALLITI = 10;
const FINESTRA_BLOCCO_MS = 15 * 60 * 1000;

function uguali(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function passwordDaHeader(header) {
  if (!header?.startsWith('Basic ')) return null;
  const decodificato = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const separatore = decodificato.indexOf(':');
  return separatore === -1 ? null : decodificato.slice(separatore + 1);
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

  router.use('/dashboard', (req, res, next) => {
    if (!password) return res.status(404).send('Not Found');

    res.set({
      'Cache-Control': 'no-store',
      'X-Frame-Options': 'DENY',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
    });

    const ip = req.ip;
    const stato = falliti.get(ip);
    if (stato && now() - stato.dal > FINESTRA_BLOCCO_MS) falliti.delete(ip);
    if (falliti.get(ip)?.conteggio >= MAX_TENTATIVI_FALLITI) {
      return res.status(429).send('Troppi tentativi. Riprova tra 15 minuti.');
    }

    const fornita = passwordDaHeader(req.get('authorization'));
    if (fornita !== null && uguali(fornita, password)) {
      falliti.delete(ip);
      return next();
    }

    if (fornita !== null) {
      const s = falliti.get(ip) ?? { conteggio: 0, dal: now() };
      s.conteggio += 1;
      falliti.set(ip, s);
    }
    res.set('WWW-Authenticate', 'Basic realm="Nazareth Voicebot", charset="UTF-8"');
    return res.status(401).send('Accesso riservato');
  });

  router.get('/dashboard', (req, res) => {
    res.type('html').send(PAGINA);
  });

  router.get('/dashboard/app.js', (req, res) => {
    res.type('application/javascript').send(SCRIPT);
  });

  router.get('/dashboard/api/stato', async (req, res) => {
    res.json({
      configurazione: configurazione(),
      metriche: metriche.riepilogo(),
      twilio: await registroTwilio.ultimeChiamate(),
    });
  });

  return router;
}

module.exports = { creaDashboard };
