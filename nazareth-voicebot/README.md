# nazareth-voicebot

Voicebot telefonico basato su **Express**, **Twilio Voice** e **Claude** (Anthropic).

## Funzionamento

Twilio chiama `POST /voice` all'arrivo di ogni chiamata:

- **07:01–19:59** (ora di Roma): la chiamata viene inoltrata alla reception con `<Dial>`.
- **20:00–07:00** (estremi inclusi): risponde l'assistente virtuale, che ascolta la richiesta
  con `<Gather input="speech">` e la invia a `POST /handle-speech`.
- Se il chiamante non parla, l'assistente riprova una volta; al secondo silenzio saluta e chiude.

`/handle-speech` è per ora un segnaposto: l'integrazione con Claude non è ancora implementata.

Nella console Twilio imposta il webhook *A call comes in* del numero su
`https://<tuo-dominio>/voice` (HTTP POST).

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
| `RECEPTION_PHONE_NUMBER` | Numero della reception (default `+3907611564612`) |
| `TIMEZONE`            | Fuso orario (default `Europe/Rome`)          |
