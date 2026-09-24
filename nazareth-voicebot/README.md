# nazareth-voicebot

Voicebot telefonico basato su **Express** e **Claude** (Anthropic), con un centralino
indipendente dal provider telefonico. Il provider attuale è **Twilio Voice**.

## Architettura: centralino e provider

```
 provider telefonico          adattatore                    centralino
 (Twilio, domani altri) ──►  src/provider/twilio.js  ──►  src/centralino/  ──►  Claude
   webhook, TwiML            eventi ⇄ azioni neutre        logica chiamata      src/claude.js
```

- **Centralino** (`src/centralino/`): orari, inoltro alla reception, accoglienza, silenzi,
  conversazione con Claude, messaggi di ripiego. Riceve **eventi** neutri
  (`chiamata_in_arrivo`, `esito_inoltro`, `parlato`, `silenzio`) e restituisce **azioni**
  neutre (`parla`, `ascolta`, `inoltra`, `riaggancia`). Non conosce Twilio.
  Il contratto è descritto in `src/centralino/protocollo.js`.
- **Adattatore** (`src/provider/<nome>.js`): l'unica parte legata al provider. Verifica
  l'autenticità delle richieste, le traduce in eventi e traduce le azioni nel formato
  del provider (per Twilio: TwiML).
- Il provider si sceglie con `TELEPHONY_PROVIDER` (default `twilio`).

### Aggiungere o cambiare provider

1. Crea `src/provider/<nome>.js` con la stessa interfaccia di `twilio.js`:
   `{ nome, router(centralino) }`. Il router riceve i webhook del provider, chiama
   `centralino.gestisci(evento)` e restituisce le azioni nel formato del provider.
2. Mappa gli esiti dell'inoltro del provider sui cinque esiti neutri
   (`risposto`, `occupato`, `nessuna_risposta`, `fallito`, `annullato`) e restituisci
   intatto il `contesto` dell'azione `ascolta` nell'evento `silenzio`.
3. Registralo in `src/provider/index.js`, aggiungi i test del rendering e imposta
   `TELEPHONY_PROVIDER=<nome>`. Centralino, Claude e base di conoscenza non cambiano.

Il modello a webhook con risposte a "verbi" è quello di Twilio e di altri provider: per
esempio Vonage usa azioni JSON (NCCO) come `talk`, `input` e `connect`, con i risultati
inviati a un webhook ([riferimento NCCO](https://developer.vonage.com/en/voice/voice-api/ncco-reference)).
Un centralino in casa (per esempio Asterisk) richiederebbe invece un adattatore basato su
eventi in tempo reale anziché su webhook: il centralino resta lo stesso, cambia solo
l'adattatore.

### Numero esistente con Asterisk (reception già provata a monte)

Se le chiamate arrivano da un centralino che fa già squillare la reception (per esempio
Asterisk collegato a Messagenet, che passa la chiamata a Twilio solo se nessuno risponde),
imposta `RECEPTION_FORWARD=false`: il bot non inoltra di nuovo alla reception.
Di giorno accoglie con "la reception non è disponibile", di notte con "la reception è chiusa".
Le chiamate SIP arrivano a Twilio su un SIP Domain il cui Voice URL va impostato su
`https://<tuo-dominio>/voice` (HTTP POST), come per un numero Twilio
([Twilio: Sending SIP to Twilio](https://www.twilio.com/docs/voice/api/sending-sip)).

### Simulatore di chiamata

`npm run simula` apre una chiamata finta da terminale che usa il centralino e Claude veri,
senza nessun provider: utile per provare le risposte prima delle telefonate reali. Una riga
vuota simula il silenzio; `npm run simula -- --aperta` prova l'inoltro alla reception.

## Funzionamento

Con l'adattatore Twilio, Twilio chiama `POST /voice` all'arrivo di ogni chiamata:

- **07:01–19:59** (ora di Roma): la chiamata viene inoltrata alla reception con `<Dial>`.
  Se la reception è occupata, non risponde entro `RECEPTION_DIAL_TIMEOUT` secondi o il
  numero non è raggiungibile, Twilio chiama `POST /dial-status` e risponde l'assistente virtuale.
- **20:00–07:00** (estremi inclusi): risponde direttamente l'assistente virtuale, che ascolta
  la richiesta con `<Gather input="speech">` e la invia a `POST /handle-speech`.
- Se il chiamante non parla, l'assistente riprova una volta (`POST /assistente`);
  al secondo silenzio saluta e chiude.

### Endpoint (adattatore Twilio)

### Assistente virtuale (Claude)

`POST /handle-speech` riceve il testo riconosciuto da Twilio e lo invia a Claude
(`src/claude.js`, SDK ufficiale `@anthropic-ai/sdk`):

- **Base di conoscenza:** `knowledge/nazareth.md` è l'unica fonte di informazioni, con la FAQ
  ufficiale del sito come fonte prevalente. Il prompt vieta di inventare; prezzi e
  disponibilità non sono noti e il bot rimanda sempre a sito o WhatsApp. Animali, self
  check-in e partenza posticipata non vengono mai confermati. Per aggiornare le informazioni
  modifica il file e riavvia il server.
- **Conversazione:** lo storico è tenuto in memoria per `CallSid` (scadenza 30 minuti, massimo
  `CONVERSATION_MAX_TURNS` domande). Dopo ogni risposta il bot riascolta; se il chiamante
  saluta, si congeda e chiude.
- **Tempi:** Twilio abbandona il webhook dopo 15 secondi, quindi la chiamata a Claude ha un
  timeout di `CLAUDE_TIMEOUT_MS` (default 8000) e nessun retry. In caso di timeout o errore il
  chiamante sente un messaggio con WhatsApp ed email e la chiamata si chiude con cortesia.
- **Log:** una riga JSON per evento con solo `CallSid`, esito e durata; il parlato e il numero
  del chiamante non vengono registrati.

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

## Deploy su Render

1. New → **Web Service**, collega il repository e scegli il branch.
2. **Root Directory: `nazareth-voicebot`** (il progetto è in una sottocartella: senza
   questa impostazione build e avvio falliscono).
3. Runtime Node, build `npm install`, start `npm start`.
4. Variabili d'ambiente: `ANTHROPIC_API_KEY`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
   `TWILIO_PHONE_NUMBER`, `RECEPTION_PHONE_NUMBER` e **`PUBLIC_BASE_URL`** con l'URL
   pubblico del servizio (es. `https://nazareth-voicebot.onrender.com`), necessario per la
   verifica della firma Twilio. Le altre hanno valori predefiniti.
5. Non usare il piano gratuito in produzione: il servizio si spegne dopo 15 minuti senza
   traffico e impiega circa un minuto a ripartire ([documentazione Render](https://render.com/docs/free)),
   più dei 15 secondi che Twilio attende. La prima chiamata dopo una pausa fallirebbe.

## Configurazione Twilio

1. Console Twilio → Phone Numbers → il numero → Voice Configuration.
2. *A call comes in*: Webhook `https://<tuo-dominio>/voice`, metodo HTTP POST.

### Prove

Per provare l'assistente di giorno senza toccare il codice imposta temporaneamente
`RECEPTION_MODE=chiusa` (oppure `aperta` per provare l'inoltro di notte) e riportalo a
`auto` alla fine. All'avvio il server segnala nei log se la modalità è forzata.

## Struttura

```
nazareth-voicebot/
├── package.json
├── server.js                  # entry point: collega centralino e provider
├── knowledge/
│   └── nazareth.md            # base di conoscenza (unica fonte per Claude)
├── scripts/
│   └── simula-chiamata.js     # chiamata simulata da terminale
├── src/
│   ├── centralino/
│   │   ├── centralino.js      # logica della chiamata (indipendente dal provider)
│   │   ├── protocollo.js      # eventi e azioni neutre
│   │   ├── messaggi.js        # testi fissi
│   │   └── orario.js          # orario della reception
│   ├── provider/
│   │   ├── index.js           # registro dei provider (TELEPHONY_PROVIDER)
│   │   └── twilio.js          # adattatore Twilio (webhook, firma, TwiML)
│   ├── claude.js              # integrazione API Anthropic e system prompt
│   ├── conversation-store.js  # storico conversazioni per chiamata
│   └── knowledge-base.js      # caricamento di knowledge/nazareth.md
├── test/
│   ├── centralino.test.js     # centralino e adattatore, senza HTTP
│   └── handle-speech.test.js  # flusso HTTP Twilio con Claude simulato
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
npm run simula  # chiamata simulata da terminale con Claude vero
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
| `RECEPTION_FORWARD`         | `false` se la reception squilla già a monte (default `true`)   |
| `RECEPTION_DIAL_TIMEOUT`    | Secondi di squillo verso la reception (default 20)             |
| `TELEPHONY_PROVIDER`        | Adattatore del provider telefonico (default `twilio`)          |
| `RECEPTION_MODE`            | `auto` (default), `chiusa` o `aperta`: solo per le prove       |
| `TIMEZONE`                  | Fuso orario (default `Europe/Rome`)                            |
