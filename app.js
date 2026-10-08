/* =====================================================================
   PadelMatch: logica dell'app
   I dati stanno su Supabase. Le regole importanti (chi può fare cosa)
   sono nel database (supabase/schema.sql): qui ci sono solo interfaccia
   e chiamate.
   ===================================================================== */
"use strict";

/* ---------- Costanti ---------- */

const NOMI_GIORNI = ["Domenica", "Lunedì", "Martedì", "Mercoledì", "Giovedì", "Venerdì", "Sabato"];
const ORDINE_GIORNI = [1, 2, 3, 4, 5, 6, 0];
const FASCE = ["mattina", "pomeriggio", "sera"];
const LIVELLI = ["Principiante", "Intermedio", "Avanzato"];
const NICK_RE = /^[A-Za-z0-9_.\-]{3,20}$/;

const cityCoords = {
  milano: [45.4642, 9.19], roma: [41.9028, 12.4964], torino: [45.0703, 7.6869],
  napoli: [40.8518, 14.2681], bologna: [44.4949, 11.3426], firenze: [43.7696, 11.2558],
  palermo: [38.1157, 13.3615], bari: [41.1171, 16.8719], verona: [45.4384, 10.9916],
  genova: [44.4056, 8.9463], "reggio emilia": [44.6983, 10.6312], modena: [44.6471, 10.9252],
  parma: [44.8015, 10.3279], cesena: [44.1391, 12.2431], rimini: [44.0678, 12.5695]
};

/* ---------- Stato ---------- */

const stato = {
  uid: null,
  profilo: {},       // pubblico: nickname, level, side, mood, photo
  impostazioni: {},  // privato: full_name, city, availability
  partite: [],
  valutazioni: {},   // { matchId: { playerId: { presente, livello } } }
  affidabilita: {},  // { playerId: { tot, perc } }
  chatAperte: new Set(),
  bozze: {}          // testo non ancora inviato nelle chat, per partita
};

let sb = null;
let notificationTimer = null;
let aggiornamentoTimer = null;

const $ = (id) => document.getElementById(id);

/* ---------- Utilità ---------- */

function isoLocale(d) {
  return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}

function giorniDa(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

function formatDate(data) {
  if (!data) return "";
  const p = data.split("-");
  return p[2] + "/" + p[1] + "/" + p[0];
}

function etichettaGiorno(d) {
  if (d === isoLocale(new Date())) return "Oggi, ";
  if (d === isoLocale(giorniDa(1))) return "Domani, ";
  return "";
}

function partitaPassata(p) {
  return new Date(p.date + "T" + (p.time || "23:59")).getTime() < Date.now();
}

function fasciaDaOra(ora) {
  const h = Number(String(ora || "").split(":")[0]);
  if (h < 12) return "mattina";
  if (h < 18) return "pomeriggio";
  return "sera";
}

function giornoDaData(data) {
  return new Date(data + "T12:00").getDay();
}

function iniziali(nome) {
  return String(nome || "?").trim().split(/[\s_.\-]+/).filter(Boolean).slice(0, 2)
    .map((p) => p[0].toUpperCase()).join("") || "?";
}

function mostraNotifica(testo) {
  const n = $("notification");
  n.textContent = testo;
  n.classList.add("visible");
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => n.classList.remove("visible"), 3500);
}

// Messaggio leggibile da un errore di Supabase
function testoErrore(err, fallback) {
  if (!err) return fallback;
  const m = String(err.message || err.error_description || err);
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return "Connessione assente: controlla la rete e riprova.";
  if (/Invalid login credentials/i.test(m)) return "Email o password non corrette.";
  if (/Email not confirmed/i.test(m)) return "Conferma prima l'email: ti abbiamo mandato un link.";
  if (/already registered|already been registered/i.test(m)) return "Esiste già un account con questa email.";
  if (/Password should be at least/i.test(m)) return "La password deve avere almeno 6 caratteri.";
  if (/profiles_nickname_lower|profiles_nickname_key|duplicate key/i.test(m)) return "Questo nickname è già usato: scegline un altro.";
  if (/rate limit/i.test(m)) return "Troppi tentativi ravvicinati: aspetta qualche minuto.";
  if (err.code === "P0001") return m; // messaggi scritti da noi nel database
  if (err.code === "42501" || /row-level security/i.test(m)) return "Non hai il permesso per questa operazione.";
  console.error(err);
  return fallback;
}

function mioId() { return stato.uid; }
function iscritto(p) { return p.participants.some((x) => x.id === stato.uid); }
function eMia(p) { return p.creatorId === stato.uid; }

function latoProfilo() {
  const lato = stato.profilo.side || "";
  if (lato.startsWith("Sinistra")) return "Sinistra";
  if (lato.startsWith("Destra")) return "Destra";
  return "Entrambi";
}

function disponibile(giorno, fascia) {
  return (stato.impostazioni.availability || []).some((a) => a.day === giorno && a.slot === fascia);
}

/* ---------- Avvio e configurazione ---------- */

function mostraErroreSetup(testo) {
  const box = $("setupError");
  box.textContent = testo;
  box.hidden = false;
}

function inizializzaClient() {
  const cfg = window.PADELMATCH_CONFIG || {};
  if (!window.supabase || !window.supabase.createClient) {
    mostraErroreSetup("Non riesco a caricare la libreria di Supabase. Controlla la connessione e ricarica la pagina.");
    return false;
  }
  if (!cfg.supabaseUrl || !cfg.supabaseKey || /INCOLLA|xxxx/i.test(cfg.supabaseUrl + cfg.supabaseKey)) {
    mostraErroreSetup("Configurazione mancante: inserisci l'URL del progetto e la chiave pubblica di Supabase nel file config.js (vedi README).");
    return false;
  }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
  });
  return true;
}

/* ---------- Caricamento dati ---------- */

async function caricaProfilo() {
  const [p, s] = await Promise.all([
    sb.from("profiles").select("id, nickname, level, side, mood, photo").eq("id", stato.uid).single(),
    sb.from("profile_settings").select("full_name, city, availability").eq("id", stato.uid).single()
  ]);
  if (p.error) throw p.error;
  if (s.error) throw s.error;
  stato.profilo = p.data;
  stato.impostazioni = s.data;
  stato.impostazioni.availability = Array.isArray(s.data.availability) ? s.data.availability : [];
}

async function caricaPartite() {
  // anche gli ultimi 30 giorni, per poter valutare le partite giocate
  const { data, error } = await sb
    .from("matches")
    .select("id, city, club, address, lat, lng, match_date, match_time, level, mood, need_side, max_players, urgent, creator_id, creator:profiles!creator_id(nickname), match_players(player_id, joined_at, profiles(nickname))")
    .gte("match_date", isoLocale(giorniDa(-30)))
    .order("match_date", { ascending: true })
    .order("match_time", { ascending: true })
    .limit(300);
  if (error) throw error;

  const vecchie = new Map(stato.partite.map((p) => [p.id, p]));

  stato.partite = data.map((m) => {
    const partecipanti = (m.match_players || [])
      .slice()
      .sort((a, b) => String(a.joined_at).localeCompare(String(b.joined_at)))
      .map((x) => ({ id: x.player_id, nickname: x.profiles ? x.profiles.nickname : "giocatore" }));
    const prima = vecchie.get(m.id);
    return {
      id: m.id,
      city: m.city,
      club: m.club,
      address: m.address,
      lat: m.lat,
      lng: m.lng,
      date: m.match_date,
      time: String(m.match_time).slice(0, 5),
      level: m.level,
      mood: m.mood,
      needSide: m.need_side || "",
      maxPlayers: m.max_players,
      urgent: m.urgent,
      creatorId: m.creator_id,
      creator: m.creator ? m.creator.nickname : "",
      participants: partecipanti,
      players: partecipanti.length,
      messages: prima ? prima.messages : null
    };
  });
}

async function caricaValutazioni() {
  const { data, error } = await sb.from("feedback").select("match_id, rated_id, showed_up, level_cmp");
  if (error) throw error;
  stato.valutazioni = {};
  data.forEach((f) => {
    stato.valutazioni[f.match_id] = stato.valutazioni[f.match_id] || {};
    stato.valutazioni[f.match_id][f.rated_id] = { presente: f.showed_up, livello: f.level_cmp };
  });
}

async function caricaAffidabilita() {
  const ids = new Set();
  stato.partite.forEach((p) => p.participants.forEach((x) => { if (x.id !== stato.uid) ids.add(x.id); }));
  stato.affidabilita = {};
  if (!ids.size) return;
  const { data, error } = await sb.rpc("reliability", { p_ids: Array.from(ids) });
  if (error) throw error;
  (data || []).forEach((r) => { stato.affidabilita[r.player_id] = { tot: r.ratings, perc: r.present_pct }; });
}

async function aggiornaTutto(silenzioso) {
  try {
    await caricaPartite();
    await Promise.all([caricaValutazioni(), caricaAffidabilita()]);
    mostraPartite();
  } catch (err) {
    if (!silenzioso) mostraNotifica(testoErrore(err, "Non riesco a caricare le partite. Riprova tra poco."));
  }
}

/* ---------- Tema ---------- */

function aggiornaTema() {
  let scuro = false;
  try { scuro = localStorage.getItem("padelTheme") === "dark"; } catch (e) { /* storage non disponibile */ }
  document.body.classList.toggle("dark-theme", scuro);
  $("themeToggle").textContent = scuro ? "Tema chiaro" : "Tema scuro";
}

$("themeToggle").addEventListener("click", () => {
  const scuro = document.body.classList.contains("dark-theme");
  try { localStorage.setItem("padelTheme", scuro ? "light" : "dark"); } catch (e) { /* ignora */ }
  aggiornaTema();
});

/* ---------- Profilo ---------- */

function aggiornaAvatar() {
  const box = $("profileAvatar");
  box.replaceChildren();
  if (stato.profilo.photo) {
    const img = document.createElement("img");
    img.src = stato.profilo.photo;
    img.alt = "Foto profilo";
    box.appendChild(img);
  } else {
    box.textContent = iniziali(stato.profilo.nickname);
  }
}

function aggiornaProfilo() {
  $("profileName").textContent = stato.profilo.nickname ? "@" + stato.profilo.nickname : "Profilo";
  const mood = { Competitiva: "Partite competitive", Rilassata: "Partite rilassate", "Per imparare": "Vuole imparare" }[stato.profilo.mood];
  $("profileSummary").textContent = [stato.impostazioni.full_name, stato.profilo.level, stato.profilo.side, mood, stato.impostazioni.city]
    .filter(Boolean).join(" · ");
  aggiornaAvatar();
}

function caricaProfiloNeiCampi() {
  $("userNickname").value = stato.profilo.nickname || "";
  $("userName").value = stato.impostazioni.full_name || "";
  $("userLevel").value = stato.profilo.level || "Intermedio";
  $("userSide").value = stato.profilo.side || "Entrambi i lati";
  $("userMood").value = stato.profilo.mood || "Rilassata";
  $("userCity").value = stato.impostazioni.city || "";
}

function aggiornaStatistiche() {
  const compagni = new Set();
  const mie = stato.partite.filter(iscritto);
  mie.forEach((p) => p.participants.forEach((x) => { if (x.id !== stato.uid) compagni.add(x.id); }));
  $("statCreated").textContent = stato.partite.filter(eMia).length;
  $("statJoined").textContent = mie.length;
  $("statPlayers").textContent = compagni.size;
}

$("profileForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("profileMessage");
  const nick = $("userNickname").value.trim();
  if (!NICK_RE.test(nick)) {
    msg.textContent = "Il nickname deve avere 3-20 caratteri: lettere, numeri, punto, trattino o underscore.";
    return;
  }
  const bottone = e.submitter;
  if (bottone) bottone.disabled = true;
  msg.textContent = "Salvataggio...";

  const pubblico = { nickname: nick, level: $("userLevel").value, side: $("userSide").value, mood: $("userMood").value };
  const privato = { full_name: $("userName").value.trim() || null, city: $("userCity").value.trim() || null };

  const [a, b] = await Promise.all([
    sb.from("profiles").update(pubblico).eq("id", stato.uid),
    sb.from("profile_settings").update(privato).eq("id", stato.uid)
  ]);
  if (bottone) bottone.disabled = false;

  if (a.error || b.error) {
    msg.textContent = testoErrore(a.error || b.error, "Non sono riuscito a salvare il profilo. Riprova.");
    return;
  }
  Object.assign(stato.profilo, pubblico);
  Object.assign(stato.impostazioni, privato);
  aggiornaProfilo();
  msg.textContent = "Profilo salvato";
  mostraNotifica("Profilo salvato");
  setTimeout(() => { msg.textContent = ""; }, 3000);
  aggiornaTutto(true);
});

$("profilePhoto").addEventListener("change", () => {
  const input = $("profilePhoto");
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    input.value = "";
    mostraNotifica("Seleziona un file immagine");
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = async () => {
      const size = 192;
      const c = document.createElement("canvas");
      c.width = size;
      c.height = size;
      const k = Math.max(size / img.width, size / img.height);
      const w = img.width * k;
      const h = img.height * k;
      c.getContext("2d").drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      const foto = c.toDataURL("image/jpeg", 0.8);
      const { error } = await sb.from("profiles").update({ photo: foto }).eq("id", stato.uid);
      input.value = "";
      if (error) { mostraNotifica(testoErrore(error, "Non sono riuscito a salvare la foto")); return; }
      stato.profilo.photo = foto;
      aggiornaAvatar();
      mostraNotifica("Foto profilo aggiornata");
    };
    img.onerror = () => mostraNotifica("Immagine non leggibile: prova con un altro file");
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
});

$("removePhoto").addEventListener("click", async () => {
  const { error } = await sb.from("profiles").update({ photo: null }).eq("id", stato.uid);
  if (error) { mostraNotifica(testoErrore(error, "Non sono riuscito a rimuovere la foto")); return; }
  stato.profilo.photo = null;
  aggiornaAvatar();
  mostraNotifica("Foto profilo rimossa");
});

/* ---------- Disponibilità ---------- */

let salvataggioDispo = null;

function disegnaDisponibilita() {
  const grid = $("availabilityGrid");
  grid.replaceChildren();
  grid.appendChild(document.createElement("span"));
  FASCE.forEach((f) => {
    const h = document.createElement("span");
    h.className = "avail-head";
    h.textContent = f.charAt(0).toUpperCase() + f.slice(1);
    grid.appendChild(h);
  });

  ORDINE_GIORNI.forEach((g) => {
    const label = document.createElement("span");
    label.className = "avail-day";
    label.textContent = NOMI_GIORNI[g].slice(0, 3);
    grid.appendChild(label);

    FASCE.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button";
      const attivo = disponibile(g, f);
      b.className = "avail-cell" + (attivo ? " on" : "");
      b.setAttribute("aria-pressed", attivo ? "true" : "false");
      b.setAttribute("aria-label", NOMI_GIORNI[g] + " " + f);
      b.textContent = attivo ? "✓" : "";
      b.addEventListener("click", () => {
        let lista = stato.impostazioni.availability || [];
        lista = disponibile(g, f)
          ? lista.filter((a) => !(a.day === g && a.slot === f))
          : lista.concat([{ day: g, slot: f }]);
        stato.impostazioni.availability = lista;
        disegnaDisponibilita();
        mostraPartite();
        // salvo dopo una breve pausa, così più tocchi di fila fanno un solo salvataggio
        clearTimeout(salvataggioDispo);
        salvataggioDispo = setTimeout(async () => {
          const { error } = await sb.from("profile_settings")
            .update({ availability: stato.impostazioni.availability }).eq("id", stato.uid);
          if (error) mostraNotifica(testoErrore(error, "Disponibilità non salvata: riprova"));
        }, 600);
      });
      grid.appendChild(b);
    });
  });
}

/* ---------- Partite per te ---------- */

function valutaPerMe(p) {
  if (eMia(p) || iscritto(p) || partitaPassata(p) || p.players >= p.maxPlayers) return null;

  const motivi = [];
  let punti = 0;

  const dispo = stato.impostazioni.availability || [];
  if (dispo.length) {
    const g = giornoDaData(p.date);
    const f = fasciaDaOra(p.time);
    if (!disponibile(g, f)) return null;
    motivi.push(NOMI_GIORNI[g] + " " + f + ", quando sei libero");
    punti += 3;
  }

  const citta = stato.impostazioni.city;
  if (citta) {
    const testo = (p.city + " " + p.club + " " + (p.address || "")).toLowerCase();
    if (!testo.includes(citta.toLowerCase())) return null;
    punti += 1;
  }

  if (stato.profilo.level) {
    const diff = Math.abs(LIVELLI.indexOf(p.level) - LIVELLI.indexOf(stato.profilo.level));
    if (diff > 1) return null;
    if (diff === 0) { motivi.push("il tuo livello"); punti += 2; } else { motivi.push("livello vicino al tuo"); punti += 1; }
  }

  if (stato.profilo.mood && p.mood === stato.profilo.mood) {
    motivi.push("partita " + p.mood.toLowerCase() + " come piace a te");
    punti += 1;
  }

  if (p.needSide) {
    const mio = latoProfilo();
    if (mio === p.needSide || mio === "Entrambi") {
      motivi.push("cercano proprio il lato " + p.needSide.toLowerCase());
      punti += 2;
    } else {
      punti -= 1;
    }
  }

  if (p.urgent) { motivi.unshift("manca solo qualcuno: ti aspettano"); punti += 2; }
  return { punti, motivi };
}

function disegnaPerTe() {
  const box = $("forYou");
  box.replaceChildren();
  const titolo = document.createElement("h2");
  titolo.textContent = "Per te";
  box.appendChild(titolo);

  const dispo = stato.impostazioni.availability || [];
  const proposte = stato.partite
    .map((p) => ({ p, v: valutaPerMe(p) }))
    .filter((x) => x.v)
    .sort((a, b) => b.v.punti - a.v.punti || (a.p.date + a.p.time).localeCompare(b.p.date + b.p.time))
    .slice(0, 3);

  if (!dispo.length) {
    const vuoto = document.createElement("p");
    vuoto.className = "hint";
    vuoto.textContent = "Dicci quando sei libero (scheda Profilo) e qui ti proponiamo le partite adatte a te.";
    box.appendChild(vuoto);
  }

  if (!proposte.length) {
    if (dispo.length) {
      const nessuna = document.createElement("p");
      nessuna.className = "hint";
      nessuna.textContent = "Nessuna partita adatta nei momenti in cui sei libero. Creane una tu: la vedranno i giocatori compatibili.";
      box.appendChild(nessuna);
    }
    return;
  }

  proposte.forEach(({ p, v }) => {
    const riga = document.createElement("button");
    riga.type = "button";
    riga.className = "for-you-item";
    const t = document.createElement("strong");
    t.textContent = etichettaGiorno(p.date) + formatDate(p.date) + " alle " + p.time + " · " + p.club;
    const m = document.createElement("span");
    m.textContent = v.motivi.join(", ") || "Posti liberi al tuo livello";
    riga.append(t, m);
    riga.addEventListener("click", () => {
      const card = $("card-" + p.id);
      if (!card) return;
      card.scrollIntoView({ behavior: "smooth", block: "center" });
      card.classList.add("flash");
      setTimeout(() => card.classList.remove("flash"), 1600);
    });
    box.appendChild(riga);
  });
}

/* ---------- Valutazioni dopo la partita ---------- */

function disegnaValutazioni() {
  const lista = $("feedbackList");
  lista.replaceChildren();

  const giocate = stato.partite
    .filter((p) => partitaPassata(p) && iscritto(p))
    .sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time))
    .slice(0, 5);

  if (!giocate.length) {
    const vuoto = document.createElement("p");
    vuoto.className = "hint";
    vuoto.textContent = "Nessuna partita da valutare. Dopo le partite a cui partecipi, le trovi qui.";
    lista.appendChild(vuoto);
    return;
  }

  giocate.forEach((p) => {
    const blocco = document.createElement("div");
    blocco.className = "fb-match";
    const t = document.createElement("strong");
    t.textContent = formatDate(p.date) + " · " + p.club;
    blocco.appendChild(t);

    const altri = p.participants.filter((x) => x.id !== stato.uid);
    if (!altri.length) {
      const s = document.createElement("p");
      s.className = "hint";
      s.textContent = "Nessun altro giocatore in questa partita.";
      blocco.appendChild(s);
    }

    altri.forEach((g) => {
      const v = (stato.valutazioni[p.id] || {})[g.id] || {};
      const riga = document.createElement("div");
      riga.className = "fb-row";
      const n = document.createElement("span");
      n.className = "fb-name";
      n.textContent = "@" + g.nickname;
      riga.appendChild(n);

      const gruppo = (opzioni, chiave) => {
        const box = document.createElement("div");
        box.className = "fb-group";
        opzioni.forEach((o) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = o.label;
          const scelto = v[chiave] === o.value;
          b.className = "fb-opt" + (scelto ? " on" : "");
          b.setAttribute("aria-pressed", scelto ? "true" : "false");
          b.addEventListener("click", async () => {
            const nuovo = Object.assign({}, v, { [chiave]: o.value });
            b.disabled = true;
            const { error } = await sb.from("feedback").upsert({
              match_id: p.id,
              rater_id: stato.uid,
              rated_id: g.id,
              showed_up: typeof nuovo.presente === "boolean" ? nuovo.presente : null,
              level_cmp: nuovo.livello || null
            }, { onConflict: "match_id,rater_id,rated_id" });
            if (error) {
              b.disabled = false;
              mostraNotifica(testoErrore(error, "Valutazione non salvata: riprova"));
              return;
            }
            stato.valutazioni[p.id] = stato.valutazioni[p.id] || {};
            stato.valutazioni[p.id][g.id] = nuovo;
            disegnaValutazioni();
          });
          box.appendChild(b);
        });
        return box;
      };

      riga.appendChild(gruppo([{ label: "Presente", value: true }, { label: "Non è venuto", value: false }], "presente"));
      riga.appendChild(gruppo([
        { label: "Più forte di me", value: "piu" }, { label: "Pari", value: "pari" }, { label: "Meno forte", value: "meno" }
      ], "livello"));
      blocco.appendChild(riga);
    });

    lista.appendChild(blocco);
  });
}

/* ---------- Mappa ---------- */

let popupMap = null, popupTiles = null, popupMarker = null, popupCorrente = null;

function coordinatePartita(p) {
  if (Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lng)) && p.lat !== null && p.lng !== null) {
    return [Number(p.lat), Number(p.lng)];
  }
  return cityCoords[String(p.city || "").trim().toLowerCase()] || [41.9028, 12.4964];
}

async function geocodifica(indirizzo, citta) {
  try {
    const q = encodeURIComponent(indirizzo + ", " + citta + ", Italia");
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=json&limit=1&q=" + q, {
      signal: AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (d && d[0]) return [Number(d[0].lat), Number(d[0].lon)];
  } catch (e) { /* senza coordinate usiamo il centro città */ }
  return null;
}

function apriMappa(p) {
  const modal = $("mapModal");
  popupCorrente = p;
  $("mapModalTitle").textContent = p.club;
  $("mapModalAddr").textContent = (p.address || "Indirizzo non indicato") + ", " + p.city;
  $("mapDirections").href = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent((p.address || p.club) + ", " + p.city);
  modal.classList.add("visible");
  document.body.style.overflow = "hidden";

  if (!window.L) {
    $("popupMap").textContent = "Mappa non disponibile: usa il link per le indicazioni.";
    return;
  }
  const c = coordinatePartita(p);
  if (!popupMap) {
    popupMap = L.map("popupMap", { zoomControl: false, attributionControl: false, maxZoom: 18 });
    L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(popupMap);
    L.control.zoom({ position: "bottomright" }).addTo(popupMap);
  }
  if (popupTiles) popupMap.removeLayer(popupTiles);
  popupMap.getContainer().classList.remove("osm-fallback");
  const base = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: 19, maxZoom: 18, attribution: "&copy; Esri &middot; OpenStreetMap"
  });
  popupTiles = base.addTo(popupMap);
  let errori = 0;
  base.on("tileerror", () => {
    if (++errori !== 3) return;
    popupMap.removeLayer(popupTiles);
    popupMap.getContainer().classList.add("osm-fallback");
    popupTiles = L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap", maxZoom: 17
    }).addTo(popupMap);
  });
  if (popupMarker) popupMap.removeLayer(popupMarker);
  const el = document.createElement("div");
  el.className = "pm-wrap";
  const pin = document.createElement("div");
  pin.className = "pm-pin";
  const et = document.createElement("span");
  et.className = "pm-label";
  et.textContent = p.club;
  el.append(pin, et);
  popupMarker = L.marker(c, { icon: L.divIcon({ className: "pm-icon", html: el, iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(popupMap);
  popupMap.setView(c, 16);
  setTimeout(() => { if (popupCorrente === p) { popupMap.invalidateSize(); popupMap.setView(c, 16); } }, 80);
}

function chiudiMappa() {
  $("mapModal").classList.remove("visible");
  document.body.style.overflow = "";
}

$("mapModalClose").addEventListener("click", chiudiMappa);
$("mapModal").addEventListener("click", (e) => { if (e.target === e.currentTarget) chiudiMappa(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { chiudiMappa(); chiudiModifica(); }
});

/* ---------- Chat ---------- */

async function caricaMessaggi(p) {
  const { data, error } = await sb
    .from("messages")
    .select("id, author_id, body, created_at, author:profiles(nickname)")
    .eq("match_id", p.id)
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw error;
  p.messages = data.map((m) => ({ id: m.id, authorId: m.author_id, author: m.author ? m.author.nickname : "giocatore", text: m.body }));
}

function renderMessages(p, box) {
  box.replaceChildren();
  if (!p.messages) {
    const l = document.createElement("div");
    l.className = "chat-empty";
    l.textContent = "Caricamento messaggi...";
    box.appendChild(l);
    return;
  }
  if (!p.messages.length) {
    const v = document.createElement("div");
    v.className = "chat-empty";
    v.textContent = "Nessun messaggio. Scrivi tu il primo.";
    box.appendChild(v);
    return;
  }
  p.messages.forEach((m) => {
    const mio = m.authorId === stato.uid;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble " + (mio ? "me" : "other");
    const a = document.createElement("span");
    a.className = "chat-author";
    a.textContent = mio ? "Tu" : "@" + m.author;
    bubble.appendChild(a);
    bubble.appendChild(document.createTextNode(m.text));
    box.appendChild(bubble);
  });
  box.scrollTop = box.scrollHeight;
}

function etichettaChat(p, bottone) {
  bottone.replaceChildren(document.createTextNode("Chat "));
  if (p.messages) {
    const pill = document.createElement("span");
    pill.className = "chat-count-pill";
    pill.textContent = p.messages.length;
    bottone.appendChild(pill);
  }
}

function creaChat(p, card, chatButton) {
  const chatBox = document.createElement("div");
  chatBox.className = "chat-box";
  const header = document.createElement("div");
  header.className = "chat-header";
  header.textContent = "Chat della partita";
  chatBox.appendChild(header);

  if (!iscritto(p)) {
    const lock = document.createElement("p");
    lock.className = "chat-locked";
    lock.textContent = "La chat è visibile solo a chi partecipa. Iscriviti per leggere e scrivere.";
    chatBox.appendChild(lock);
    card.appendChild(chatBox);
    return chatBox;
  }

  const box = document.createElement("div");
  box.className = "chat-messages";
  const form = document.createElement("form");
  form.className = "chat-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Scrivi un messaggio...";
  input.maxLength = 500;
  input.required = true;
  input.setAttribute("aria-label", "Messaggio");
  input.dataset.chat = p.id;
  input.value = stato.bozze[p.id] || "";
  input.addEventListener("input", () => { stato.bozze[p.id] = input.value; });
  const invia = document.createElement("button");
  invia.type = "submit";
  invia.textContent = "Invia";
  form.append(input, invia);
  chatBox.append(box, form);
  renderMessages(p, box);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const testo = input.value.trim();
    if (!testo) return;
    invia.disabled = true;
    const { error } = await sb.from("messages").insert({ match_id: p.id, body: testo });
    invia.disabled = false;
    if (error) { mostraNotifica(testoErrore(error, "Messaggio non inviato: riprova")); return; }
    input.value = "";
    delete stato.bozze[p.id];
    try { await caricaMessaggi(p); } catch (err) { /* il messaggio è comunque salvato */ }
    renderMessages(p, box);
  });

  chatBox.ricarica = async () => {
    try {
      await caricaMessaggi(p);
      renderMessages(p, box);
      if (!chatBox.classList.contains("visible")) etichettaChat(p, chatButton);
    } catch (err) {
      box.replaceChildren();
      const x = document.createElement("div");
      x.className = "chat-empty";
      x.textContent = testoErrore(err, "Non riesco a caricare i messaggi.");
      box.appendChild(x);
    }
  };

  card.appendChild(chatBox);
  return chatBox;
}

/* ---------- Partecipanti e condivisione ---------- */

function creaPartecipanti(p) {
  const box = document.createElement("div");
  box.className = "participants";
  box.appendChild(document.createTextNode("Partecipanti: "));
  if (!p.participants.length) {
    box.appendChild(document.createTextNode("nessuno ancora"));
    return box;
  }
  p.participants.forEach((g) => {
    const chip = document.createElement("span");
    chip.className = "player-chip";
    chip.textContent = g.id === stato.uid ? "Tu" : "@" + g.nickname;
    const aff = stato.affidabilita[g.id];
    if (aff && g.id !== stato.uid) {
      const tag = document.createElement("span");
      tag.className = "rel-tag " + (aff.perc >= 80 ? "ok" : "warn");
      tag.textContent = aff.perc + "% presente";
      tag.title = "Calcolato su " + aff.tot + " valutazioni di altri giocatori";
      chip.appendChild(tag);
    }
    box.appendChild(chip);
  });
  return box;
}

function creaCondivisione(p) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "share-btn";
  b.textContent = "Condividi partita";
  b.addEventListener("click", async () => {
    const testo = "Partita di padel a " + p.city + ", " + p.club + ", il " + formatDate(p.date) + " alle " + p.time +
      ". Cerchiamo giocatori su PadelMatch: " + location.origin;
    if (navigator.share) {
      try { await navigator.share({ title: "PadelMatch", text: testo }); } catch (e) { /* annullato */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(testo);
      mostraNotifica("Dettagli della partita copiati");
    } catch (e) {
      mostraNotifica("Condivisione non disponibile su questo browser");
    }
  });
  return b;
}

/* ---------- Azioni sulle partite ---------- */

async function eseguiAzione(bottone, azione, okMsg, erroreMsg) {
  if (bottone) bottone.disabled = true;
  const { error } = await azione();
  if (error) {
    if (bottone) bottone.disabled = false;
    mostraNotifica(testoErrore(error, erroreMsg));
    await aggiornaTutto(true);
    return false;
  }
  mostraNotifica(okMsg);
  await aggiornaTutto();
  return true;
}

function apriModifica(p) {
  $("editId").value = p.id;
  $("editCity").value = p.city;
  $("editClub").value = p.club;
  $("editAddress").value = p.address;
  $("editDate").value = p.date;
  $("editDate").min = isoLocale(new Date());
  $("editTime").value = p.time;
  $("editLevel").value = p.level;
  $("editPlayers").value = p.maxPlayers;
  $("editMood").value = p.mood || "Rilassata";
  $("editNeedSide").value = p.needSide || "";
  $("editModal").classList.add("visible");
}

function chiudiModifica() {
  $("editModal").classList.remove("visible");
  $("editForm").reset();
}

$("closeModal").addEventListener("click", chiudiModifica);
$("cancelEdit").addEventListener("click", chiudiModifica);

$("editForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("editId").value;
  const p = stato.partite.find((x) => x.id === id);
  if (!p) { chiudiModifica(); return; }

  const posti = Number($("editPlayers").value);
  if (posti < p.players) {
    mostraNotifica("Ci sono già " + p.players + " iscritti: i posti non possono essere meno di " + p.players);
    return;
  }

  const citta = $("editCity").value.trim();
  const indirizzo = $("editAddress").value.trim();
  const modifiche = {
    city: citta,
    club: $("editClub").value.trim(),
    address: indirizzo,
    match_date: $("editDate").value,
    match_time: $("editTime").value,
    level: $("editLevel").value,
    max_players: posti,
    mood: $("editMood").value,
    need_side: $("editNeedSide").value
  };

  const bottone = e.submitter;
  if (bottone) bottone.disabled = true;
  if (citta !== p.city || indirizzo !== p.address) {
    const c = await geocodifica(indirizzo, citta);
    modifiche.lat = c ? c[0] : null;
    modifiche.lng = c ? c[1] : null;
  }
  const { error } = await sb.from("matches").update(modifiche).eq("id", id);
  if (bottone) bottone.disabled = false;
  if (error) { mostraNotifica(testoErrore(error, "Modifiche non salvate: riprova")); return; }
  chiudiModifica();
  mostraNotifica("Partita modificata");
  aggiornaTutto();
});

$("matchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msg = $("formMessage");
  const citta = $("newCity").value.trim();
  const indirizzo = $("newAddress").value.trim();
  const nuova = {
    city: citta,
    club: $("newClub").value.trim(),
    address: indirizzo,
    match_date: $("newDate").value,
    match_time: $("newTime").value,
    level: $("newLevel").value,
    mood: $("newMood").value,
    need_side: $("newNeedSide").value,
    max_players: Number($("newPlayers").value)
  };

  if (nuova.max_players < 2 || nuova.max_players > 4) { msg.textContent = "I posti totali devono essere tra 2 e 4."; return; }
  if (partitaPassata({ date: nuova.match_date, time: nuova.match_time })) {
    msg.textContent = "Data e ora sono già passate: scegli un momento futuro.";
    return;
  }

  const bottone = e.submitter;
  if (bottone) bottone.disabled = true;
  msg.textContent = "Pubblicazione...";
  const c = await geocodifica(indirizzo, citta);
  if (c) { nuova.lat = c[0]; nuova.lng = c[1]; }

  const { error } = await sb.from("matches").insert(nuova);
  if (bottone) bottone.disabled = false;
  if (error) { msg.textContent = testoErrore(error, "Partita non pubblicata: riprova."); return; }

  $("matchForm").reset();
  msg.textContent = "Partita pubblicata";
  mostraNotifica("Partita pubblicata");
  setTimeout(() => { msg.textContent = ""; }, 3500);
  await aggiornaTutto();
  vaiAScheda("tab-partite");
});

/* ---------- Elenco partite ---------- */

function pallini(p) {
  const w = document.createElement("span");
  w.className = "dots";
  for (let i = 0; i < p.maxPlayers; i++) {
    const d = document.createElement("span");
    d.className = "dot" + (i < p.players ? " on" : "");
    w.appendChild(d);
  }
  return w;
}

function getWeekendRange() {
  const oggi = new Date();
  const g = oggi.getDay();
  const ven = new Date(oggi);
  ven.setDate(oggi.getDate() + (g === 0 ? -2 : g === 6 ? -1 : 5 - g));
  const dom = new Date(ven);
  dom.setDate(ven.getDate() + 2);
  return { venerdi: isoLocale(ven), domenica: isoLocale(dom) };
}

function creaCard(p) {
  const liberi = p.maxPlayers - p.players;
  const completa = liberi <= 0;
  const sonoIscritto = iscritto(p);
  const mia = eMia(p);

  const card = document.createElement("article");
  card.className = "match-card lvl-" + p.level;
  card.id = "card-" + p.id;

  if (p.urgent && !completa) {
    const banner = document.createElement("div");
    banner.className = "urgent-banner";
    banner.textContent = liberi === 1 ? "Manca 1 giocatore" : "Mancano " + liberi + " giocatori";
    card.appendChild(banner);
  }

  const info = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = p.city + " · " + p.club;
  const date = document.createElement("p");
  date.textContent = etichettaGiorno(p.date) + formatDate(p.date) + " alle " + p.time;
  const address = document.createElement("p");
  address.textContent = p.address || "Indirizzo non indicato";

  const level = document.createElement("p");
  const badge = document.createElement("span");
  badge.className = "badge lvl-" + p.level;
  badge.textContent = p.level;
  level.appendChild(badge);
  if (p.mood) {
    const mb = document.createElement("span");
    mb.className = "badge mood-badge";
    mb.textContent = p.mood;
    level.appendChild(mb);
  }
  if (p.needSide && !completa) {
    const sb2 = document.createElement("span");
    sb2.className = "badge side-badge";
    sb2.textContent = "Cercano: lato " + p.needSide.toLowerCase();
    level.appendChild(sb2);
  }

  const places = document.createElement("p");
  places.textContent = "Posti liberi: " + Math.max(liberi, 0) + "/" + p.maxPlayers;
  if (completa) places.className = "full";
  places.appendChild(pallini(p));

  info.append(title, date, address, level, places);
  if (p.creator) {
    const cl = document.createElement("span");
    cl.className = "creator-label";
    cl.textContent = "Organizzato da: " + (mia ? "te" : "@" + p.creator);
    info.appendChild(cl);
  }

  const actions = document.createElement("div");
  actions.className = "actions-row";

  const join = document.createElement("button");
  join.type = "button";
  if (sonoIscritto && mia) {
    join.textContent = "Organizzi tu";
    join.disabled = true;
  } else if (sonoIscritto) {
    join.textContent = "Annulla iscrizione";
    join.className = "cancel";
    join.addEventListener("click", () => eseguiAzione(join, () => sb.rpc("leave_match", { p_match: p.id }),
      "Iscrizione annullata", "Non sono riuscito ad annullare l'iscrizione"));
  } else if (completa) {
    join.textContent = "Completa";
    join.disabled = true;
  } else {
    join.textContent = "Partecipa";
    join.addEventListener("click", () => eseguiAzione(join, () => sb.rpc("join_match", { p_match: p.id }),
      "Ti sei iscritto alla partita", "Iscrizione non riuscita"));
  }

  const chatButton = document.createElement("button");
  chatButton.type = "button";
  chatButton.className = "chat-toggle-btn";
  etichettaChat(p, chatButton);

  const mapButton = document.createElement("button");
  mapButton.type = "button";
  mapButton.className = "secondary";
  mapButton.textContent = "Vedi mappa";
  mapButton.addEventListener("click", () => apriMappa(p));

  actions.append(join, chatButton, mapButton);
  card.append(info, creaPartecipanti(p), actions, creaCondivisione(p));

  if (mia) {
    const manage = document.createElement("div");
    manage.className = "manage-row";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "edit-button";
    edit.textContent = "Modifica";
    edit.addEventListener("click", () => apriModifica(p));
    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete-button";
    del.textContent = "Elimina";
    del.addEventListener("click", () => {
      if (!confirm("Vuoi davvero eliminare questa partita? Gli iscritti la perderanno.")) return;
      eseguiAzione(del, () => sb.from("matches").delete().eq("id", p.id), "Partita eliminata", "Non sono riuscito a eliminare la partita");
    });
    manage.append(edit, del);

    if (!completa) {
      const urg = document.createElement("button");
      urg.type = "button";
      urg.className = "urgent-button" + (p.urgent ? " on" : "");
      urg.textContent = p.urgent ? "Togli dall'evidenza" : "Ci manca qualcuno";
      urg.addEventListener("click", () => eseguiAzione(urg,
        () => sb.from("matches").update({ urgent: !p.urgent }).eq("id", p.id),
        p.urgent ? "Partita tolta dall'evidenza" : "Partita in evidenza: compare in cima e nei suggerimenti dei giocatori compatibili",
        "Non sono riuscito a cambiare l'evidenza"));
      manage.appendChild(urg);
    }
    card.appendChild(manage);
  }

  const chatBox = creaChat(p, card, chatButton);
  if (stato.chatAperte.has(p.id)) {
    chatBox.classList.add("visible");
    chatButton.textContent = "Chiudi chat";
    if (chatBox.ricarica) chatBox.ricarica();
  }
  chatButton.addEventListener("click", () => {
    const aperta = chatBox.classList.toggle("visible");
    if (aperta) {
      stato.chatAperte.add(p.id);
      chatButton.textContent = "Chiudi chat";
      if (chatBox.ricarica) chatBox.ricarica();
    } else {
      stato.chatAperte.delete(p.id);
      etichettaChat(p, chatButton);
    }
  });

  return card;
}

function mostraPartite() {
  aggiornaStatistiche();

  const testo = $("searchInput").value.toLowerCase().trim();
  const livello = $("levelFilter").value;
  const tipo = $("moodFilter").value;
  const giorno = $("dateFilter").value;
  const periodo = $("dateRangeFilter").value;
  const oggi = isoLocale(new Date());
  const domani = isoLocale(giorniDa(1));
  const we = getWeekendRange();

  const filtrate = stato.partite.filter((p) => {
    if (partitaPassata(p)) return false;
    if (!(p.city + " " + p.club + " " + (p.address || "")).toLowerCase().includes(testo)) return false;
    if (livello && p.level !== livello) return false;
    if (tipo && p.mood !== tipo) return false;
    if (giorno) return p.date === giorno;
    if (periodo === "today") return p.date === oggi;
    if (periodo === "tomorrow") return p.date === domani;
    if (periodo === "weekend") return p.date >= we.venerdi && p.date <= we.domenica;
    return true;
  });

  filtrate.sort((a, b) => {
    const ua = a.urgent && a.players < a.maxPlayers ? 0 : 1;
    const ub = b.urgent && b.players < b.maxPlayers ? 0 : 1;
    return ua - ub || (a.date + a.time).localeCompare(b.date + b.time);
  });

  // se stai scrivendo in una chat, dopo il ridisegno ritrovi cursore e testo
  const attivo = document.activeElement;
  const chatInScrittura = attivo && attivo.dataset ? attivo.dataset.chat : null;

  const box = $("matches");
  box.replaceChildren(...filtrate.map(creaCard));

  if (chatInScrittura) {
    const input = box.querySelector('input[data-chat="' + CSS.escape(chatInScrittura) + '"]');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }
  $("noResults").style.display = filtrate.length ? "none" : "block";

  disegnaPerTe();
  disegnaValutazioni();
}

["searchInput", "dateFilter"].forEach((id) => $(id).addEventListener("input", mostraPartite));
["levelFilter", "dateRangeFilter", "moodFilter"].forEach((id) => $(id).addEventListener("change", mostraPartite));
$("resetButton").addEventListener("click", () => {
  ["searchInput", "levelFilter", "dateFilter", "dateRangeFilter", "moodFilter"].forEach((id) => { $(id).value = ""; });
  mostraPartite();
});

/* ---------- Navigazione ---------- */

function vaiAScheda(id) {
  document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.tab === id));
  document.querySelectorAll(".app-tab").forEach((s) => s.classList.toggle("tab-active", s.id === id));
}

document.querySelectorAll(".nav-item").forEach((b) => b.addEventListener("click", () => vaiAScheda(b.dataset.tab)));

/* ---------- Accesso ---------- */

function messaggioAccesso(testo, errore) {
  const m = $("authMessage");
  m.textContent = testo;
  m.style.color = errore ? "var(--red)" : "var(--green)";
}

$("showLogin").addEventListener("click", () => {
  $("loginForm").style.display = "block";
  $("registerForm").style.display = "none";
  $("showLogin").classList.add("active");
  $("showRegister").classList.remove("active");
  messaggioAccesso("", false);
});

$("showRegister").addEventListener("click", () => {
  $("loginForm").style.display = "none";
  $("registerForm").style.display = "block";
  $("showLogin").classList.remove("active");
  $("showRegister").classList.add("active");
  messaggioAccesso("", false);
});

$("registerForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nickname = $("registerNickname").value.trim();
  const email = $("registerEmail").value.trim();
  const password = $("registerPassword").value;
  const nome = $("registerName").value.trim();

  if (!NICK_RE.test(nickname)) {
    messaggioAccesso("Il nickname deve avere 3-20 caratteri: lettere, numeri, punto, trattino o underscore.", true);
    return;
  }
  if (password.length < 6) { messaggioAccesso("La password deve avere almeno 6 caratteri.", true); return; }

  const bottone = e.submitter;
  if (bottone) bottone.disabled = true;
  messaggioAccesso("Creazione account...", false);
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { nickname, full_name: nome }, emailRedirectTo: location.origin + location.pathname }
  });
  if (bottone) bottone.disabled = false;
  if (error) { messaggioAccesso(testoErrore(error, "Registrazione non riuscita: riprova."), true); return; }

  if (!data.session) {
    messaggioAccesso("Ti abbiamo mandato un'email: apri il link per confermare l'account, poi accedi.", false);
    return;
  }
  messaggioAccesso("Account creato", false);
});

$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const bottone = e.submitter;
  if (bottone) bottone.disabled = true;
  messaggioAccesso("Accesso...", false);
  const { error } = await sb.auth.signInWithPassword({
    email: $("loginEmail").value.trim(),
    password: $("loginPassword").value
  });
  if (bottone) bottone.disabled = false;
  if (error) messaggioAccesso(testoErrore(error, "Accesso non riuscito: riprova."), true);
});

$("forgotPassword").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim();
  if (!email) { messaggioAccesso("Scrivi la tua email qui sopra, poi tocca di nuovo «Password dimenticata?».", true); return; }
  const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  if (error) { messaggioAccesso(testoErrore(error, "Non sono riuscito a inviare l'email."), true); return; }
  // stesso messaggio che l'account esista o no, per non rivelare chi è registrato
  messaggioAccesso("Se l'email è registrata, riceverai un link per scegliere una nuova password.", false);
});

$("logoutBtn").addEventListener("click", async () => {
  await sb.auth.signOut();
});

async function entra(session) {
  stato.uid = session.user.id;
  $("authScreen").style.display = "none";
  try {
    await caricaProfilo();
  } catch (err) {
    mostraNotifica(testoErrore(err, "Non riesco a caricare il tuo profilo. Ricarica la pagina."));
    return;
  }
  caricaProfiloNeiCampi();
  aggiornaProfilo();
  disegnaDisponibilita();
  await aggiornaTutto();
  clearInterval(aggiornamentoTimer);
  aggiornamentoTimer = setInterval(() => { if (!document.hidden) aggiornaTutto(true); }, 30000);
}

function esci() {
  stato.uid = null;
  stato.profilo = {};
  stato.impostazioni = {};
  stato.partite = [];
  stato.valutazioni = {};
  stato.affidabilita = {};
  stato.chatAperte.clear();
  clearInterval(aggiornamentoTimer);
  $("matches").replaceChildren();
  $("authScreen").style.display = "flex";
  $("loginForm").reset();
  $("registerForm").reset();
  $("showLogin").click();
  vaiAScheda("tab-partite");
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && stato.uid) aggiornaTutto(true);
});

/* ---------- Reel (solo su questo dispositivo, non salvati) ---------- */

$("openUploadBtn").addEventListener("click", () => $("socialVideo").click());
$("likeBtn").addEventListener("click", (e) => {
  const b = e.currentTarget;
  const on = b.getAttribute("aria-pressed") !== "true";
  b.setAttribute("aria-pressed", on ? "true" : "false");
  b.style.color = on ? "#ff3d71" : "";
  $("likeCount").textContent = on ? "1" : "0";
});
$("socialVideo").addEventListener("change", function () {
  const file = this.files[0];
  if (!file || !file.type.startsWith("video/")) return;
  const desc = prompt("Aggiungi una descrizione per il tuo Reel:") || "Clip di padel";
  const card = document.createElement("div");
  card.className = "tiktok-card";
  const video = document.createElement("video");
  video.src = URL.createObjectURL(file);
  video.controls = true;
  video.playsInline = true;
  video.autoplay = true;
  video.loop = true;
  const overlay = document.createElement("div");
  overlay.className = "tiktok-overlay";
  const info = document.createElement("div");
  info.className = "tiktok-info";
  const h = document.createElement("h3");
  h.textContent = "@" + (stato.profilo.nickname || "tu");
  const p = document.createElement("p");
  p.textContent = desc;
  info.append(h, p);
  overlay.appendChild(info);
  card.append(video, overlay);
  $("socialFeed").prepend(card);
  card.scrollIntoView({ behavior: "smooth" });
});

/* ---------- Avvio ---------- */

aggiornaTema();
$("newDate").min = isoLocale(new Date());

if (inizializzaClient()) {
  sb.auth.onAuthStateChange((evento, session) => {
    if (evento === "PASSWORD_RECOVERY") {
      setTimeout(async () => {
        const nuova = prompt("Scegli una nuova password (almeno 6 caratteri):");
        if (!nuova) return;
        const { error } = await sb.auth.updateUser({ password: nuova });
        mostraNotifica(error ? testoErrore(error, "Password non aggiornata") : "Password aggiornata");
      }, 0);
    }
    // le chiamate a Supabase vanno fuori dalla callback (raccomandazione della libreria)
    setTimeout(() => {
      if (session && session.user) {
        if (stato.uid !== session.user.id) entra(session);
      } else if (stato.uid || evento === "INITIAL_SESSION" || evento === "SIGNED_OUT") {
        esci();
      }
    }, 0);
  });
}
