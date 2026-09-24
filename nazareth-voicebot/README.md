# nazareth-voicebot

Voicebot telefonico basato su **Express**, **Twilio Voice** e **Claude** (Anthropic).

## Funzionamento

Twilio chiama `POST /voice` all'arrivo di ogni chiamata:

- **07:01–19:59** (ora di Roma): la chiamata viene inoltrata alla reception con `<Dial>`.
  Se la reception è occupata, non risponde entro `RECEPTION_DIAL_TIMEOUT` secondi o il
  numero non è raggiungibile, Twilio chiama `POST /dial-status` e risponde l'assistente virtuale.
- **20:00–07:00** (estremi inclusi): risponde direttamente l'assistente virtuale, che ascolta
  la richiesta con `<Gather input="speech">` e la invia a `POST /handle-speech`.
- Se il chiamante non parla, l'assistente riprova una volta (`POST /assistente`);
  al secondo silenzio saluta e chiude.

`/handle-speech` è per ora un segnaposto: l'integrazione con Claude non è ancora implementata.

### Endpoint

| Metodo | Percorso         | Descrizione                                         |
|--------|------------------|-----------------------------------------------------|
| POST   | `/voice`         | Webhook chiamata in arrivo                          |
| POST   | `/dial-status`   | Esito dell'inoltro alla reception                   |
| POST   | `/assistente`    | Nuovo tentativo di ascolto dopo un silenzio         |
| POST   | `/handle-speech` | Testo riconosciuto dal chiamante (segnaposto)       |
| GET    | `/health`        | Controllo di stato per l'hosting                    |

### Sicurezza

Tutti gli endpoint `POST` accettano solo richieste firmate da Twilio (header
`X-Twilio-Signature`, verificato con `TWILIO_AUTH_TOKEN`). Le altre ricevono 400/403.
`PUBLIC_BASE_URL` deve coincidere con l'indirizzo configurato su Twilio, altrimenti
la verifica fallisce dietro a un proxy. Per provare in locale con curl imposta
`TWILIO_VALIDATE_SIGNATURE=false` (mai in produzione).

## Configurazione Twilio

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

| Variabile                   | Descrizione                                                    |
|-----------------------------|----------------------------------------------------------------|
| `PORT`                      | Porta HTTP del server (default 3000)                           |
| `PUBLIC_BASE_URL`           | URL pubblico del server, usato per verificare la firma Twilio  |
| `ANTHROPIC_API_KEY`         | Chiave API Anthropic                                           |
| `TWILIO_ACCOUNT_SID`        | Account SID Twilio                                             |
| `TWILIO_AUTH_TOKEN`         | Auth token Twilio (obbligatorio per la verifica della firma)   |
| `TWILIO_PHONE_NUMBER`       | Numero Twilio del voicebot (formato E.164)                     |
| `TWILIO_VALIDATE_SIGNATURE` | `false` disattiva la verifica, solo in locale (default `true`) |
| `TTS_VOICE`                 | Voce sintetica (default `Polly.Bianca-Neural`)                 |
| `RECEPTION_PHONE_NUMBER`    | Numero della reception (default `+3907611564612`)              |
| `RECEPTION_DIAL_TIMEOUT`    | Secondi di squillo verso la reception (default 20)             |
| `TIMEZONE`                  | Fuso orario (default `Europe/Rome`)                            |
