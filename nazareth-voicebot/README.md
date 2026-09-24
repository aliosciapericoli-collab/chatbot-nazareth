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

### Assistente virtuale (Claude)

`POST /handle-speech` riceve il testo riconosciuto da Twilio e lo invia a Claude
(`src/claude.js`, SDK ufficiale `@anthropic-ai/sdk`):

- **Base di conoscenza:** `knowledge/nazareth.md` è l'unica fonte di informazioni. Il prompt
  vieta di inventare e indica cosa non è noto (prezzi, disponibilità, orari di check-in/out,
  cancellazione, tassa di soggiorno, costi animali): in quei casi il bot rimanda a WhatsApp,
  email, sito o reception. Per aggiornare le informazioni modifica il file e riavvia il server.
- **Conversazione:** lo storico è tenuto in memoria per `CallSid` (scadenza 30 minuti, massimo
  `CONVERSATION_MAX_TURNS` domande). Dopo ogni risposta il bot riascolta; se il chiamante
  saluta, si congeda e chiude.
- **Tempi:** Twilio abbandona il webhook dopo 15 secondi, quindi la chiamata a Claude ha un
  timeout di `CLAUDE_TIMEOUT_MS` (default 8000) e nessun retry. In caso di timeout o errore il
  chiamante sente un messaggio con WhatsApp ed email e la chiamata si chiude con cortesia.
- **Log:** una riga JSON per evento con solo `CallSid`, esito e durata; il parlato e il numero
  del chiamante non vengono registrati.

### Endpoint

| Metodo | Percorso         | Descrizione                                         |
|--------|------------------|-----------------------------------------------------|
| POST   | `/voice`         | Webhook chiamata in arrivo                          |
| POST   | `/dial-status`   | Esito dell'inoltro alla reception                   |
| POST   | `/assistente`    | Nuovo tentativo di ascolto dopo un silenzio         |
| POST   | `/handle-speech` | Testo riconosciuto: risposta di Claude              |
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
├── knowledge/
│   └── nazareth.md        # base di conoscenza (unica fonte per Claude)
├── src/
│   ├── claude.js          # integrazione API Anthropic e system prompt
│   ├── conversation-store.js # storico conversazioni per CallSid
│   ├── knowledge-base.js  # caricamento di knowledge/nazareth.md
│   └── twilio-handler.js  # (vuoto, riservato)
├── test/
│   └── handle-speech.test.js # test con Claude simulato
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
npm test      # test con Claude simulato (nessuna chiamata reale all'API)
```

## Variabili d'ambiente

| Variabile                   | Descrizione                                                    |
|-----------------------------|----------------------------------------------------------------|
| `PORT`                      | Porta HTTP del server (default 3000)                           |
| `PUBLIC_BASE_URL`           | URL pubblico del server, usato per verificare la firma Twilio  |
| `ANTHROPIC_API_KEY`         | Chiave API Anthropic                                           |
| `ANTHROPIC_MODEL`           | Modello Claude (default `claude-haiku-4-5-20251001`)           |
| `CLAUDE_TIMEOUT_MS`         | Timeout della risposta di Claude in ms (default 8000)          |
| `CLAUDE_MAX_TOKENS`         | Lunghezza massima della risposta (default 300)                 |
| `CONVERSATION_MAX_TURNS`    | Domande massime per chiamata (default 10)                      |
| `TWILIO_ACCOUNT_SID`        | Account SID Twilio                                             |
| `TWILIO_AUTH_TOKEN`         | Auth token Twilio (obbligatorio per la verifica della firma)   |
| `TWILIO_PHONE_NUMBER`       | Numero Twilio del voicebot (formato E.164)                     |
| `TWILIO_VALIDATE_SIGNATURE` | `false` disattiva la verifica, solo in locale (default `true`) |
| `TTS_VOICE`                 | Voce sintetica (default `Polly.Bianca-Neural`)                 |
| `RECEPTION_PHONE_NUMBER`    | Numero della reception (default `+3907611564612`)              |
| `RECEPTION_DIAL_TIMEOUT`    | Secondi di squillo verso la reception (default 20)             |
| `TIMEZONE`                  | Fuso orario (default `Europe/Rome`)                            |
