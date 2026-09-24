# nazareth-voicebot

Voicebot telefonico basato su **Express**, **Twilio Voice** e **Claude** (Anthropic).

> Stato: struttura iniziale del progetto, la logica non è ancora implementata.

## Struttura

```
nazareth-voicebot/
├── package.json
├── server.js              # entry point Express
├── src/
│   ├── claude.js          # integrazione API Anthropic
│   ├── knowledge-base.js  # contenuti e FAQ del voicebot
│   └── twilio-handler.js  # webhook Twilio Voice / TwiML
├── .env.example
└── README.md
```

## Requisiti

- Node.js >= 20
- Account Twilio con un numero abilitato alle chiamate vocali
- Chiave API Anthropic

## Installazione

```bash
npm install
cp .env.example .env   # poi compila le variabili
```

## Avvio

```bash
npm run dev   # sviluppo con nodemon (riavvio automatico)
npm start     # produzione
```

## Variabili d'ambiente

| Variabile             | Descrizione                                  |
|-----------------------|----------------------------------------------|
| `PORT`                | Porta HTTP del server (default 3000)         |
| `ANTHROPIC_API_KEY`   | Chiave API Anthropic                         |
| `TWILIO_ACCOUNT_SID`  | Account SID Twilio                           |
| `TWILIO_AUTH_TOKEN`   | Auth token Twilio                            |
| `TWILIO_PHONE_NUMBER` | Numero Twilio del voicebot (formato E.164)   |
| `TIMEZONE`            | Fuso orario (default `Europe/Rome`)          |
