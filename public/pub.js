'use strict';
/* Partage — pages publiques : déverrouillage par mot de passe et notes partagées.
   La clé d'édition d'une note ne transite que dans le fragment d'URL (#k=…, jamais envoyé au serveur
   dans l'adresse) puis dans l'en-tête x-note-key ; elle est gardée dans ce navigateur. */

const $id = (x) => document.getElementById(x);
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEYS = 'partage.notes';
const keyStore = {
  all() { try { return JSON.parse(localStorage.getItem(KEYS) || '{}'); } catch { return {}; } },
  get(code) { return this.all()[code] || null; },
  set(code, key) { try { const a = this.all(); a[code] = key; localStorage.setItem(KEYS, JSON.stringify(a)); } catch { /* stockage indisponible */ } },
  del(code) { try { const a = this.all(); delete a[code]; localStorage.setItem(KEYS, JSON.stringify(a)); } catch { /* idem */ } },
};

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* contexte non sécurisé */ }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.style.cssText = 'position:fixed;opacity:0';
  document.body.append(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { /* ignoré */ }
  ta.remove();
  return ok;
}
function flash(btn, txt) {
  const old = btn.textContent;
  btn.textContent = txt;
  setTimeout(() => { btn.textContent = old; }, 1500);
}
function ago(t) {
  const d = (Date.now() - t) / 1000;
  if (d < 45) return "à l'instant";
  if (d < 3600) return `il y a ${Math.round(d / 60)} min`;
  if (d < 86400) return `il y a ${Math.round(d / 3600)} h`;
  return new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' }).format(t);
}
const linkify = (h) => h.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'»]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);

// ---------- déverrouillage d'un lien protégé ----------
const uf = $id('unlockForm');
if (uf) {
  uf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = uf.querySelector('button');
    btn.disabled = true;
    $id('unlockErr').textContent = '';
    try {
      const r = await fetch(uf.dataset.unlock, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $id('unlockPw').value }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
      location.reload();
    } catch (err) {
      $id('unlockErr').textContent = err.message;
      $id('unlockPw').select();
      btn.disabled = false;
    }
  });
}

// ---------- note partagée ----------
const root = $id('note');
if (root) {
  const code = root.dataset.code;
  const base = root.dataset.base;
  const m = /[#&]k=([A-Za-z0-9_-]{20,})/.exec(location.hash);
  if (m) {
    keyStore.set(code, m[1]);
    history.replaceState(null, '', location.pathname); // la clé ne reste pas dans la barre d'adresse
  }
  let key = keyStore.get(code);
  let note = null;
  let canEdit = false;
  let dirty = false;
  let saving = false;
  let saveTimer = 0;
  let conflict = null;
  const readLink = `${root.dataset.public || location.origin}${base}`;
  const hdr = () => (key ? { 'x-note-key': key } : {});

  const setStatus = (txt, cls = '') => { const el = $id('nStatus'); if (el) { el.textContent = txt; el.className = `n-status ${cls}`; } };

  function renderView() {
    root.innerHTML = `
      <header class="n-head">
        <h1 class="n-title">${escH(note.title || 'Note sans titre')}</h1>
        <p class="n-meta">Par ${escH(note.by)} · modifiée <span id="nAgo">${ago(note.updatedAt)}</span> · <span class="n-live" id="nLive">en direct</span>${note.locked ? ' · protégée' : ''}</p>
      </header>
      <div class="n-bar">
        <button class="btn primary sm" id="nCopy">Copier le texte</button>
        <button class="btn outline sm" id="nLink">Copier le lien</button>
        <a class="btn outline sm" id="nDl" download="${escH((note.title || 'note').replace(/[/\\:*?"<>|]/g, '_'))}.txt" href="${base}/raw">Télécharger</a>
      </div>
      <article class="n-view" id="nView">${linkify(escH(note.text)) || '<span class="muted">Note vide.</span>'}</article>
      <p class="n-foot">Seule la personne qui a créé cette note peut la modifier.</p>`;
    $id('nCopy').onclick = async (e) => flash(e.target, (await copyText(note.text)) ? 'Copié ✓' : 'Échec');
    $id('nLink').onclick = async (e) => flash(e.target, (await copyText(readLink)) ? 'Lien copié ✓' : 'Échec');
  }

  function renderEdit() {
    root.innerHTML = `
      <header class="n-head">
        <input class="n-title-in" id="nTitle" maxlength="120" placeholder="Titre de la note" value="${escH(note.title)}" aria-label="Titre">
        <p class="n-meta">Vous êtes le créateur · <span id="nStatus" class="n-status">enregistrée</span> · <span class="n-live" id="nLive">en direct</span></p>
      </header>
      <div class="n-conflict" id="nConflict" hidden>
        <span>Cette note a été modifiée sur un autre appareil.</span>
        <button class="btn outline sm" id="nTheirs">Charger cette version</button>
        <button class="btn primary sm" id="nMine">Garder la mienne</button>
      </div>
      <textarea class="n-edit" id="nText" placeholder="Écrivez ici… Tout est enregistré automatiquement et visible en direct par les personnes qui ont le lien." aria-label="Texte de la note">${escH(note.text)}</textarea>
      <section class="n-share">
        <div class="n-share-main">
          <div class="n-row"><span class="n-lbl">Lien de lecture</span><code id="nRead">${escH(readLink)}</code><button class="btn primary sm" id="nCopyRead">Copier</button></div>
          <div class="n-row"><span class="n-lbl">Lien d'édition</span><code class="secret">${escH(readLink)}#k=••••••</code><button class="btn outline sm" id="nCopyEdit">Copier</button></div>
          <p class="n-hint">Le lien d'édition permet de modifier la note depuis un autre appareil : ne le donnez à personne.</p>
          <div class="n-row n-pw"><span class="n-lbl">Mot de passe</span>
            <input class="input" type="password" id="nPw" placeholder="${note.locked ? 'Protégée : nouveau mot de passe' : 'Aucun (lecture libre)'}" autocomplete="new-password">
            <button class="btn outline sm" id="nPwSet">${note.locked ? 'Changer' : 'Protéger'}</button>
            ${note.locked ? '<button class="btn outline sm tint-red" id="nPwDel">Retirer</button>' : ''}</div>
        </div>
        <div class="qr n-qr" id="nQr" title="QR code du lien de lecture"></div>
      </section>
      <div class="n-bar end">
        <a class="btn outline sm" href="${base}/raw" download="${escH((note.title || 'note').replace(/[/\\:*?"<>|]/g, '_'))}.txt">Télécharger .txt</a>
        <button class="btn outline sm tint-red" id="nDel">Supprimer la note</button>
      </div>`;
    const ta = $id('nText');
    const grow = () => { ta.style.height = 'auto'; ta.style.height = `${Math.max(320, ta.scrollHeight + 4)}px`; };
    grow();
    ta.addEventListener('input', () => { grow(); touch(); });
    $id('nTitle').addEventListener('input', touch);
    $id('nCopyRead').onclick = async (e) => flash(e.target, (await copyText(readLink)) ? 'Copié ✓' : 'Échec');
    $id('nCopyEdit').onclick = async (e) => flash(e.target, (await copyText(`${readLink}#k=${key}`)) ? 'Copié ✓' : 'Échec');
    $id('nPwSet').onclick = () => setPassword($id('nPw').value);
    if ($id('nPwDel')) $id('nPwDel').onclick = () => setPassword(null);
    $id('nDel').onclick = removeNote;
    $id('nTheirs').onclick = () => { note = conflict; conflict = null; dirty = false; renderEdit(); };
    $id('nMine').onclick = () => { conflict = null; $id('nConflict').hidden = true; save(true); };
    if (window.qrcode) {
      const q = qrcode(0, 'M');
      q.addData(readLink);
      q.make();
      const n = q.getModuleCount();
      let d = '';
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
      $id('nQr').innerHTML = `<svg viewBox="-3 -3 ${n + 6} ${n + 6}" shape-rendering="crispEdges"><rect x="-3" y="-3" width="${n + 6}" height="${n + 6}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
    }
  }

  function touch() {
    dirty = true;
    setStatus('modifications…');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save(false), 700);
  }

  async function save(force) {
    if (saving) { clearTimeout(saveTimer); saveTimer = setTimeout(() => save(force), 300); return; }
    if (conflict && !force) return;
    saving = true;
    setStatus('enregistrement…');
    const body = { title: $id('nTitle').value, text: $id('nText').value };
    if (!force) body.baseVersion = note.version;
    try {
      const r = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', ...hdr() }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (r.status === 409) {
        conflict = d.note;
        $id('nConflict').hidden = false;
        setStatus('conflit', 'warn');
        return;
      }
      if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
      // si l'utilisateur a retapé pendant l'enregistrement, on garde son texte
      const stillSame = $id('nText').value === body.text && $id('nTitle').value === body.title;
      note = { ...d.note, text: $id('nText').value, title: $id('nTitle').value };
      note.version = d.note.version;
      if (stillSame) { dirty = false; setStatus('enregistrée ✓', 'ok'); } else touch();
    } catch (err) {
      setStatus(`non enregistrée : ${err.message}`, 'bad');
      saveTimer = setTimeout(() => save(force), 3000);
    } finally { saving = false; }
  }

  async function setPassword(pw) {
    if (pw !== null && !pw) { $id('nPw').focus(); return; }
    try {
      const r = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json', ...hdr() }, body: JSON.stringify({ password: pw }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
      note = d.note;
      dirty = false;
      renderEdit();
      setStatus(pw ? 'protégée par mot de passe ✓' : 'mot de passe retiré ✓', 'ok');
    } catch (err) { setStatus(err.message, 'bad'); }
  }

  async function removeNote() {
    if (!confirm('Supprimer définitivement cette note ? Le lien ne fonctionnera plus.')) return;
    const r = await fetch(base, { method: 'DELETE', headers: hdr() });
    if (r.ok) {
      keyStore.del(code);
      root.innerHTML = '<h1>Note supprimée</h1><p class="lead">Le lien ne fonctionne plus.</p>';
    } else setStatus('suppression impossible', 'bad');
  }

  function listen() {
    const es = new EventSource(`${base}/events`);
    es.onopen = () => { const l = $id('nLive'); if (l) { l.textContent = 'en direct'; l.className = 'n-live'; } };
    es.onerror = () => { const l = $id('nLive'); if (l) { l.textContent = 'reconnexion…'; l.className = 'n-live off'; } };
    es.onmessage = (ev) => {
      const d = JSON.parse(ev.data);
      if (d.type === 'deleted') { es.close(); root.innerHTML = '<h1>Note supprimée</h1><p class="lead">Son créateur l\'a supprimée.</p>'; return; }
      if (d.type !== 'update' || d.note.version <= note.version) return;
      if (canEdit) {
        // pendant un enregistrement, le serveur tranche (409 si quelqu'un d'autre a modifié)
        if (saving) return;
        // écho de notre propre enregistrement : rien à faire
        if (d.note.text === $id('nText').value && d.note.title === $id('nTitle').value) { note.version = d.note.version; return; }
        if (dirty || saving) { conflict = d.note; const c = $id('nConflict'); if (c) c.hidden = false; return; }
        note = d.note;
        renderEdit();
        setStatus('mise à jour depuis un autre appareil', 'ok');
      } else {
        note = d.note;
        renderView();
        $id('nView').classList.add('flash');
      }
    };
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && es.readyState === 2) listen(); }, { once: true });
  }

  (async () => {
    try {
      const r = await fetch(`${base}/data`, { headers: hdr() });
      const d = await r.json().catch(() => ({}));
      if (r.status === 401) { location.reload(); return; }
      if (!r.ok) throw new Error(d.error || `Erreur ${r.status}`);
      note = d.note;
      canEdit = d.canEdit;
      if (key && !canEdit) { keyStore.del(code); key = null; }
      // le créateur d'une note protégée reçoit aussi le cookie de lecture (pour le direct)
      if (canEdit && note.locked) await fetch(`${base}/unlock`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr() }, body: '{}' }).catch(() => {});
      document.title = `${note.title || 'Note'} · Partage`;
      if (canEdit) renderEdit(); else renderView();
      listen();
      setInterval(() => { const a = $id('nAgo'); if (a && note) a.textContent = ago(note.updatedAt); }, 30000);
    } catch (err) {
      root.innerHTML = `<h1>Note indisponible</h1><p class="lead">${escH(err.message)}</p>`;
    }
  })();
  window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });
}
