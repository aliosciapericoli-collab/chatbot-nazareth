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

### Dashboard (Vocalba)

La dashboard è il prodotto che vede il cliente: si presenta come **"Vocalba · Nazareth Residence"**.
Nome del prodotto e del cliente si impostano con `APP_NAME` e `CLIENT_NAME`, senza toccare il codice.

- **Accesso:** `https://<tuo-dominio>/dashboard` apre una pagina di accesso con password
  (`DASHBOARD_PASSWORD`). La sessione dura 30 giorni sul dispositivo; "Esci" la chiude.
  Cambiando la password si esce da tutti i dispositivi. Dopo 10 tentativi sbagliati dallo stesso
  indirizzo l'accesso si blocca per 15 minuti. Senza `DASHBOARD_PASSWORD` risponde 404.
- **App sul telefono:** da Safari o Chrome "Aggiungi a schermata Home" installa la dashboard
  con icona e nome propri.
- **Ultime 24 ore** (finestra mobile, segue il turno di notte): la giornata raccontata in una
  frase, chiamate gestite, preventivi dati con valore indicativo, richiamate da fare, tempo di
  risposta, chiamate per ora.
- **Cosa chiedono i clienti:** argomenti delle domande (prezzi, arrivo e parcheggio, animali…),
  riconosciuti per parole chiave. Si conserva solo l'argomento, mai il testo.
- **Ultimi 7 giorni:** chiamate per giorno dal registro Twilio, che non si azzera ai riavvii.
- **Salute del servizio:** stato di assistente vocale, prezzi WuBook ed email di richiamata.
- **Errori recenti, registro telefonico e impostazioni** in sezioni richiudibili.

Nel riepilogo (`/dashboard/api/stato`) non ci sono testi: id delle chiamate troncati, dei numeri
solo le ultime tre cifre. Le metriche del servizio sono in memoria e ripartono a ogni riavvio.

### Archivio conversazioni (Postgres)

Con `DATABASE_URL` impostato ogni chiamata resta consultabile nella dashboard, sezione
**Archivio conversazioni**:

- **conversazione completa**: le parole del cliente come le ha trascritte Twilio e ogni frase
  detta da Vocalba, nell'ordine, con l'ora;
- **copia identica dell'email di richiamata** (oggetto, destinatario, testo), anche quando
  l'invio non è riuscito;
- esito, argomenti, preventivo, stato della richiamata e numero del chiamante;
- **sincronizzazione con Twilio** ogni 10 minuti: entrano anche le chiamate chiuse prima di
  parlare, con durata, stato della linea e costo;
- ricerca per parola o numero ed elenco a pagine.

Dopo `ARCHIVIO_GIORNI` giorni (default 90) le chiamate si cancellano da sole, con messaggi ed
email. Con l'archivio attivo il messaggio di benvenuto dice al chiamante che la conversazione
viene conservata e per quanto tempo. Le scritture non bloccano mai la chiamata: se il database
non risponde il bot continua e nei log resta solo un codice tecnico.

Su Render: crea un database Postgres nella **stessa regione** del servizio e copia l'**Internal
Database URL** in `DATABASE_URL` del web service. Le tabelle (`vocalba_chiamate`,
`vocalba_messaggi`, `vocalba_email`) si creano da sole al primo avvio. Prima di attivarlo
aggiorna l'informativa privacy della struttura (dati conservati, durata, fornitori).

Test sul database: `TEST_DATABASE_URL=postgres://… npm test` (il database di prova viene svuotato).

### Linea demo pubblica

Un secondo numero Twilio (`DEMO_PHONE_NUMBER`) collegato allo **stesso server e allo stesso
webhook `/voice`** fa provare Vocalba a chiunque, per esempio dalla pagina alioscia.it/vocalba.
Il server riconosce il numero chiamato (`To`) e risponde per **Casa Aurora**, una struttura
dimostrativa dichiarata come tale (`src/demo/linea-demo.js`):

- nessun dato del cliente vero: né nome, né contatti, né prezzi WuBook;
- nessuna email alla reception, nessun archivio, nessuna statistica nella dashboard del cliente;
- al massimo `DEMO_MAX_TURNS` domande (default 8), per contenere i costi.

Sul numero demo in Twilio imposta "A call comes in" → Webhook `https://<dominio>/voice` (POST),
come per il numero del cliente.

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

### Richiamata dalla reception

Quando il chiamante chiede qualcosa che il bot non può dare (prezzi, disponibilità,
prenotazioni, gruppi, casi particolari) o chiede un operatore, il bot offre di lasciare un
messaggio alla reception, che ricontatta in orario di apertura (7-20, senza orario preciso).

1. Il bot chiede nome e motivo in breve.
2. Propone come recapito il numero da cui si chiama (parametro `From` di Twilio, letto a
   gruppi di cifre) oppure prende un numero dettato. Il numero non viene proposto se è
   nascosto o se coincide con `RECEPTION_PHONE_NUMBER` o `TWILIO_PHONE_NUMBER` (per esempio
   quando il trasferimento di chiamata presenta il numero della struttura).
3. Ripete il riepilogo e chiede conferma.
4. Dà l'informativa: "I suoi dati servono solo per ricontattarla e vengono cancellati dopo
   la richiamata."

Alla conferma Claude aggiunge un blocco `[RICHIAMATA]{...}[/RICHIAMATA]` che non viene letto
al chiamante. Il server risponde subito a Twilio e poi invia un'email a `CALLBACK_EMAIL_TO`
con oggetto `Richiamata richiesta - <nome>`: data e ora di Roma, nome, numero, motivo e
conversazione. L'email parte alla conferma e non a fine telefonata, perché Twilio non avvisa
il server quando il chiamante riaggancia. Una sola email per chiamata.

Finché `SMTP_HOST` non è impostato il bot **non offre** la richiamata, per non promettere
messaggi che nessuno riceverebbe. Se l'invio fallisce, il chiamante non se ne accorge:
resta un log con il solo CallSid e un codice tecnico, e la dashboard mostra "Email NON inviata".
Senza archivio il testo della conversazione passa solo dalla memoria del server all'email; con
l'archivio attivo ne resta una copia identica per `ARCHIVIO_GIORNI` giorni. Dopo la richiamata
l'email va cancellata dalla casella della reception.

### Prezzi e disponibilità in tempo reale (WuBook)

Claude ha lo strumento `verifica_disponibilita` (arrivo, partenza o notti, adulti, bambini).
Il bot chiede le date e le persone se mancano, interpreta le date parlate rispetto alla data di
oggi (ora di Roma) e risponde con le tipologie libere, il prezzo totale indicativo del soggiorno
con colazione e l'eventuale "ultima camera". Aggiunge sempre la tassa di soggiorno esclusa e la
frase: "Il prezzo è quello del nostro sito in questo momento e può cambiare…". Se Claude la
dimentica, la aggiunge il server. Il bot non prenota e non blocca camere; per gruppi oltre
quattro camere non dà prezzi.

- **Fonte:** la stessa chiamata della pagina pubblica di prenotazione
  (`POST https://wubook.net/nneb/bk/inv?ep=17104f2c`, ricostruita da `nserp.jgz`), senza
  credenziali. La risposta è JSON in base64: prezzo e disponibilità per notte e per prodotto
  (tipologia + numero di adulti). Si usano solo le tariffe con colazione (`board: bb`) e le
  stesse regole di prenotabilità della pagina (esaurito, chiuso, soggiorno minimo/massimo).
- **Tempi:** timeout WuBook 4 secondi, cache di 5 minuti per coppia di date. Quando Claude usa
  lo strumento il server risponde subito a Twilio con "Un attimo, controllo la disponibilità."
  e un Redirect a `/prosegui`, dove arriva la risposta con i prezzi (entro 13 secondi).
- **Errori:** se WuBook non risponde o cambia formato, il bot dice che in questo momento non
  riesce a verificare e rimanda al sito, a WhatsApp o alla richiamata. La dashboard lo mostra
  tra gli errori.
- **Blocco dei prezzi non verificati:** se in un turno senza verifica riuscita la risposta
  contiene un importo in euro che non è nella base di conoscenza (tassa di soggiorno, addebito
  per il fumo), il server la sostituisce con il rimando al sito e a WhatsApp e registra
  `prezzo_bloccato`. La dashboard conta verifiche riuscite, non riuscite e prezzi bloccati.
- **Storico:** nello storico della chiamata resta solo il testo detto al cliente, non i dati
  dello strumento: se il cliente chiede di nuovo, i prezzi vengono riverificati.
- **Limiti:** i bambini sono contati come ospiti della camera; eventuali riduzioni vanno
  verificate sul sito. Il prezzo è quello della tariffa pubblica "Sito" in quel momento.

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
  del chiamante non finiscono mai nei log (con l'archivio attivo stanno solo nel database).

| Metodo | Percorso         | Descrizione                                         |
|--------|------------------|-----------------------------------------------------|
| POST   | `/voice`         | Webhook chiamata in arrivo                          |
| POST   | `/dial-status`   | Esito dell'inoltro alla reception                   |
| POST   | `/assistente`    | Nuovo tentativo di ascolto dopo un silenzio         |
| POST   | `/handle-speech` | Testo riconosciuto: risposta di Claude              |
| POST   | `/prosegui`      | Seconda parte della risposta dopo una verifica      |
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
├── src/marchio.js             # nome del prodotto e del cliente (APP_NAME, CLIENT_NAME)
├── knowledge/
│   └── nazareth.md            # base di conoscenza (unica fonte per Claude)
├── scripts/
│   └── simula-chiamata.js     # chiamata simulata da terminale
├── src/
│   ├── dashboard/
│   │   ├── index.js           # route /dashboard: accesso, sessione, app installabile
│   │   ├── login.html         # pagina di accesso con il marchio
│   │   ├── icona.svg          # icona dell'app
│   │   ├── metriche.js        # metriche in memoria dagli eventi del centralino
│   │   ├── registro-twilio.js # storico chiamate e costi da Twilio
│   │   ├── pagina.html        # pagina della dashboard
│   │   └── app.js             # script della pagina
│   ├── demo/
│   │   └── linea-demo.js      # linea demo pubblica: struttura dimostrativa Casa Aurora
│   ├── archivio/
│   │   └── archivio.js        # conversazioni, email e registro Twilio su Postgres
│   ├── centralino/
│   │   ├── centralino.js      # logica della chiamata (indipendente dal provider)
│   │   ├── protocollo.js      # eventi e azioni neutre
│   │   ├── messaggi.js        # testi fissi
│   │   ├── numeri.js          # lettura dei numeri a gruppi di cifre
│   │   ├── argomenti.js       # argomenti delle domande per le statistiche
│   │   └── orario.js          # orario della reception
│   ├── provider/
│   │   ├── index.js           # registro dei provider (TELEPHONY_PROVIDER)
│   │   └── twilio.js          # adattatore Twilio (webhook, firma, TwiML)
│   ├── disponibilita/
│   │   ├── wubook.js          # client del motore WuBook: richiesta, lettura, cache
│   │   └── strumento.js       # strumento verifica_disponibilita per Claude
│   ├── notifiche/
│   │   └── email-richiamata.js # email di richiamata alla reception (SMTP)
│   ├── claude.js              # integrazione API Anthropic e system prompt
│   ├── conversation-store.js  # storico conversazioni per chiamata
│   └── knowledge-base.js      # caricamento di knowledge/nazareth.md
├── test/
│   ├── centralino.test.js     # centralino e adattatore, senza HTTP
│   ├── dashboard.test.js      # accesso, metriche e registro Twilio della dashboard
│   ├── archivio.test.js       # archivio conversazioni (Postgres con TEST_DATABASE_URL)
│   ├── richiamata.test.js     # richiamata con Claude e SMTP simulati
│   ├── disponibilita.test.js  # prezzi e disponibilità con WuBook e Claude simulati
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
| `SMTP_HOST`                 | Server SMTP per le email di richiamata (vuoto = non inviate)   |
| `SMTP_PORT`                 | Porta SMTP: 587 STARTTLS (default) o 465 TLS                   |
| `SMTP_USER` / `SMTP_PASS`   | Credenziali SMTP                                               |
| `CALLBACK_EMAIL_TO`         | Destinatario (default `info@nazarethresidence.com`)            |
| `CALLBACK_EMAIL_FROM`       | Mittente (default `SMTP_USER`)                                 |
| `WUBOOK_ENABLED`            | `false` disattiva prezzi e disponibilità (default attivi)      |
| `WUBOOK_EP`                 | Id del motore di prenotazione (default `17104f2c`)             |
| `WUBOOK_TIMEOUT_MS`         | Timeout delle richieste a WuBook (default 4000)                |
| `APP_NAME`                  | Nome del prodotto nella dashboard (default `Vocalba`)          |
| `CLIENT_NAME`               | Nome del cliente (default `Nazareth Residence`)                |
| `SESSION_SECRET`            | Facoltativo: segreto aggiuntivo per le sessioni della dashboard |
| `DASHBOARD_PASSWORD`        | Password della dashboard `/dashboard` (vuota = disattivata)     |
| `DATABASE_URL`              | Postgres dell'archivio conversazioni (vuoto = non conservate)   |
| `DEMO_PHONE_NUMBER`         | Numero Twilio della linea demo pubblica (vuoto = nessuna demo)  |
| `DEMO_MAX_TURNS`            | Domande massime per chiamata sulla linea demo (default 8)       |
| `ARCHIVIO_GIORNI`           | Giorni di conservazione dell'archivio (default 90)              |
| `DATABASE_SSL`              | `true`/`false` forza il TLS verso Postgres (default automatico) |
| `TELEPHONY_PROVIDER`        | Adattatore del provider telefonico (default `twilio`)          |
| `RECEPTION_MODE`            | `auto` (default), `chiusa` o `aperta`: solo per le prove       |
| `TIMEZONE`                  | Fuso orario (default `Europe/Rome`)                            |
