# PadelMatch

Webapp per trovare compagni di padel. Il sito è servito da **Vercel**, mentre dati e login stanno su **Supabase** (database Postgres con regole di accesso).

```
index.html            pagina e stili
app.js                logica dell'app
config.js             indirizzo e chiave pubblica di Supabase (da compilare)
vercel.json           intestazioni di sicurezza per Vercel
supabase/schema.sql   tabelle, regole di accesso e funzioni del database
```

## 1. Crea il database su Supabase

1. Su supabase.com crea un progetto. Come regione scegli l'Europa (per esempio Francoforte), più vicina ai tuoi utenti.
2. Apri **SQL Editor**, incolla tutto il contenuto di `supabase/schema.sql` e premi **Run**. Lo script si può rieseguire senza perdere dati, per esempio dopo un aggiornamento.
3. In **Authentication > URL Configuration**:
   - **Site URL**: l'indirizzo del sito su Vercel, per esempio `https://padelmatch.vercel.app`
   - **Redirect URLs**: aggiungi lo stesso indirizzo. Serve per i link di conferma email e di recupero password.
4. Lascia attiva la conferma dell'email (è il comportamento predefinito): chi si registra riceve un link e poi accede.

> **Email:** il servizio di invio email incluso in Supabase ha un limite molto basso di messaggi all'ora ed è pensato per le prove. Prima di aprire l'app a più persone configura un tuo SMTP in **Authentication > Emails > SMTP Settings** (per esempio con Brevo, Resend o Postmark).

## 2. Collega l'app al database

In Supabase apri **Project Settings > API Keys** e copia:

- l'URL del progetto (`https://xxxx.supabase.co`)
- la chiave **pubblica**: si chiama "publishable" (`sb_publishable_...`) oppure "anon" nei progetti più vecchi

Incollali in `config.js`.

La chiave pubblica può stare nel browser: i dati sono protetti dalle regole scritte in `schema.sql`. **Non mettere mai nel sito la chiave "secret" o "service_role"**, perché scavalca tutte le regole.

## 3. Pubblica su Vercel

1. Carica la cartella in un repository GitHub. Il file `config.js` contiene solo la chiave pubblica, quindi può stare nel repository.
2. Su vercel.com: **Add New > Project**, importa il repository.
   - Framework Preset: **Other**
   - Build Command: vuoto
   - Output Directory: vuoto (la cartella principale)
3. Premi **Deploy**. A ogni `git push` il sito si aggiorna da solo.
4. Copia l'indirizzo che ti dà Vercel e controlla che sia quello inserito al punto 1.3 in Supabase.

## 4. Prova

Apri il sito da due dispositivi (o da una finestra normale e una in incognito) con due account diversi. Crea una partita con il primo, iscriviti con il secondo e scrivi in chat. Se qualcosa non funziona, apri la console del browser (F12): un errore che contiene `Content-Security-Policy` indica una risorsa bloccata dalle regole di `vercel.json`.

## Cosa fa il database (in breve)

- Senza account non si vede nulla.
- Gli altri vedono di te solo nickname, livello, lato, tipo di gioco preferito e foto. Nome, città e disponibilità sono privati.
- Solo chi organizza modifica o elimina la partita. L'organizzatore è iscritto automaticamente e non può abbandonare la propria partita.
- L'iscrizione passa da una funzione del database che controlla i posti in modo atomico: due persone non possono prendere lo stesso ultimo posto.
- I posti non possono scendere sotto il numero di iscritti. Le partite giocate non si modificano.
- La chat è leggibile e scrivibile solo da chi partecipa.
- Le valutazioni si danno solo dopo la partita e solo ai compagni di quella partita. Ognuno vede solo quelle che ha dato. Agli altri arriva solo la percentuale di presenza, e solo da 3 valutazioni in su.

## Limiti attuali

- **Niente notifiche push.** "Ci manca qualcuno" mette la partita in evidenza, ma non avvisa nessuno sul telefono.
- **Chat non in tempo reale.** I dati si aggiornano ogni 30 secondi e quando torni sull'app.
- **I Reel** restano solo sul dispositivo di chi li carica e spariscono ricaricando la pagina.
- **Piani gratuiti.** Vercel Hobby è solo per uso personale e non commerciale. Su Supabase Free il progetto va in pausa dopo una settimana senza attività.
- **Privacy.** Prima di aprire l'app al pubblico serve un'informativa privacy (GDPR), perché raccogli email e dati personali.
