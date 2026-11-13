// Notifiche dell'app AICS.
// Lo fa girare GitHub ogni 5 minuti (.github/workflows/notifiche.yml): guarda cosa è cambiato
// nelle designazioni dall'ultimo giro e manda le notifiche ai telefoni che le hanno attivate.
// La chiave per entrare in Firebase sta nel segreto FIREBASE_SERVICE_ACCOUNT di GitHub, mai in questo file.
const fs = require('fs');
const admin = require('firebase-admin');

const DRY = !!process.env.DRY_RUN;
if (process.env.FIRESTORE_EMULATOR_HOST) admin.initializeApp({projectId: process.env.GCLOUD_PROJECT || 'demo-test'});
else {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) { console.error('Manca il segreto FIREBASE_SERVICE_ACCOUNT su GitHub.'); process.exit(1); }
  admin.initializeApp({credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});
}
const db = admin.firestore();

// Email dei designatori: le stesse di firebase-config.js
const cfg = fs.readFileSync(process.env.CONFIG_FILE || 'firebase-config.js', 'utf8');
const ADMINS = ((cfg.match(/FIREBASE_ADMINS\s*=\s*\[([^\]]*)\]/) || [])[1] || '').match(/[^"',\s]+@[^"',\s]+/g)?.map(e => e.toLowerCase()) || [];

// Ora italiana (GitHub lavora in ora UTC)
function oraRoma() {
  if (process.env.NOW) return {data: process.env.NOW.slice(0, 10), ora: process.env.NOW.slice(11, 16)};
  const p = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).format(new Date());
  return {data: p.slice(0, 10), ora: p.slice(11, 16)};
}
const minuti = (data, ora) => Date.UTC(+data.slice(0, 4), +data.slice(5, 7) - 1, +data.slice(8, 10), +ora.slice(0, 2), +ora.slice(3, 5)) / 60000;
const giorno = data => {
  if (!data) return 'data da definire';
  const t = new Date(Date.UTC(+data.slice(0, 4), +data.slice(5, 7) - 1, +data.slice(8, 10))).toLocaleDateString('it-IT', {weekday: 'short', timeZone: 'UTC'});
  return `${t[0].toUpperCase() + t.slice(1)} ${data.slice(8, 10)}/${data.slice(5, 7)}`; // es. Ven 13/11
};
const squadre = d => `${d.casa || '—'} – ${d.ospite || '—'}`;
const quando = d => `${giorno(d.data)}${d.ora ? ' ore ' + d.ora : ''}`;
const dove = d => d.impianto || [d.indirizzo, d.citta].filter(Boolean).join(', ');
const chiave = d => [d.data, d.ora, d.impianto, d.indirizzo, d.citta, d.casa, d.ospite].map(x => x || '').join('|');
const eur = n => Number(n || 0).toLocaleString('it-IT', {minimumFractionDigits: 2, maximumFractionDigits: 2}) + ' €';

// arbitri eliminati dai designatori: cancella account di accesso e dati personali
async function eliminazioni() {
  const el = await db.collection('eliminazioni').get();
  for (const doc of el.docs) {
    const uid = doc.id, nome = doc.data().nome || uid;
    if (DRY) { console.log(`  [prova] eliminerei ${nome}`); continue; }
    try { await admin.auth().deleteUser(uid); } catch (e) { if (e.code !== 'auth/user-not-found') { console.log(`  ! non riesco a eliminare l'account di ${nome}: ${e.code}`); continue; } }
    const reg = db.collection('registri').doc(uid);
    const daCancellare = [db.collection('arbitri').doc(uid), reg];
    for (const q of [reg.collection('righe'), db.collection('tokens').where('uid', '==', uid), db.collection('indisponibilita').where('uid', '==', uid)])
      (await q.get()).forEach(d => daCancellare.push(d.ref));
    for (let i = 0; i < daCancellare.length; i += 400) { const b = db.batch(); daCancellare.slice(i, i + 400).forEach(x => b.delete(x)); await b.commit(); }
    await doc.ref.delete();
    console.log(`  ✕ eliminato ${nome} (${daCancellare.length} documenti)`);
  }
}

async function main() {
  await eliminazioni();
  const now = oraRoma(), adesso = minuti(now.data, now.ora);
  const [desSnap, statiSnap, arbSnap, tokSnap, antSnap, accSnap, indSnap, elSnap] = await Promise.all([...['designazioni', 'notifiche', 'arbitri', 'tokens', 'anticipi', 'accessi', 'indisponibilita'].map(c => db.collection(c).get()), db.collection('elenco').doc('arbitri').get()]);
  const stati = {}; statiSnap.forEach(s => { stati[s.id] = s.data(); });
  const meta = stati._meta; delete stati._meta;
  const zitto = !meta; // primo giro: registra com'è la situazione senza mandare niente
  const nomi = {}, adminUid = [];
  arbSnap.forEach(a => { const x = a.data(); nomi[a.id] = [x.nome, x.cognome].filter(Boolean).join(' ') || x.email || ''; if (ADMINS.includes(String(x.email || '').toLowerCase())) adminUid.push(a.id); });
  // accessi: chi non è approvato (o ha l'accesso tolto) non riceve niente
  const acc = {}; accSnap.forEach(a => { acc[a.id] = a.data().stato || ''; });
  const scritture = [];
  // correzione una tantum: chi era stato abilitato in automatico per sbaglio (appena iscritto e mai designato) torna da approvare
  const av = accSnap.docs.find(a => a.id === '_avvio');
  if (av && !av.data().corretto) {
    const designati = new Set(desSnap.docs.flatMap(d => d.data().arbitriIds || [])), lim = (av.data().at || Date.now()) - 24 * 3600 * 1000;
    accSnap.forEach(x => { const a = arbSnap.docs.find(y => y.id === x.id), c = a && a.data().createdAt;
      if (a && x.data().stato === 'attivo' && x.data().da === 'avvio' && !ADMINS.includes(String(a.data().email || '').toLowerCase()) && !designati.has(x.id) && c && c > lim) { delete acc[x.id]; scritture.push(['accdel', x.id]); } });
    scritture.push(['accmerge', '_avvio', {corretto: Date.now()}]);
  }
  const attivo = uid => adminUid.includes(uid) || acc[uid] === 'attivo';
  const tokens = {}; tokSnap.forEach(t => { const u = t.data().uid; if (u) (tokens[u] = tokens[u] || []).push(t.id); });

  const msg = [];
  const manda = (uids, title, body, tag, url = './index.html') => { for (const uid of new Set(uids)) if (uid) msg.push({uid, title, body, tag, url}); };
  const aiDesignatori = (title, body, tag, tranne) => manda(adminUid.filter(u => u !== tranne), title, body, tag, './index.html#designazioni');

  const visti = new Set();
  desSnap.forEach(doc => {
    const d = doc.data(), id = doc.id, s = stati[id] || null; visti.add(id);
    const uff = (d.ufficiali || []).filter(u => u && u.uid);
    const uids = uff.map(u => u.uid), prima = s ? s.uff || [] : [];
    const inizio = d.data ? minuti(d.data, d.ora || '23:59') : null;
    const giocata = inizio !== null && adesso >= inizio;
    const risp = uid => ((d.risposte || {})[uid] || {});
    const nuovo = {uff: uids, key: chiave(d), risp: {}, ref: {}, sost: {}, prom: {...(s && s.prom || {})}, todo: {...(s && s.todo || {})}, info: {casa: d.casa || '', ospite: d.ospite || '', data: d.data || '', ora: d.ora || ''}};

    if (!zitto && !giocata) {
      const nuovi = uids.filter(u => !prima.includes(u) && risp(u).stato !== 'accettata');
      const sub = u => ((d.subentri || {})[u] || {}).sost ? d.subentri[u] : null;
      manda(nuovi.filter(u => !sub(u)), '📋 Nuova designazione', `${squadre(d)} · ${quando(d)}${dove(d) ? ' · ' + dove(d) : ''}. Apri l’app per accettarla.`, 'des-' + id);
      for (const u of nuovi.filter(sub)) manda([u], '📋 Nuova designazione', `${squadre(d)} · ${quando(d)}${dove(d) ? ' · ' + dove(d) : ''} · al posto di ${nomi[sub(u).da] || sub(u).daNome || 'un collega'}. Apri l’app per accettarla.`, 'des-' + id);
      const tolti = prima.filter(u => !uids.includes(u)), chiesto = u => !!((s && s.sost || {})[u] || '').startsWith('aperta');
      manda(tolti.filter(u => !chiesto(u)), '❌ Designazione annullata', `Non sei più designato per ${squadre((s && s.info) || d)} di ${giorno(((s && s.info) || d).data)}.`, 'des-' + id);
      manda(tolti.filter(chiesto), '✅ Sostituzione fatta', `Il designatore ha trovato un sostituto: non arbitri più ${squadre((s && s.info) || d)} di ${giorno(((s && s.info) || d).data)}.`, 'des-' + id);
      if (s && s.key !== nuovo.key) manda(uids.filter(u => prima.includes(u)), '✏️ Partita modificata', `${squadre(d)} · ${quando(d)}${dove(d) ? ' · ' + dove(d) : ''}`, 'des-' + id);
    }
    for (const u of uff) {
      const r = risp(u.uid), st = r.stato || '';
      nuovo.risp[u.uid] = st;
      if (!zitto && st && st !== ((s && s.risp || {})[u.uid] || '')) {
        if (st === 'accettata') aiDesignatori('✅ Designazione accettata', `${nomi[u.uid] || u.nome || 'Un arbitro'} · ${squadre(d)} · ${quando(d)}`, 'risp-' + id, u.uid);
        if (st === 'rifiutata') aiDesignatori('❌ Designazione rifiutata', `${nomi[u.uid] || u.nome || 'Un arbitro'} · ${squadre(d)} · ${quando(d)}${r.motivo ? ' · “' + r.motivo + '”' : ''}`, 'risp-' + id, u.uid);
      }
    }
    // richieste di sostituzione
    for (const [uid, r] of Object.entries(d.sostituzioni || {})) {
      if (!r || !uids.includes(uid)) continue;
      const firma = (r.esito === 'no' ? 'no:' : 'aperta:') + (r.at || 1) + (r.proposto ? ':' + r.proposto : '');
      nuovo.sost[uid] = firma;
      if (zitto || giocata || firma === ((s && s.sost || {})[uid] || '')) continue;
      if (r.esito === 'no') manda([uid], '↩️ Sostituzione non accolta', `${squadre(d)} di ${giorno(d.data)} resta tua: il designatore non ti ha sostituito.`, 'sost-' + id, './index.html#partite');
      else aiDesignatori('🔁 Richiesta di sostituzione', `${nomi[uid] || 'Un arbitro'} chiede di essere sostituito${r.proposto ? ' e propone ' + (nomi[r.proposto] || r.propostoNome || 'un collega') : ''} · ${squadre(d)} · ${quando(d)}${r.motivo ? ' · “' + r.motivo + '”' : ''}`, 'sost-' + id, uid);
    }
    for (const [uid, r] of Object.entries(d.referti || {})) {
      if (!r) continue;
      const firma = r.sbloccato ? 'sbloccato' : String(r.at || 1);
      nuovo.ref[uid] = firma;
      if (zitto || firma === ((s && s.ref || {})[uid] || '')) continue;
      if (r.sbloccato) manda([uid], '🔓 Referto sbloccato', `Correggi e reinvia il referto di ${squadre(d)}.`, 'ref-' + id, './index.html#partite');
      else aiDesignatori('📝 Referto ricevuto', `${squadre(d)}${r.risultato ? ' ' + r.risultato : ''} · ${nomi[uid] || r.nome || ''}`, 'ref-' + id, uid);
    }
    // promemoria la mattina della gara e referto da compilare dopo la partita
    if (inizio !== null) {
      for (const u of uff) {
        if (risp(u.uid).stato !== 'accettata') continue;
        if (!nuovo.prom[u.uid]) {
          if (giocata || now.data > d.data) nuovo.prom[u.uid] = 1;
          else if (now.data === d.data && now.ora >= '08:00') { nuovo.prom[u.uid] = 1; manda([u.uid], '⏰ Oggi hai una gara', `${squadre(d)}${d.ora ? ' · ore ' + d.ora : ''}${dove(d) ? ' · ' + dove(d) : ''}`, 'prom-' + id); }
        }
        if ((u.ruolo || 'Arbitro') === 'Arbitro' && !nuovo.todo[u.uid] && adesso >= inizio + 90) {
          nuovo.todo[u.uid] = 1;
          if (!(d.referti || {})[u.uid] && adesso <= inizio + 3 * 24 * 60) manda([u.uid], '📝 Referto da compilare', `Compila il referto di ${squadre(d)} nell’app.`, 'ref-' + id, './index.html#partite');
        }
      }
    }
    if (JSON.stringify(nuovo) !== JSON.stringify(s)) scritture.push(['set', id, nuovo]);
  });

  // designazioni eliminate
  for (const [id, s] of Object.entries(stati)) {
    if (visti.has(id)) continue;
    const inf = s.info || {};
    const futura = inf.data && minuti(inf.data, inf.ora || '23:59') > adesso;
    if (!zitto && futura) manda(s.uff || [], '❌ Partita annullata', `${squadre(inf)} di ${giorno(inf.data)} è stata tolta dalle tue designazioni.`, 'des-' + id);
    scritture.push(['del', id]);
  }

  // anticipi aggiunti dagli arbitri
  const antIds = antSnap.docs.map(a => a.id), giaVisti = new Set(meta && meta.anticipi || []);
  if (!zitto) antSnap.forEach(a => {
    if (giaVisti.has(a.id)) return;
    const x = a.data();
    aiDesignatori('💶 Nuovo anticipo', `${x.nome || nomi[x.uid] || 'Un arbitro'}: ${eur(x.importo)}${x.descrizione ? ' · ' + x.descrizione : ''}`, 'ant-' + a.id, x.uid);
  });

  // elenco dei colleghi per chi propone un sostituto (solo nomi e giorni di indisponibilità)
  const t0 = now.data, elenco = arbSnap.docs.filter(a => attivo(a.id)).map(a => ({uid: a.id, nome: nomi[a.id],
    ind: indSnap.docs.map(x => x.data()).filter(x => x.uid === a.id && x.al >= t0 && x.dal).map(x => x.dal + '|' + x.al).sort()})).sort((a, b) => a.nome.localeCompare(b.nome));
  if (!DRY && JSON.stringify(elenco) !== JSON.stringify(elSnap.exists ? elSnap.data().list || [] : null)) await db.collection('elenco').doc('arbitri').set({list: elenco, at: Date.now()});

  // nuovi arbitri da approvare
  const inAttesa = arbSnap.docs.filter(a => !adminUid.includes(a.id) && !acc[a.id]).map(a => a.id), giaAvvisati = new Set(meta && meta.richieste || []);
  if (!zitto) for (const uid of inAttesa) if (!giaAvvisati.has(uid)) aiDesignatori('👤 Nuovo arbitro da approvare', `${nomi[uid] || 'Un arbitro'} si è registrato: approvalo nella scheda Arbitri.`, 'acc-' + uid);

  // spedizione
  const invii = [];
  for (const m of msg) if (attivo(m.uid)) for (const token of tokens[m.uid] || []) invii.push({m, token});
  console.log(`${now.data} ${now.ora} · ${zitto ? 'primo giro (nessun invio)' : msg.length + ' notifiche'} · ${invii.length} invii`);
  for (const m of msg) console.log(`  → ${nomi[m.uid] || m.uid}: ${m.title} | ${m.body}${!attivo(m.uid) ? ' (accesso non attivo)' : (tokens[m.uid] || []).length ? '' : ' (notifiche non attive)'}`);
  if (invii.length && !DRY) {
    for (let i = 0; i < invii.length; i += 500) {
      const parte = invii.slice(i, i + 500);
      const res = await admin.messaging().sendEach(parte.map(({m, token}) => ({
        token, data: {title: m.title, body: m.body, tag: m.tag || '', url: m.url},
        webpush: {headers: {Urgency: 'high', TTL: '86400'}}
      })));
      res.responses.forEach((r, k) => {
        if (r.success) return;
        const code = r.error && r.error.code;
        console.log(`  ! invio non riuscito (${code})`);
        if (['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'].includes(code)) scritture.push(['tok', parte[k].token]);
      });
    }
  }

  // salva la situazione per il prossimo giro
  const col = db.collection('notifiche');
  for (let i = 0; i < scritture.length; i += 400) {
    const b = db.batch();
    for (const [op, id, data] of scritture.slice(i, i + 400)) {
      if (op === 'set') b.set(col.doc(id), data);
      else if (op === 'del') b.delete(col.doc(id));
      else if (op === 'acc') b.set(db.collection('accessi').doc(id), data);
      else if (op === 'accdel') b.delete(db.collection('accessi').doc(id));
      else if (op === 'accmerge') b.set(db.collection('accessi').doc(id), data, {merge: true});
      else b.delete(db.collection('tokens').doc(id));
    }
    await b.commit();
  }
  await col.doc('_meta').set({anticipi: antIds, richieste: inAttesa, ultimoGiro: Date.now(), avviato: meta && meta.avviato || Date.now()});
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
