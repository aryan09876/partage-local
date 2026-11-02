'use strict';
/* Partage local — client. Envoi en morceaux parallèles (XHR + File.slice), reprise, temps réel via SSE. */

const CONC_CHUNKS = 4;   // morceaux simultanés par fichier
const CONC_FILES = 3;    // fichiers simultanés
const MAX_RETRY = 6;

const $ = (s) => document.querySelector(s);
const enc = encodeURIComponent;
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } },
};

const TAB = Math.random().toString(36).slice(2, 10);
let user = store.get('user') || '';
let me = '';
let cwd = readHash();
let entries = [];
let prevNames = null;
let sortKey = store.get('sortKey') || 'name';
let sortDir = Number(store.get('sortDir')) || 1;
let filter = '';

// ---------- format ----------
function fmtSize(b) {
  if (!Number.isFinite(b)) return '—';
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i === 0 ? 0 : b < 10 ? 2 : 1).replace('.', ',')} ${u[i]}`;
}
const fmtSpeed = (bps) => `${fmtSize(bps)}/s`;
function fmtEta(s) {
  if (!Number.isFinite(s) || s < 0) return '—';
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min ${String(r).padStart(2, '0')}`;
}
const dtf = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
const tf = new Intl.DateTimeFormat('fr-FR', { timeStyle: 'medium' });
function fmtDate(ms) {
  const d = Date.now() - ms;
  if (d < 60e3) return "à l'instant";
  if (d < 3600e3) return `il y a ${Math.floor(d / 60e3)} min`;
  return dtf.format(ms);
}

// ---------- icônes ----------
const I = {
  dl: '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/></svg>',
  edit: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16v4z"/></svg>',
  del: '<svg viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/></svg>',
  dir: '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M9 5v14M15 5v14"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V4m0 0-4 4m4-4 4 4M6 12v6a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-6"/></svg>',
  more: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/></svg>',
  eye: '<svg viewBox="0 0 24 24"><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="m8.5 12.2 2.4 2.4 4.6-4.8"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  lock: '<svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  note: '<svg viewBox="0 0 24 24"><path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5M9 12h7M9 16h5"/></svg>',
  qr: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><path d="M14 14h2v2h-2zM18 18h2v2h-2zM14 18h2M18 14h2"/></svg>',
};
const EXT = {
  img: 'jpg jpeg png gif webp avif svg bmp heic ico tif tiff raw',
  vid: 'mp4 mkv webm mov avi m4v wmv flv ts',
  aud: 'mp3 wav ogg flac m4a opus aac wma',
  arc: 'zip rar 7z tar gz tgz bz2 xz zst iso dmg deb rpm apk',
  doc: 'pdf doc docx odt rtf txt md xls xlsx ods csv ppt pptx odp epub',
  code: 'js ts py sh json yml yaml xml html css c h cpp go rs java php sql ini conf toml log',
};
const EXTMAP = {};
for (const [k, v] of Object.entries(EXT)) for (const e of v.split(' ')) EXTMAP[e] = k;
const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };

// ---------- API ----------
function hdrs(extra) {
  const h = { 'x-tab': TAB, ...extra };
  if (user) h['x-user'] = enc(user);
  return h;
}
async function api(method, url, body) {
  const r = await fetch(url, {
    method,
    headers: hdrs(body ? { 'content-type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = {};
  try { data = await r.json(); } catch { /* corps vide */ }
  if (r.status === 401) toLogin();
  if (!r.ok) {
    const e = new Error(data.error || `Erreur ${r.status}`);
    e.status = r.status;
    throw e;
  }
  return data;
}
let leaving = false;
function toLogin() {
  if (leaving) return;
  leaving = true;
  const next = location.pathname + location.hash;
  location.href = `/login${next !== '/' ? `?next=${enc(next)}` : ''}`;
}
const fileUrl = (rel, inline) => `/f/${rel.split('/').map(enc).join('/')}${inline ? '?inline' : ''}${user ? `${inline ? '&' : '?'}u=${enc(user)}` : ''}`;
const join = (a, b) => (a ? `${a}/${b}` : b);

// ---------- toasts / dialogue ----------
function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? 6000 : 3200);
}

function ask({ title, text = '', value = null, ok = 'OK', danger = false }) {
  const dlg = $('#dlg');
  $('#dlgTitle').textContent = title;
  $('#dlgText').textContent = text;
  $('#dlgText').hidden = !text;
  const input = $('#dlgInput');
  input.hidden = value === null;
  input.value = value ?? '';
  const okBtn = $('#dlgOk');
  okBtn.textContent = ok;
  okBtn.className = `btn ${danger ? 'danger' : 'primary'}`;
  return new Promise((resolve) => {
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      resolve(value === null ? true : input.value.trim() || null);
    };
    dlg.returnValue = '';
    dlg.showModal();
    if (value !== null) {
      input.focus();
      const dot = input.value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : input.value.length);
    }
  });
}

async function copyText(t) {
  try { await navigator.clipboard.writeText(t); return true; } catch { /* contexte non sécurisé (http) */ }
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

// ---------- navigation & liste ----------
function readHash() {
  try { return decodeURIComponent(location.hash.slice(1)).replace(/^\/+|\/+$/g, ''); } catch { return ''; }
}
window.addEventListener('hashchange', () => {
  const h = readHash();
  if (h !== cwd) { cwd = h; prevNames = null; selected.clear(); load(); }
});
function go(dir) {
  cwd = dir;
  prevNames = null;
  selected.clear();
  $('#search').value = filter = '';
  location.hash = dir ? enc(dir).replace(/%2F/g, '/') : '';
  load();
}

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  try {
    const r = await api('GET', `/api/list?path=${enc(cwd)}`);
    if (seq !== loadSeq) return;
    entries = r.entries;
    renderCrumbs();
    renderList();
  } catch (e) {
    if (e.status === 404 && cwd) { toast('Ce dossier n\'existe plus', 'err'); go(''); return; }
    toast(`Impossible de lister : ${e.message}`, 'err');
  }
}
let reloadTimer = null;
const reloadSoon = () => { clearTimeout(reloadTimer); reloadTimer = setTimeout(load, 150); };

function renderCrumbs() {
  const parts = cwd ? cwd.split('/') : [];
  let html = '<button data-go="">Racine</button>';
  let acc = '';
  for (const p of parts) {
    acc = join(acc, p);
    html += `<span class="sep">/</span><button data-go="${esc(acc)}" title="${esc(p)}">${esc(p)}</button>`;
  }
  $('#crumbs').innerHTML = html;
  $('#overlayDir').textContent = cwd ? `/${cwd}` : 'Racine';
}

// types de fichiers affichables dans la visionneuse
const TEXT_EXT = new Set('txt md log csv json xml yml yaml ini conf toml js ts py sh c h cpp go rs java php sql html css srt'.split(' '));
function kindOf(name) {
  const x = extOf(name);
  if (/^(jpe?g|png|gif|webp|avif|bmp|svg|ico)$/.test(x)) return 'image';
  if (/^(mp4|webm|mov|m4v|mkv)$/.test(x)) return 'video';
  if (/^(mp3|wav|ogg|flac|m4a|opus|aac)$/.test(x)) return 'audio';
  if (x === 'pdf') return 'pdf';
  if (TEXT_EXT.has(x)) return 'text';
  return null;
}
const thumbUrl = (rel) => `/f/${rel.split('/').map(enc).join('/')}?inline&thumb`;
const zipUrl = (rel) => `/zip?path=${enc(rel)}${user ? `&u=${enc(user)}` : ''}`;

let view = store.get('view') === 'grid' ? 'grid' : 'list';
let visible = [];
const selected = new Set();
let lastSelIdx = -1;

function iconHtml(e, rel, big) {
  if (e.dir) return `<span class="ico dir">${I.dir}</span>`;
  const k = kindOf(e.name);
  const x = extOf(e.name);
  if (k === 'image' && e.size < 40 * 1048576) {
    return `<span class="ico thumb ${EXTMAP[x] || ''}" data-ext="${esc(x.slice(0, 4))}"><img loading="lazy" decoding="async" src="${esc(thumbUrl(rel))}" alt=""></span>`;
  }
  if (big && k === 'video') {
    return `<span class="ico thumb vid" data-ext="${esc(x.slice(0, 4))}"><video muted playsinline preload="metadata" src="${esc(thumbUrl(rel))}#t=0.5"></video><i class="play">${I.play}</i></span>`;
  }
  return `<span class="ico ${EXTMAP[x] || ''}">${esc(x.slice(0, 4) || '—')}</span>`;
}

function renderList() {
  const f = filter.toLowerCase();
  visible = entries.filter((e) => !f || e.name.toLowerCase().includes(f));
  visible.sort((a, b) => {
    if (a.dir !== b.dir) return a.dir ? -1 : 1;
    let c = 0;
    if (sortKey === 'size') c = a.size - b.size;
    else if (sortKey === 'mtime') c = a.mtime - b.mtime;
    if (!c) c = a.name.localeCompare(b.name, 'fr', { numeric: true, sensitivity: 'base' });
    return c * sortDir;
  });
  for (const b of document.querySelectorAll('#listHead button')) {
    b.classList.toggle('on', b.dataset.sort === sortKey);
    b.classList.toggle('desc', sortDir < 0);
  }
  // la sélection ne garde que ce qui existe encore
  const names = new Set(entries.map((e) => join(cwd, e.name)));
  for (const r of [...selected]) if (!names.has(r)) selected.delete(r);

  const grid = view === 'grid';
  $('#filesGroup').classList.toggle('grid', grid);
  for (const b of document.querySelectorAll('.view-seg button')) {
    b.classList.toggle('on', b.dataset.view === view);
    b.setAttribute('aria-checked', String(b.dataset.view === view));
  }
  const html = visible.map((e, i) => {
    const rel = join(cwd, e.name);
    const isNew = prevNames && !prevNames.has(e.name);
    const sel = selected.has(rel);
    const k = !e.dir && kindOf(e.name);
    const meta = e.dir ? 'Dossier' : `${fmtSize(e.size)} · ${fmtDate(e.mtime)}`;
    const href = e.dir ? `#${enc(rel)}` : k ? fileUrl(rel, true) : fileUrl(rel);
    const nameEl = `<a class="name" href="${esc(href)}"${!e.dir && !k ? ' download' : ''} data-open="${i}">${esc(e.name)}</a>`;
    const ck = `<label class="ck" title="Sélectionner"><input type="checkbox" data-sel="${i}"${sel ? ' checked' : ''} aria-label="Sélectionner ${esc(e.name)}"><span></span></label>`;
    const cls = `${grid ? 'tile' : 'row'}${sel ? ' sel' : ''}${isNew ? ' flash' : ''}`;
    if (grid) {
      return `<li class="${cls}" data-i="${i}">${ck}
        <button class="ib more" data-act="more" title="Actions" aria-label="Actions">${I.more}</button>
        <div class="tile-media" data-open="${i}">${iconHtml(e, rel, true)}</div>
        ${nameEl}<span class="meta-m">${meta}</span></li>`;
    }
    const dl = e.dir
      ? `<button class="ib" data-act="zip" title="Télécharger en ZIP" aria-label="Télécharger en ZIP">${I.dl}</button>`
      : `<a class="ib" href="${esc(fileUrl(rel))}" download title="Télécharger" aria-label="Télécharger">${I.dl}</a>`;
    return `<li class="${cls}" data-i="${i}">${ck}
      <div class="nm">${iconHtml(e, rel, false)}<div class="name-wrap">${nameEl}<span class="meta-m">${meta}</span></div></div>
      <span class="size">${e.dir ? '—' : fmtSize(e.size)}</span>
      <span class="date" title="${esc(dtf.format(e.mtime))}">${fmtDate(e.mtime)}</span>
      <span class="racts">${dl}
        <button class="ib opt" data-act="share" title="Partager un lien public" aria-label="Partager">${I.share}</button>
        <button class="ib" data-act="more" title="Plus d'actions" aria-label="Plus d'actions">${I.more}</button>
      </span>
    </li>`;
  }).join('');
  $('#list').innerHTML = html;
  prevNames = new Set(entries.map((e) => e.name));
  const empty = $('#empty');
  empty.hidden = visible.length > 0;
  empty.textContent = entries.length ? 'Aucun résultat dans ce dossier.' : 'Ce dossier est vide. Déposez ou collez des fichiers ici pour commencer.';
  const nd = entries.filter((e) => e.dir).length;
  const total = entries.reduce((s, e) => s + e.size, 0);
  $('#listFoot').textContent = `${nd} dossier${nd > 1 ? 's' : ''} · ${entries.length - nd} fichier${entries.length - nd > 1 ? 's' : ''} · ${fmtSize(total)}`;
  renderSelection();
}

// vignette illisible → on revient à l'icône de type
$('#list').addEventListener('error', (e) => {
  const m = e.target;
  if (m.tagName !== 'IMG' && m.tagName !== 'VIDEO') return;
  const box = m.closest('.ico');
  if (!box) return;
  box.classList.remove('thumb');
  box.textContent = box.dataset.ext || '—';
}, true);

$('#crumbs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go]');
  if (b) go(b.dataset.go);
});
$('#listHead').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-sort]');
  if (!b) return;
  if (sortKey === b.dataset.sort) sortDir = -sortDir;
  else { sortKey = b.dataset.sort; sortDir = sortKey === 'name' ? 1 : -1; }
  store.set('sortKey', sortKey);
  store.set('sortDir', sortDir);
  renderList();
});
$('#search').addEventListener('input', (e) => { filter = e.target.value; renderList(); });
for (const b of document.querySelectorAll('.view-seg button')) {
  b.addEventListener('click', () => { view = b.dataset.view; store.set('view', view); renderList(); });
}

// ---------- sélection multiple ----------
function setSel(i, on) {
  const e = visible[i];
  if (!e) return;
  const rel = join(cwd, e.name);
  if (on) selected.add(rel); else selected.delete(rel);
}
function renderSelection() {
  for (const li of $('#list').children) {
    const e = visible[li.dataset.i];
    const on = !!e && selected.has(join(cwd, e.name));
    li.classList.toggle('sel', on);
    const cb = li.querySelector('input[data-sel]');
    if (cb) cb.checked = on;
  }
  const n = selected.size;
  const all = $('#selAll');
  all.checked = n > 0 && visible.length > 0 && visible.every((e) => selected.has(join(cwd, e.name)));
  all.indeterminate = n > 0 && !all.checked;
  document.body.classList.toggle('selecting', n > 0);
  $('#selbar').hidden = n === 0;
  if (!n) return;
  const items = selectedEntries();
  const files = items.filter((e) => !e.dir);
  const size = files.reduce((s, e) => s + e.size, 0);
  $('#selTxt').textContent = `${n} sélectionné${n > 1 ? 's' : ''}${files.length ? ` · ${fmtSize(size)}` : ''}`;
  $('#selShare').hidden = n === 0;
  $('#selDl').querySelector('span').textContent = n === 1 && !items[0]?.dir ? 'Télécharger' : 'Télécharger (ZIP)';
}
const selectedEntries = () => entries.filter((e) => selected.has(join(cwd, e.name)));
function clearSelection() { selected.clear(); lastSelIdx = -1; renderSelection(); }

$('#selAll').addEventListener('change', (e) => {
  if (e.target.checked) visible.forEach((_, i) => setSel(i, true));
  else selected.clear();
  renderSelection();
});
$('#selClear').addEventListener('click', clearSelection);
$('#selDl').addEventListener('click', () => {
  const items = selectedEntries();
  if (items.length === 1 && !items[0].dir) clickLink(fileUrl(join(cwd, items[0].name)));
  else downloadZip(items.map((e) => join(cwd, e.name)));
});
$('#selShare').addEventListener('click', () => {
  const items = selectedEntries();
  if (items.length) openShare(items.map((e) => join(cwd, e.name)));
});
$('#selDel').addEventListener('click', () => deleteItems(selectedEntries().map((e) => join(cwd, e.name))));

// ---------- actions ----------
function clickLink(href) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  document.body.append(a);
  a.click();
  a.remove();
}
function downloadZip(rels, name) {
  if (!rels.length) return;
  if (rels.length === 1) { clickLink(zipUrl(rels[0])); toast('Préparation du ZIP…'); return; }
  // sélection multiple : POST dans une iframe cachée (pas de navigation, pas de limite d'URL)
  const form = document.createElement('form');
  form.method = 'POST';
  form.action = `/zip${user ? `?u=${enc(user)}` : ''}`;
  form.target = 'dlFrame';
  form.hidden = true;
  for (const r of rels) {
    const i = document.createElement('input');
    i.name = 'p'; i.value = r;
    form.append(i);
  }
  const n = document.createElement('input');
  n.name = 'name';
  n.value = name || `${cwd ? cwd.split('/').pop() : 'Partage'} (${rels.length} éléments)`;
  form.append(n);
  document.body.append(form);
  form.submit();
  form.remove();
  toast(`ZIP de ${rels.length} éléments en cours de téléchargement`);
}

async function deleteItems(rels) {
  if (!rels.length) return;
  const one = rels.length === 1;
  const name = rels[0].split('/').pop();
  const ok = await ask({
    title: one ? `Supprimer « ${name} » ?` : `Supprimer ${rels.length} éléments ?`,
    text: 'La suppression est définitive. Les liens publics vers ces éléments seront aussi désactivés.',
    ok: 'Supprimer', danger: true,
  });
  if (!ok) return;
  try {
    const r = await api('POST', '/api/delete', { paths: rels });
    for (const x of rels) selected.delete(x);
    renderSelection();
    toast(r.deleted > 1 ? `${r.deleted} éléments supprimés` : 'Supprimé', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

async function renameItem(rel) {
  const name = rel.split('/').pop();
  const nn = await ask({ title: 'Renommer', value: name, ok: 'Renommer' });
  if (!nn || nn === name) return;
  if (/[/\\]/.test(nn)) { toast('Le nom ne peut pas contenir / ou \\', 'err'); return; }
  try {
    await api('POST', '/api/rename', { from: rel, to: join(rel.split('/').slice(0, -1).join('/'), nn) });
    toast('Renommé', 'ok');
  } catch (err) { toast(err.message, 'err'); }
}

function openEntry(i, ev) {
  const e = visible[i];
  if (!e) return;
  const rel = join(cwd, e.name);
  if (e.dir) { ev?.preventDefault(); go(rel); return; }
  if (kindOf(e.name)) {
    if (ev && (ev.ctrlKey || ev.metaKey || ev.button === 1)) return; // nouvel onglet
    ev?.preventDefault();
    openViewer(e);
  }
  // sinon : le lien télécharge le fichier
}

function menuFor(e) {
  const rel = join(cwd, e.name);
  const items = [];
  if (e.dir) {
    items.push(['Ouvrir', I.dir, () => go(rel)]);
    items.push(['Télécharger en ZIP', I.dl, () => downloadZip([rel])]);
  } else {
    if (kindOf(e.name)) items.push(['Aperçu', I.eye, () => openViewer(e)]);
    items.push(['Télécharger', I.dl, () => clickLink(fileUrl(rel))]);
  }
  items.push(['Partager un lien public…', I.share, () => openShare([rel])]);
  if (!e.dir) {
    items.push(['Copier le lien interne', I.link, async () => {
      const ok = await copyText(location.origin + fileUrl(rel).replace(/[?&]u=[^&]*/, ''));
      toast(ok ? 'Lien copié (mot de passe requis)' : 'Copie impossible', ok ? 'ok' : 'err');
    }]);
  }
  items.push(['Sélectionner', I.check, () => { selected.add(rel); renderSelection(); }]);
  items.push('-');
  items.push(['Renommer…', I.edit, () => renameItem(rel)]);
  items.push(['Supprimer…', I.del, () => deleteItems([rel]), 'danger']);
  return items;
}

const menuEl = $('#menu');
let menuActions = [];
function openMenu(items, x, y) {
  menuActions = items.filter((it) => it !== '-');
  let k = 0;
  menuEl.innerHTML = items.map((it) => (it === '-' ? '<hr>'
    : `<button role="menuitem" data-mi="${k++}" class="${it[3] || ''}">${it[1]}<span>${esc(it[0])}</span></button>`)).join('');
  menuEl.hidden = false;
  const r = menuEl.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - r.width - 8);
  const top = y + r.height > window.innerHeight - 8 ? Math.max(8, y - r.height) : y;
  menuEl.style.left = `${Math.max(8, left)}px`;
  menuEl.style.top = `${top}px`;
  menuEl.querySelector('button')?.focus({ preventScroll: true });
}
function closeMenu() { menuEl.hidden = true; }
menuEl.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-mi]');
  if (!b) return;
  closeMenu();
  menuActions[b.dataset.mi][2]();
});
document.addEventListener('pointerdown', (e) => { if (!menuEl.hidden && !menuEl.contains(e.target)) closeMenu(); });
window.addEventListener('scroll', closeMenu, true);
window.addEventListener('resize', closeMenu);
menuEl.addEventListener('keydown', (e) => {
  const btns = [...menuEl.querySelectorAll('button')];
  const i = btns.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
});

$('#list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  const i = Number(li.dataset.i);
  const cb = e.target.closest('input[data-sel]');
  if (cb) {
    if (e.shiftKey && lastSelIdx >= 0) {
      const [a, b] = [Math.min(lastSelIdx, i), Math.max(lastSelIdx, i)];
      for (let k = a; k <= b; k++) setSel(k, cb.checked);
    } else setSel(i, cb.checked);
    lastSelIdx = i;
    renderSelection();
    return;
  }
  if (e.target.closest('label.ck')) return;
  const btn = e.target.closest('[data-act]');
  if (btn) {
    const ent = visible[i];
    const rel = join(cwd, ent.name);
    if (btn.dataset.act === 'more') {
      const r = btn.getBoundingClientRect();
      openMenu(menuFor(ent), r.right - 220, r.bottom + 4);
    } else if (btn.dataset.act === 'share') openShare([rel]);
    else if (btn.dataset.act === 'zip') downloadZip([rel]);
    return;
  }
  if (e.target.closest('a.ib')) return; // téléchargement direct
  // en mode sélection, un clic sur la ligne coche/décoche
  if (selected.size && !e.target.closest('a.name')) {
    setSel(i, !selected.has(join(cwd, visible[i].name)));
    lastSelIdx = i;
    renderSelection();
    return;
  }
  const opener = e.target.closest('[data-open]') || (!e.target.closest('a') && li);
  if (opener) openEntry(i, e);
});
$('#list').addEventListener('contextmenu', (e) => {
  const li = e.target.closest('li[data-i]');
  if (!li) return;
  e.preventDefault();
  openMenu(menuFor(visible[li.dataset.i]), e.clientX, e.clientY);
});

document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
  if (e.key === 'Escape') {
    if (!menuEl.hidden) { closeMenu(); return; }
    if (!$('#viewer').hidden) return;
    if (selected.size && !document.querySelector('dialog[open]')) clearSelection();
  }
  if (typing || document.querySelector('dialog[open]') || !$('#viewer').hidden) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault();
    visible.forEach((_, i) => setSel(i, true));
    renderSelection();
  }
  if ((e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) && selected.size) {
    deleteItems(selectedEntries().map((x) => join(cwd, x.name)));
  }
});

$('#mkdirBtn').addEventListener('click', async () => {
  const n = await ask({ title: 'Nouveau dossier', text: `Dans ${cwd ? `/${cwd}` : 'la racine'}`, value: '', ok: 'Créer' });
  if (!n) return;
  try { await api('POST', '/api/mkdir', { path: join(cwd, n) }); toast('Dossier créé', 'ok'); } catch (e) { toast(e.message, 'err'); }
});

// ---------- moteur d'envoi ----------
const transfers = []; // envois de cet onglet
const remotes = new Map(); // envois d'autres appareils
let activeFiles = 0;

function enqueue(items) {
  if (!items.length) return;
  for (const { file, rel } of items) {
    transfers.push({
      key: Math.random().toString(36).slice(2), file, name: rel, dir: cwd, size: file.size,
      state: 'queued', msg: 'En attente', done: new Set(), inflight: new Map(), samples: [], speed: 0,
      chunk: 0, n: 0, xhrs: new Set(),
    });
  }
  setTab('transfers');
  const total = items.reduce((s, i) => s + i.file.size, 0);
  toast(`${items.length} fichier${items.length > 1 ? 's' : ''} ajouté${items.length > 1 ? 's' : ''} (${fmtSize(total)})`);
  dirty();
  pump();
}

function pump() {
  while (activeFiles < CONC_FILES) {
    const u = transfers.find((t) => t.state === 'queued');
    if (!u) break;
    run(u);
  }
}

const chunkLen = (u, i) => Math.min(u.chunk, u.size - i * u.chunk);
function loaded(u) {
  if (u.state === 'done') return u.size;
  let b = 0;
  for (const i of u.done) b += chunkLen(u, i);
  for (const v of u.inflight.values()) b += v;
  return Math.min(b, u.size);
}

async function run(u) {
  activeFiles++;
  u.state = 'init';
  u.msg = 'Préparation…';
  dirty();
  try {
    const r = await api('POST', '/api/upload/init', { dir: u.dir, name: u.name, size: u.size, lastModified: u.file.lastModified });
    u.id = r.id;
    if (remotes.delete(r.id)) dirty();
    u.chunk = r.chunkSize;
    u.n = Math.ceil(u.size / u.chunk);
    u.done = new Set(r.done);
    if (u.state !== 'init') return; // annulé/mis en pause pendant l'init
    u.state = 'uploading';
    u.samples = [];
    u.msg = r.done.length ? `Reprise : ${fmtSize(loaded(u))} déjà sur le serveur` : 'Envoi en cours';
    u.startedAt = performance.now();
    u.startBytes = loaded(u);
    dirty();
    await sendAll(u);
    if (u.state !== 'uploading') return;
    u.state = 'finalizing';
    u.msg = 'Finalisation sur le serveur…';
    dirty();
    const c = await api('POST', `/api/upload/${u.id}/complete`);
    const secs = (performance.now() - u.startedAt) / 1000;
    u.state = 'done';
    u.finishedAt = Date.now();
    const sent = u.size - u.startBytes;
    u.msg = c.path !== join(u.dir, u.name)
      ? `Enregistré sous « ${c.name} »`
      : `Envoyé en ${fmtEta(secs)}${sent > 4 * 1048576 && secs > 0.2 ? ` · moy. ${fmtSpeed(sent / secs)}` : ''}`;
  } catch (e) {
    if (u.state !== 'paused' && u.state !== 'canceled') {
      u.state = 'error';
      u.msg = e.message || 'Erreur';
    }
  } finally {
    activeFiles--;
    u.inflight.clear();
    u.xhrs.clear();
    dirty();
    pump();
    checkAllDone();
  }
}

function sendAll(u) {
  return new Promise((resolve, reject) => {
    const pending = [];
    for (let i = 0; i < u.n; i++) if (!u.done.has(i)) pending.push(i);
    let running = 0;
    let failed = false;
    const launch = () => {
      if (failed) return;
      if (u.state !== 'uploading' && u.state !== 'retry') { if (running === 0) resolve(); return; }
      while (running < CONC_CHUNKS && pending.length) {
        const idx = pending.shift();
        running++;
        chunkWithRetry(u, idx)
          .then(() => { u.done.add(idx); }, (err) => {
            if ((u.state === 'uploading' || u.state === 'retry') && !failed) {
              failed = true;
              abortAll(u);
              reject(err);
            }
          })
          .finally(() => {
            running--;
            u.inflight.delete(idx);
            dirty();
            if (!failed) launch();
          });
      }
      if (!pending.length && running === 0) resolve();
    };
    launch();
  });
}

async function chunkWithRetry(u, idx) {
  for (let a = 0; ; a++) {
    try {
      await sendChunk(u, idx);
      if (u.state === 'retry') { u.state = 'uploading'; u.msg = 'Connexion rétablie, envoi en cours'; }
      return;
    } catch (e) {
      if (e.aborted || (u.state !== 'uploading' && u.state !== 'retry')) throw e;
      if (e.status && e.status >= 400 && e.status < 500) throw e;
      if (a >= MAX_RETRY) throw new Error(`Échec après ${MAX_RETRY} tentatives : ${e.message}`);
      const wait = Math.min(10000, 600 * 2 ** a);
      u.state = 'retry';
      u.msg = `${e.message} — nouvelle tentative ${a + 1}/${MAX_RETRY} dans ${Math.round(wait / 1000)} s`;
      dirty();
      await sleep(wait);
      if (u.state !== 'retry' && u.state !== 'uploading') throw Object.assign(new Error('arrêté'), { aborted: true });
    }
  }
}

function sendChunk(u, idx) {
  return new Promise((resolve, reject) => {
    const start = idx * u.chunk;
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/upload/${u.id}/${idx}`);
    for (const [k, v] of Object.entries(hdrs())) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => { u.inflight.set(idx, e.loaded); dirty(); };
    xhr.onload = () => {
      u.xhrs.delete(xhr);
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      if (xhr.status === 401) { u.state = 'paused'; u.msg = 'Session expirée — reconnectez-vous puis reprenez'; toLogin(); }
      let msg = `Erreur ${xhr.status}`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* ignoré */ }
      u.inflight.delete(idx);
      reject(Object.assign(new Error(msg), { status: xhr.status }));
    };
    xhr.onerror = () => { u.xhrs.delete(xhr); u.inflight.delete(idx); reject(new Error('Connexion interrompue')); };
    xhr.onabort = () => { u.xhrs.delete(xhr); u.inflight.delete(idx); reject(Object.assign(new Error('annulé'), { aborted: true })); };
    u.xhrs.add(xhr);
    xhr.send(u.file.slice(start, start + chunkLen(u, idx)));
  });
}

function abortAll(u) { for (const x of [...u.xhrs]) x.abort(); }

function pause(u) {
  if (!['uploading', 'retry', 'init', 'queued'].includes(u.state)) return;
  u.state = 'paused';
  u.msg = 'En pause — la progression est conservée sur le serveur';
  abortAll(u);
  dirty();
}
function resume(u) {
  u.state = 'queued';
  u.msg = 'En attente de reprise';
  dirty();
  pump();
}
async function cancel(u) {
  const wasActive = !['done', 'error', 'canceled'].includes(u.state);
  u.state = 'canceled';
  u.msg = 'Annulé';
  abortAll(u);
  dirty();
  if (u.id && wasActive) api('DELETE', `/api/upload/${u.id}`).catch(() => {});
  setTimeout(() => removeTransfer(u), 1500);
}
function removeTransfer(u) {
  const i = transfers.indexOf(u);
  if (i >= 0) transfers.splice(i, 1);
  dirty();
}

function checkAllDone() {
  const busy = transfers.some((t) => ['queued', 'init', 'uploading', 'retry', 'finalizing'].includes(t.state));
  if (busy || !transfers.length) return;
  const done = transfers.filter((t) => t.state === 'done' && !t.notified);
  if (!done.length) return;
  done.forEach((t) => { t.notified = true; });
  const err = transfers.filter((t) => t.state === 'error').length;
  toast(err ? `${done.length} envoyé${done.length > 1 ? 's' : ''}, ${err} en erreur` : `Envoi terminé : ${done.length} fichier${done.length > 1 ? 's' : ''}`, err ? 'err' : 'ok');
}

window.addEventListener('beforeunload', (e) => {
  if (leaving) return;
  if (transfers.some((t) => ['queued', 'init', 'uploading', 'retry', 'finalizing'].includes(t.state))) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- rendu des transferts (temps réel) ----------
const LABEL = {
  queued: 'En attente', init: 'Préparation', uploading: 'Envoi', retry: 'Nouvel essai', paused: 'Pause',
  finalizing: 'Finalisation', done: 'Terminé', error: 'Erreur', canceled: 'Annulé', remote: 'Reçoit', stalled: 'Interrompu',
};
const GLYPH = {
  uploading: '<svg viewBox="0 0 24 24"><path d="M12 18V6m0 0-5 5m5-5 5 5"/></svg>',
  remote: '<svg viewBox="0 0 24 24"><path d="M12 6v12m0 0-5-5m5 5 5-5"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 14-5.3M20 4v4h-4M20 12a8 8 0 0 1-14 5.3M4 20v-4h4"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  paused: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  stalled: '<svg viewBox="0 0 24 24"><path d="M9 6v12M15 6v12"/></svg>',
  error: '<svg viewBox="0 0 24 24"><path d="M12 6v7.5M12 17.5v.5"/></svg>',
  canceled: '<svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg>',
};
const els = new Map();
let isDirty = true;
function dirty() { isDirty = true; }

function sample(t, bytes, now) {
  t.samples.push([now, bytes]);
  while (t.samples.length > 2 && now - t.samples[0][0] > 3000) t.samples.shift();
  const [t0, b0] = t.samples[0];
  t.speed = now - t0 > 400 ? Math.max(0, ((bytes - b0) * 1000) / (now - t0)) : t.speed || 0;
}

function tick() {
  const now = performance.now();
  for (const t of transfers) {
    if (t.state === 'uploading' || t.state === 'retry') sample(t, loaded(t), now);
    else t.speed = 0;
  }
  for (const r of remotes.values()) if (r.state === 'remote') sample(r, r.received, now);
  isDirty = true;
}
setInterval(tick, 500);

function itemEl(key, isRemote) {
  let el = els.get(key);
  if (el) return el;
  el = document.createElement('li');
  el.className = 'titem';
  el.innerHTML = `<div class="tring"><svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><circle class="trk" cx="18" cy="18" r="15.5"/><circle class="val" cx="18" cy="18" r="15.5" pathLength="100"/></svg><span class="glyph"></span></div>
    <div class="tbody"><div class="trow"><span class="tname"></span><span class="badge"></span></div>
    <div class="tsub"></div><div class="tmeta"><span class="tl"></span><span class="tr"></span></div><div class="tmsg"></div></div>
    <div class="tbtns"></div>`;
  el.r = {
    badge: el.querySelector('.badge'), name: el.querySelector('.tname'), btns: el.querySelector('.tbtns'),
    sub: el.querySelector('.tsub'), ring: el.querySelector('.val'), glyph: el.querySelector('.glyph'),
    l: el.querySelector('.tl'), r: el.querySelector('.tr'), msg: el.querySelector('.tmsg'),
  };
  el.dataset.key = key;
  el.remote = isRemote;
  els.set(key, el);
  return el;
}

function setText(node, v) { if (node.textContent !== v) node.textContent = v; }

function renderTransfers() {
  if (!isDirty) return;
  isDirty = false;
  const list = $('#tlist');
  const all = [
    ...[...remotes.values()].map((r) => ({ ...r, key: `r:${r.id}`, remote: true })),
    ...transfers,
  ];
  // ordre : actifs d'abord, puis en attente, puis terminés
  const rank = { uploading: 0, retry: 0, remote: 0, init: 1, finalizing: 1, paused: 2, stalled: 2, queued: 3, error: 4, done: 5, canceled: 6 };
  all.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
  const shown = all.slice(0, 200);
  const keep = new Set(shown.map((t) => t.key));
  for (const [k, el] of els) if (!keep.has(k)) { el.remove(); els.delete(k); }

  let prev = null;
  for (const t of shown) {
    const el = itemEl(t.key, t.remote);
    const lb = t.remote ? t.received : loaded(t);
    const pct = t.size ? (lb / t.size) * 100 : (t.state === 'done' ? 100 : 0);
    el.dataset.s = t.state;
    setText(el.r.badge, t.state === 'uploading' || t.state === 'remote' ? `${Math.floor(pct)} %` : LABEL[t.state]);
    setText(el.r.name, t.name.split('/').pop());
    el.r.name.title = t.name;
    const where = `/${join(t.dir, t.name.split('/').slice(0, -1).join('/'))}`;
    setText(el.r.sub, t.remote ? `${t.user === (user || me) ? 'Vous' : t.user} → ${where}` : `Vers ${where}`);
    el.r.ring.style.strokeDashoffset = (100 - pct).toFixed(2);
    const g = GLYPH[t.state] || '';
    if (el.r.glyph.dataset.g !== t.state) { el.r.glyph.dataset.g = t.state; el.r.glyph.innerHTML = g; }
    setText(el.r.l, `${fmtSize(lb)} / ${fmtSize(t.size)}`);
    let right = '';
    if ((t.state === 'uploading' || t.state === 'remote') && t.speed > 0) right = `${fmtSpeed(t.speed)} · reste ${fmtEta((t.size - lb) / t.speed)}`;
    else if (t.state === 'uploading' || t.state === 'remote') right = 'calcul du débit…';
    setText(el.r.r, right);
    let msg = t.remote ? (t.state === 'done' ? 'Reçu ✓' : '') : t.msg;
    if (t.state === 'stalled') {
      msg = t.user === (user || me)
        ? 'Envoi interrompu (page rechargée ou connexion coupée). Redéposez le même fichier pour reprendre là où il s\'est arrêté.'
        : 'Envoi interrompu. Il reprendra si l\'expéditeur redépose le fichier.';
    }
    if (!t.remote && t.state === 'uploading' && t.n > 1) msg = `${t.msg} · morceaux ${t.done.size}/${t.n} · ${t.inflight.size} en parallèle`;
    setText(el.r.msg, msg || '');
    el.r.msg.hidden = !msg;
    if (t.remote) {
      const sig = t.state === 'stalled' ? 'rcancel' : '';
      if (el.r.btns.dataset.sig !== sig) {
        el.r.btns.dataset.sig = sig;
        el.r.btns.innerHTML = sig ? `<button class="ib" data-t="rcancel" title="Abandonner cet envoi" aria-label="Abandonner cet envoi">${I.x}</button>` : '';
      }
    } else {
      const btns = [];
      if (['uploading', 'retry', 'init', 'queued'].includes(t.state)) btns.push(['pause', 'Mettre en pause', I.pause]);
      if (t.state === 'paused') btns.push(['resume', 'Reprendre', I.play]);
      if (t.state === 'error') btns.push(['resume', 'Réessayer', I.retry]);
      if (t.state !== 'done' && t.state !== 'canceled' && t.state !== 'finalizing') btns.push(['cancel', 'Annuler', I.x]);
      if (t.state === 'done') btns.push(['remove', 'Retirer de la liste', I.x]);
      const sig = btns.map((b) => b[0]).join(',');
      if (el.r.btns.dataset.sig !== sig) {
        el.r.btns.dataset.sig = sig;
        el.r.btns.innerHTML = btns.map(([a, l, ic]) => `<button class="ib" data-t="${a}" title="${l}" aria-label="${l}">${ic}</button>`).join('');
      }
    }
    // ne déplace le nœud que si l'ordre change
    const expected = prev ? prev.nextSibling : list.firstChild;
    if (expected !== el) list.insertBefore(el, expected);
    prev = el;
  }

  // résumé global
  const mine = transfers.filter((t) => t.state !== 'canceled');
  const active = mine.filter((t) => ['queued', 'init', 'uploading', 'retry', 'finalizing', 'paused'].includes(t.state));
  const running = mine.filter((t) => ['uploading', 'retry', 'init', 'finalizing'].includes(t.state));
  const remoteActive = [...remotes.values()].filter((r) => r.state === 'remote');
  const speed = mine.reduce((s, t) => s + (t.speed || 0), 0);
  $('#tEmpty').hidden = all.length > 0;
  setCount('#cTransfers', active.length + remoteActive.length);
  $('#clearDone').hidden = !mine.some((t) => t.state === 'done' || t.state === 'error');
  const sum = $('#summary');
  const topbar = $('#topbar');
  if (active.length) {
    const tot = active.reduce((s, t) => s + t.size, 0);
    const got = active.reduce((s, t) => s + loaded(t), 0);
    const pct = tot ? (got / tot) * 100 : 100;
    const queued = active.filter((t) => t.state === 'queued').length;
    const paused = active.filter((t) => t.state === 'paused').length;
    const bits = [`${running.length} en cours`];
    if (queued) bits.push(`${queued} en attente`);
    if (paused) bits.push(`${paused} en pause`);
    sum.hidden = false;
    const eta = speed > 0 ? ` · reste ${fmtEta((tot - got) / speed)}` : '';
    setText($('#sumLeft'), `${bits.join(', ')} · ${fmtSize(got)} sur ${fmtSize(tot)}`);
    setText($('#sumRight'), `${Math.floor(pct)} %  ${speed > 0 ? `${fmtSpeed(speed)}${eta}` : ''}`);
    $('#sumRing').style.strokeDashoffset = (100 - pct).toFixed(2);
    topbar.hidden = false;
    $('#topbarFill').style.width = `${pct.toFixed(2)}%`;
    setText($('#topbarText'), `Envoi ${Math.floor(pct)} % · ${fmtSize(got)} / ${fmtSize(tot)} · ${fmtSpeed(speed)}${eta}`);
    document.title = `↑ ${Math.floor(pct)} % · Partage`;
  } else {
    sum.hidden = true;
    if (remoteActive.length) {
      const r = remoteActive[0];
      topbar.hidden = false;
      $('#topbarFill').style.width = `${r.size ? ((r.received / r.size) * 100).toFixed(2) : 0}%`;
      setText($('#topbarText'), `${r.user} envoie ${r.name.split('/').pop()}${remoteActive.length > 1 ? ` (+${remoteActive.length - 1})` : ''}`);
    } else topbar.hidden = true;
    document.title = 'Partage';
  }
}
(function frame() { renderTransfers(); requestAnimationFrame(frame); })();

$('#tlist').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-t]');
  if (!b) return;
  const key = b.closest('.titem').dataset.key;
  if (b.dataset.t === 'rcancel') {
    const id = key.slice(2);
    api('DELETE', `/api/upload/${id}`).then(() => { remotes.delete(id); dirty(); }, (err) => toast(err.message, 'err'));
    return;
  }
  const u = transfers.find((t) => t.key === key);
  if (!u) return;
  ({ pause, resume, cancel, remove: removeTransfer })[b.dataset.t](u);
});
$('#clearDone').addEventListener('click', () => {
  for (const t of [...transfers]) if (t.state === 'done' || t.state === 'error') removeTransfer(t);
  for (const [id, r] of remotes) if (r.state === 'done') remotes.delete(id);
  dirty();
});

// ---------- sélection & glisser-déposer ----------
$('#pickFiles').addEventListener('click', () => $('#fileInput').click());
$('#pickFolder').addEventListener('click', () => $('#dirInput').click());
$('#drop').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  enqueue([...e.target.files].map((f) => ({ file: f, rel: f.name })));
  e.target.value = '';
});
$('#dirInput').addEventListener('change', (e) => {
  enqueue([...e.target.files].map((f) => ({ file: f, rel: f.webkitRelativePath || f.name })));
  e.target.value = '';
});

async function walk(entry, prefix, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file: f, rel: prefix + f.name });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      await Promise.all(batch.map((x) => walk(x, `${prefix}${entry.name}/`, out)));
    }
  }
}

let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('#overlay').classList.add('on');
});
window.addEventListener('dragover', (e) => { if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('#overlay').classList.remove('on'); }
});
window.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $('#overlay').classList.remove('on');
  const dt = e.dataTransfer;
  const ents = [...dt.items].filter((i) => i.kind === 'file').map((i) => i.webkitGetAsEntry?.()).filter(Boolean);
  if (!ents.length) { enqueue([...dt.files].map((f) => ({ file: f, rel: f.name }))); return; }
  const hasDir = ents.some((x) => x.isDirectory);
  if (hasDir) toast('Analyse des dossiers…');
  const out = [];
  try { await Promise.all(ents.map((x) => walk(x, '', out))); } catch (err) { toast(`Lecture impossible : ${err.message}`, 'err'); }
  enqueue(out);
});

// ---------- temps réel ----------
function setWho() {
  const n = user || me || '…';
  $('#whoName').textContent = n;
  const av = $('#whoAvatar');
  if (user) av.textContent = user.trim().charAt(0).toUpperCase();
  else av.innerHTML = '<svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="3.6"/><path d="M5.5 19.5c1.2-3 3.7-4.5 6.5-4.5s5.3 1.5 6.5 4.5"/></svg>';
}
function renderPresence(users, count) {
  const el = $('#online');
  el.textContent = `${count} appareil${count > 1 ? 's' : ''}`;
  el.title = users.join('\n');
}
function renderStats(s) {
  if (!s) return;
  const used = s.total - s.free;
  const pct = s.total ? (used / s.total) * 100 : 0;
  $('#diskFill').style.width = `${pct.toFixed(1)}%`;
  $('#disk').classList.toggle('high', pct > 90);
  $('#diskText').textContent = `${fmtSize(s.free)} libres`;
  $('#disk').title = `Utilisé ${fmtSize(used)} sur ${fmtSize(s.total)} (${pct.toFixed(0)} %)`;
}
function addActivity(item, fresh) {
  const li = document.createElement('li');
  if (fresh) li.className = 'new';
  li.innerHTML = `<span class="k ${esc(item.kind)}"></span><span class="txt"><span class="who">${esc(item.user)}</span> ${esc(item.text)}</span><time>${tf.format(item.t)}</time>`;
  const feed = $('#feed');
  feed.prepend(li);
  while (feed.children.length > 80) feed.lastChild.remove();
  $('#feedEmpty').hidden = true;
  $('#clearFeed').hidden = false;
}
function upsertRemote(up) {
  if (up.tab === TAB) return;
  if (transfers.some((t) => t.id === up.id && !['done', 'canceled', 'error'].includes(t.state))) return;
  let r = remotes.get(up.id);
  if (!r) { r = { ...up, state: 'remote', samples: [], speed: 0 }; remotes.set(up.id, r); }
  if (r.received !== up.received) r.lastMove = Date.now();
  Object.assign(r, up);
  if (r.state !== 'done') r.state = up.stalled ? 'stalled' : 'remote';
  dirty();
}

let es = null;
function connect() {
  if (es) es.close();
  es = new EventSource(`/api/events${user ? `?u=${enc(user)}` : ''}`);
  const live = $('#live');
  es.onopen = () => { live.dataset.state = 'on'; $('#liveText').textContent = 'En direct'; };
  es.onerror = () => {
    live.dataset.state = 'off';
    $('#liveText').textContent = 'Reconnexion…';
    // un flux SSE refusé (401) ne se reconnecte pas : on vérifie la session
    fetch('/api/stats', { headers: hdrs() }).then((r) => { if (r.status === 401) toLogin(); }, () => {});
  };
  es.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    switch (ev.type) {
      case 'hello':
        me = ev.you;
        setWho();
        $('#feed').innerHTML = '';
        $('#feedEmpty').hidden = ev.activity.length > 0;
        for (const a of ev.activity) addActivity(a, false);
        remotes.clear();
        for (const up of ev.uploads) if (up.tab !== TAB) upsertRemote({ ...up, stale: true });
        renderStats(ev.stats);
        renderPresence(ev.users, ev.count);
        sharesList = ev.shares || [];
        renderShares();
        clipsList = ev.clips || [];
        renderClips();
        addresses = ev.addresses || [];
        publicUrl = ev.publicUrl || null;
        renderShareScope();
        reloadSoon();
        break;
      case 'shares': sharesList = ev.shares; renderShares(); break;
      case 'public-url': publicUrl = ev.url; addresses = ev.addresses || addresses; renderShareScope(); break;
      case 'clips': clipsList = ev.clips; renderClips(); break;
      case 'clip-add':
        clipsList.unshift({ ...ev.clip, fresh: true });
        if (clipsList.length > 100) clipsList.length = 100;
        if (tab !== 'clips' && ev.clip.by !== (user || me)) unreadClips++;
        renderClips();
        break;
      case 'clip-del': clipsList = clipsList.filter((c) => c.id !== ev.id); renderClips(); break;
      case 'note': if (myNotes[ev.code]) { if (ev.deleted) { delete myNotes[ev.code]; nkeys.del(ev.code); renderNotes(); } else refreshNote(ev.code); } break;
      case 'presence': renderPresence(ev.users, ev.count); break;
      case 'stats': renderStats(ev.stats); break;
      case 'activity': addActivity(ev.item, true); break;
      case 'activity-clear':
        $('#feed').innerHTML = '';
        $('#feedEmpty').hidden = false;
        $('#clearFeed').hidden = true;
        break;
      case 'change': reloadSoon(); break;
      case 'progress': upsertRemote(ev.upload); break;
      case 'upload-done': {
        const r = remotes.get(ev.id);
        if (r) {
          r.state = 'done';
          r.received = r.size;
          dirty();
          setTimeout(() => { remotes.delete(ev.id); dirty(); }, 6000);
        }
        break;
      }
      case 'upload-cancel': {
        remotes.delete(ev.id);
        const mine = transfers.find((t) => t.id === ev.id && !['done', 'canceled'].includes(t.state));
        if (mine) { mine.state = 'canceled'; mine.msg = 'Annulé (supprimé du serveur)'; abortAll(mine); }
        dirty();
        break;
      }
    }
  };
}

// envois « fantômes » d'autres appareils : on les masque s'ils ne bougent plus
setInterval(() => {
  const now = Date.now();
  for (const r of remotes.values()) {
    if (r.state !== 'remote') continue;
    if (r.lastReceived !== r.received) { r.lastReceived = r.received; r.lastMove = now; }
    r.stalled = now - (r.lastMove || now) > 20000;
  }
  for (const r of remotes.values()) if (r.state === 'remote' && r.stalled && r.speed === 0) { r.state = 'stalled'; dirty(); }
}, 5000);

$('#clearFeed').addEventListener('click', async () => {
  const ok = await ask({
    title: 'Effacer l\'historique ?',
    text: 'L\'activité sera effacée pour tous les appareils connectés. Les fichiers ne sont pas touchés.',
    ok: 'Effacer', danger: true,
  });
  if (!ok) return;
  try { await api('DELETE', '/api/activity'); toast('Historique effacé', 'ok'); } catch (e) { toast(e.message, 'err'); }
});

$('#logoutBtn').addEventListener('click', async () => {
  const busy = transfers.some((t) => ['queued', 'init', 'uploading', 'retry', 'finalizing'].includes(t.state));
  const ok = await ask({
    title: 'Se déconnecter ?',
    text: busy ? 'Des envois sont en cours : ils seront interrompus (la progression reste sur le serveur).' : 'Il faudra saisir à nouveau le mot de passe.',
    ok: 'Se déconnecter', danger: busy,
  });
  if (!ok) return;
  for (const t of transfers) abortAll(t);
  await fetch('/api/logout', { method: 'POST' }).catch(() => {});
  leaving = true;
  location.href = '/login';
});

$('#whoBtn').addEventListener('click', async () => {
  const n = await ask({ title: 'Votre nom', text: 'Affiché aux autres dans l\'activité en direct. Laissez vide pour utiliser votre adresse IP.', value: user, ok: 'Enregistrer' });
  if (n === null && !user) return;
  user = (n || '').slice(0, 40);
  store.set('user', user);
  setWho();
  connect();
});

// ---------- onglets du panneau latéral ----------
let tab = store.get('tab') || 'transfers';
function setTab(t) {
  tab = t;
  store.set('tab', t);
  for (const b of document.querySelectorAll('.tabs button')) {
    const on = b.dataset.tab === t;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', String(on));
  }
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== t;
  if (t === 'clips') { unreadClips = 0; renderCounts(); }
  if (t === 'notes') loadMyNotes();
}
for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => setTab(b.dataset.tab));
function setCount(id, n) {
  const el = $(id);
  el.hidden = !n;
  el.textContent = n > 99 ? '99+' : String(n);
}
let unreadClips = 0;
function renderCounts() {
  setCount('#cClips', unreadClips);
  setCount('#cLinks', sharesList.filter((s) => s.state === 'active').length);
  setCount('#cNotes', Object.keys(myNotes).length);
}

// ---------- QR code ----------
function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  return `<svg viewBox="-3 -3 ${n + 6} ${n + 6}" shape-rendering="crispEdges" role="img" aria-label="QR code"><rect x="-3" y="-3" width="${n + 6}" height="${n + 6}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

let addresses = [];
function openQr() {
  const here = location.origin;
  const list = [...addresses];
  const local = /^(localhost|127\.|\[::1\])/.test(location.hostname);
  if (!local && !list.some((a) => a.url === here)) list.unshift({ label: 'Cette adresse', url: here });
  if (!list.length) list.push({ label: 'Cette adresse', url: here });
  const seg = $('#qrAddrs');
  seg.innerHTML = list.map((a, i) => `<button type="button" data-i="${i}" title="${esc(a.url)}">${esc(a.label)}</button>`).join('');
  seg.hidden = list.length < 2;
  const pick = (i) => {
    const url = list[i].url + (location.hash || '');
    $('#qrBox').innerHTML = qrSvg(url);
    $('#qrUrl').value = url;
    for (const b of seg.children) b.classList.toggle('on', Number(b.dataset.i) === i);
  };
  seg.onclick = (e) => { const b = e.target.closest('button'); if (b) pick(Number(b.dataset.i)); };
  pick(Math.max(0, list.findIndex((a) => a.url === here)));
  $('#qrDlg').showModal();
}
$('#qrBtn').addEventListener('click', openQr);
$('#qrCopy').addEventListener('click', async () => {
  const ok = await copyText($('#qrUrl').value);
  toast(ok ? 'Adresse copiée' : 'Copie impossible', ok ? 'ok' : 'err');
});

// ---------- liens de partage publics ----------
let sharesList = [];
let shTarget = null;
let shShown = null;
let publicUrl = null;
const linkBase = () => publicUrl || location.origin;
const shareUrl = (s) => (s.code ? `${linkBase()}/${s.code}` : `${linkBase()}/s/${s.id}`);
const shareName = (s) => s.title || ((s.count || 1) > 1 ? `${s.count} éléments` : s.path.split('/').pop());
function renderShareScope() {
  $('#shScope').innerHTML = publicUrl
    ? 'Un <b>lien court</b> que toute personne peut ouvrir <b>depuis internet</b>, sans compte. Ajoutez un mot de passe pour en limiter l\'accès.'
    : 'Un <b>lien court</b> que toute personne qui peut joindre ce serveur (réseau local, VPN) peut ouvrir, sans compte. Ajoutez un mot de passe pour en limiter l\'accès.';
}

function segValue(id) { return Number($(id).querySelector('.on')?.dataset.v || 0); }
for (const seg of document.querySelectorAll('#shExp, #shMax')) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of seg.children) x.classList.toggle('on', x === b);
  });
}

function openShare(rels) {
  shTarget = { rels };
  $('#shTitle').textContent = rels.length === 1 ? `Partager « ${rels[0].split('/').pop()} »` : `Partager ${rels.length} éléments`;
  $('#shNameField').hidden = rels.length < 2;
  $('#shName').value = '';
  $('#shPw').value = '';
  $('#shOptions').hidden = false;
  $('#shResult').hidden = true;
  $('#shareDlg').showModal();
}
function shareInfo(s) {
  const bits = [];
  if (s.state === 'expired') bits.push('Expiré');
  else if (s.state === 'exhausted') bits.push('Limite atteinte');
  else bits.push(s.expiresAt ? `Expire ${fmtUntil(s.expiresAt)}` : 'Sans expiration');
  bits.push(s.maxDownloads ? `${s.downloads}/${s.maxDownloads} téléchargement${s.maxDownloads > 1 ? 's' : ''}` : `${s.downloads} téléchargement${s.downloads > 1 ? 's' : ''}`);
  return bits.join(' · ');
}
function fmtUntil(t) {
  const d = t - Date.now();
  if (d <= 0) return 'maintenant';
  if (d < 3600e3) return `dans ${Math.max(1, Math.round(d / 60e3))} min`;
  if (d < 86400e3) return `dans ${Math.round(d / 3600e3)} h`;
  return `le ${dtf.format(t)}`;
}
function showShareResult(s) {
  shShown = s;
  const url = shareUrl(s);
  $('#shTitle').textContent = `Lien public · ${shareName(s)}`;
  $('#shOptions').hidden = true;
  $('#shResult').hidden = false;
  $('#shUrl').value = url;
  $('#shCode').textContent = s.code || '';
  $('#shCode').hidden = !s.code;
  $('#shQr').innerHTML = qrSvg(url);
  const what = (s.count || 1) > 1 ? `${s.count} éléments (un par un ou en ZIP)` : s.dir ? 'Dossier (téléchargé en ZIP)' : fmtSize(s.size);
  $('#shInfo').textContent = `${what} · ${shareInfo(s)}${s.locked ? ' · protégé par mot de passe' : ''}`;
  $('#shOpen').href = url;
  $('#shNative').hidden = !navigator.share;
  if (!$('#shareDlg').open) $('#shareDlg').showModal();
}
$('#shCreate').addEventListener('click', async () => {
  const b = $('#shCreate');
  b.disabled = true;
  try {
    const r = await api('POST', '/api/shares', {
      paths: shTarget.rels, expiresIn: segValue('#shExp'), maxDownloads: segValue('#shMax'),
      password: $('#shPw').value, title: $('#shName').value,
    });
    $('#shPw').value = '';
    showShareResult(r.share);
    const ok = await copyText(shareUrl(r.share));
    toast(ok ? 'Lien créé et copié' : 'Lien créé', 'ok');
  } catch (e) { toast(e.message, 'err'); } finally { b.disabled = false; }
});
$('#shCopy').addEventListener('click', async () => {
  const ok = await copyText($('#shUrl').value);
  $('#shCopy').textContent = ok ? 'Copié ✓' : 'Échec';
  setTimeout(() => { $('#shCopy').textContent = 'Copier'; }, 1500);
});
$('#shNative').addEventListener('click', () => {
  navigator.share({ title: shareName(shShown), url: $('#shUrl').value }).catch(() => {});
});
$('#shRevoke').addEventListener('click', async () => {
  try { await api('DELETE', `/api/shares/${shShown.id}`); $('#shareDlg').close(); toast('Lien désactivé', 'ok'); } catch (e) { toast(e.message, 'err'); }
});
$('#shUrl').addEventListener('focus', (e) => e.target.select());

const STATE_LABEL = { active: 'Actif', expired: 'Expiré', exhausted: 'Limite atteinte' };
function renderShares() {
  const ul = $('#llist');
  ul.innerHTML = sharesList.map((s) => {
    const multi = (s.count || 1) > 1;
    const name = shareName(s);
    const x = extOf(s.path.split('/').pop());
    const icon = s.dir || multi ? `<span class="ico dir sm">${I.dir}</span>` : `<span class="ico sm ${EXTMAP[x] || ''}">${esc(x.slice(0, 4) || '—')}</span>`;
    const where = multi ? s.paths.map((p) => p.split('/').pop()).join(', ') : `/${s.path}`;
    return `<li class="litem" data-id="${esc(s.id)}" data-st="${s.state}">${icon}
      <div class="tbody"><div class="trow"><span class="tname" title="${esc(where)}">${esc(name)}</span><span class="badge">${STATE_LABEL[s.state]}</span>${s.locked ? '<span class="badge lockb" title="Protégé par mot de passe">🔒</span>' : ''}</div>
      <div class="tsub"><b class="lcode">${esc(s.code || '')}</b> · ${esc(where)} · par ${esc(s.by)}</div><div class="tmeta">${esc(shareInfo(s))}</div></div>
      <div class="tbtns">
        <button class="ib" data-l="copy" title="Copier le lien" aria-label="Copier le lien">${I.copy}</button>
        <button class="ib" data-l="qr" title="QR code" aria-label="QR code">${I.qr}</button>
        <button class="ib" data-l="pw" title="${s.locked ? 'Changer ou retirer le mot de passe' : 'Protéger par mot de passe'}" aria-label="Mot de passe">${I.lock}</button>
        <button class="ib del" data-l="del" title="Désactiver" aria-label="Désactiver">${I.del}</button>
      </div></li>`;
  }).join('');
  $('#linksEmpty').hidden = sharesList.length > 0;
  renderCounts();
}
$('#llist').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-l]');
  if (!b) return;
  const s = sharesList.find((x) => x.id === b.closest('li').dataset.id);
  if (!s) return;
  if (b.dataset.l === 'copy') { const ok = await copyText(shareUrl(s)); toast(ok ? 'Lien copié' : 'Copie impossible', ok ? 'ok' : 'err'); }
  if (b.dataset.l === 'qr') showShareResult(s);
  if (b.dataset.l === 'pw') {
    const pw = await ask({
      title: s.locked ? 'Changer le mot de passe' : 'Protéger par mot de passe',
      text: s.locked ? `Nouveau mot de passe pour /${s.code}. Laissez vide et validez pour retirer la protection.` : `Les personnes qui ouvrent /${s.code} devront saisir ce mot de passe.`,
      value: '', ok: 'Enregistrer',
    });
    if (pw === null && !s.locked) return;
    try {
      await api('POST', `/api/shares/${s.id}/password`, { password: pw || '' });
      toast(pw ? 'Lien protégé par mot de passe' : 'Mot de passe retiré', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }
  if (b.dataset.l === 'del') {
    try { await api('DELETE', `/api/shares/${s.id}`); toast('Lien désactivé', 'ok'); } catch (err) { toast(err.message, 'err'); }
  }
});

// ---------- notes partagées (créées depuis cet appareil) ----------
// Les clés d'édition restent dans ce navigateur (même stockage que la page publique de la note).
const nkeys = {
  all() { try { return JSON.parse(localStorage.getItem('partage.notes') || '{}'); } catch { return {}; } },
  set(code, key) { try { const a = this.all(); a[code] = key; localStorage.setItem('partage.notes', JSON.stringify(a)); } catch { /* indisponible */ } },
  del(code) { try { const a = this.all(); delete a[code]; localStorage.setItem('partage.notes', JSON.stringify(a)); } catch { /* indisponible */ } },
};
const myNotes = {};
const noteEditUrl = (code) => `${linkBase()}/${code}#k=${nkeys.all()[code]}`;
async function refreshNote(code) {
  const key = nkeys.all()[code];
  if (!key) return;
  try {
    const r = await fetch(`/${code}/data`, { headers: { 'x-note-key': key } });
    if (r.status === 404 || r.status === 410) { nkeys.del(code); delete myNotes[code]; return renderNotes(); }
    const d = await r.json();
    if (!r.ok) return;
    if (!d.canEdit) { nkeys.del(code); delete myNotes[code]; } else myNotes[code] = d.note;
    renderNotes();
  } catch { /* réseau */ }
}
async function loadMyNotes() {
  await Promise.all(Object.keys(nkeys.all()).map(refreshNote));
  renderNotes();
}
async function createNote(body) {
  const r = await api('POST', '/api/notes', body);
  nkeys.set(r.note.code, r.key);
  myNotes[r.note.code] = r.note;
  renderNotes();
  return r.note;
}
function renderNotes() {
  const list = Object.values(myNotes).sort((a, b) => b.updatedAt - a.updatedAt);
  $('#nlist').innerHTML = list.map((n) => {
    const preview = n.text.trim().replace(/\s+/g, ' ').slice(0, 160);
    return `<li class="citem nitem" data-code="${esc(n.code)}">
      <div class="trow"><span class="tname">${esc(n.title || 'Note sans titre')}</span>${n.locked ? '<span class="badge lockb" title="Protégée par mot de passe">🔒</span>' : ''}</div>
      <div class="ctext nprev">${esc(preview) || '<span class="muted">Vide</span>'}</div>
      <div class="cmeta"><span><b class="lcode">${esc(n.code)}</b> · modifiée ${fmtDate(n.updatedAt)} · ${n.text.length.toLocaleString('fr-FR')} car.</span>
        <span class="cbtns"><a class="btn outline sm" href="${esc(noteEditUrl(n.code))}" target="_blank" rel="noopener">${I.edit}<span>Modifier</span></a>
        <button class="btn outline sm" data-n="copy">${I.copy}<span>Lien</span></button>
        <button class="ib del" data-n="del" title="Supprimer" aria-label="Supprimer">${I.del}</button></span></div></li>`;
  }).join('');
  $('#notesEmpty').hidden = list.length > 0;
  renderCounts();
}
$('#noteNew').addEventListener('click', async () => {
  // la fenêtre est ouverte tout de suite (sinon le navigateur la bloque), puis dirigée vers la note
  const w = window.open('about:blank', '_blank');
  try {
    const n = await createNote({ title: '', text: '' });
    if (w) w.location.href = noteEditUrl(n.code);
    else toast(`Note /${n.code} créée : ouvrez-la depuis la liste`, 'ok');
  } catch (err) { if (w) w.close(); toast(err.message, 'err'); }
});
$('#nlist').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-n]');
  if (!b) return;
  const code = b.closest('li').dataset.code;
  if (b.dataset.n === 'copy') { const ok = await copyText(`${linkBase()}/${code}`); toast(ok ? `Lien de lecture copié : /${code}` : 'Copie impossible', ok ? 'ok' : 'err'); }
  if (b.dataset.n === 'del') {
    const ok = await ask({ title: 'Supprimer la note ?', text: `Le lien /${code} ne fonctionnera plus.`, ok: 'Supprimer', danger: true });
    if (!ok) return;
    const r = await fetch(`/${code}`, { method: 'DELETE', headers: { 'x-note-key': nkeys.all()[code] } });
    if (r.ok) { delete myNotes[code]; nkeys.del(code); renderNotes(); toast('Note supprimée', 'ok'); } else toast('Suppression impossible', 'err');
  }
});

// ---------- presse-papiers partagé ----------
let clipsList = [];
const linkify = (h) => h.replace(/\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)"'»]/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
function renderClips() {
  const ul = $('#clist');
  ul.innerHTML = clipsList.map((c) => {
    const long = c.text.length > 360 || c.text.split('\n').length > 7;
    return `<li class="citem${c.fresh ? ' new' : ''}${long ? ' long' : ''}" data-id="${esc(c.id)}">
      <div class="ctext">${linkify(esc(c.text))}</div>
      ${long ? '<button class="link cmore" data-c="more">Afficher tout</button>' : ''}
      <div class="cmeta"><span><b>${esc(c.by)}</b> · ${fmtDate(c.t)} · ${c.text.length.toLocaleString('fr-FR')} car.</span>
        <span class="cbtns"><button class="btn outline sm" data-c="note" title="En faire une note partageable par lien">${I.share}<span>Note</span></button><button class="btn outline sm" data-c="copy">${I.copy}<span>Copier</span></button>
        <button class="ib del" data-c="del" title="Supprimer" aria-label="Supprimer">${I.del}</button></span></div></li>`;
  }).join('');
  for (const c of clipsList) c.fresh = false;
  $('#clipEmpty').hidden = clipsList.length > 0;
  $('#clearClips').hidden = clipsList.length === 0;
  renderCounts();
}
async function sendClip(text) {
  if (!text.trim()) return false;
  try { await api('POST', '/api/clips', { text }); return true; } catch (e) { toast(e.message, 'err'); return false; }
}
$('#clipForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const ta = $('#clipText');
  if (await sendClip(ta.value)) { ta.value = ''; autoGrow(ta); toast('Partagé sur tous les appareils', 'ok'); }
});
$('#clipText').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); $('#clipForm').requestSubmit(); }
});
function autoGrow(ta) { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`; }
$('#clipText').addEventListener('input', (e) => autoGrow(e.target));
$('#clipPaste').addEventListener('click', async () => {
  try {
    const t = await navigator.clipboard.readText();
    if (!t) { toast('Le presse-papiers est vide'); return; }
    if (await sendClip(t)) toast('Collé et partagé', 'ok');
  } catch {
    $('#clipText').focus();
    toast('Accès refusé par le navigateur : utilisez Ctrl+V dans la zone de texte', 'err');
  }
});
$('#clist').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-c]');
  if (!b) return;
  const li = b.closest('li');
  const c = clipsList.find((x) => x.id === li.dataset.id);
  if (!c) return;
  if (b.dataset.c === 'more') { li.classList.toggle('open'); b.textContent = li.classList.contains('open') ? 'Réduire' : 'Afficher tout'; }
  if (b.dataset.c === 'note') {
    try {
      const n = await createNote({ text: c.text });
      const ok = await copyText(`${linkBase()}/${n.code}`);
      toast(`Note /${n.code} créée${ok ? ' — lien copié' : ''}`, 'ok');
    } catch (err) { toast(err.message, 'err'); }
    return;
  }
  if (b.dataset.c === 'copy') {
    const ok = await copyText(c.text);
    const s = b.querySelector('span');
    s.textContent = ok ? 'Copié ✓' : 'Échec';
    b.classList.toggle('done', ok);
    setTimeout(() => { s.textContent = 'Copier'; b.classList.remove('done'); }, 1500);
  }
  if (b.dataset.c === 'del') api('DELETE', `/api/clips/${c.id}`).catch((err) => toast(err.message, 'err'));
});
$('#clearClips').addEventListener('click', async () => {
  const ok = await ask({ title: 'Vider le presse-papiers ?', text: 'Tous les textes partagés seront effacés pour tous les appareils.', ok: 'Tout effacer', danger: true });
  if (ok) api('DELETE', '/api/clips').catch((err) => toast(err.message, 'err'));
});

// coller n'importe où : fichiers → envoi, texte → presse-papiers partagé
document.addEventListener('paste', (e) => {
  const t = e.target;
  if (/^(INPUT|TEXTAREA)$/.test(t.tagName) || t.isContentEditable || document.querySelector('dialog[open]')) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) {
    e.preventDefault();
    const d = new Date();
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}`;
    enqueue(files.map((f, i) => {
      const generic = /^image\.\w+$/i.test(f.name) || !f.name;
      const ext = (f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg');
      return { file: f, rel: generic ? `Capture ${stamp}${files.length > 1 ? ` (${i + 1})` : ''}.${ext}` : f.name };
    }));
    return;
  }
  const text = e.clipboardData?.getData('text');
  if (text && text.trim()) {
    e.preventDefault();
    sendClip(text).then((ok) => { if (ok) { setTab('clips'); toast('Ajouté au presse-papiers partagé', 'ok'); } });
  }
});

// ---------- visionneuse ----------
let vList = [];
let vIdx = 0;
const viewer = $('#viewer');
function openViewer(e) {
  vList = visible.filter((x) => !x.dir && kindOf(x.name));
  vIdx = Math.max(0, vList.indexOf(e));
  viewer.hidden = false;
  document.body.classList.add('noscroll');
  showViewer();
}
function closeViewer() {
  viewer.hidden = true;
  $('#vStage').innerHTML = '';
  document.body.classList.remove('noscroll');
}
async function showViewer() {
  const e = vList[vIdx];
  if (!e) return closeViewer();
  const rel = join(cwd, e.name);
  const src = fileUrl(rel, true);
  const k = kindOf(e.name);
  $('#vName').textContent = e.name;
  $('#vMeta').textContent = `${vList.length > 1 ? `${vIdx + 1} sur ${vList.length} · ` : ''}${fmtSize(e.size)} · ${fmtDate(e.mtime)}`;
  $('#vDl').href = fileUrl(rel);
  $('#vPrev').hidden = $('#vNext').hidden = vList.length < 2;
  const stage = $('#vStage');
  stage.dataset.kind = k;
  if (k === 'image') stage.innerHTML = `<img src="${esc(src)}" alt="${esc(e.name)}">`;
  else if (k === 'video') stage.innerHTML = `<video src="${esc(src)}" controls autoplay playsinline></video>`;
  else if (k === 'audio') stage.innerHTML = `<div class="v-audio"><span class="ico aud xl">${esc(extOf(e.name))}</span><strong>${esc(e.name)}</strong><audio src="${esc(src)}" controls autoplay></audio></div>`;
  else if (k === 'pdf') stage.innerHTML = `<iframe src="${esc(src)}" title="${esc(e.name)}"></iframe>`;
  else if (k === 'text') {
    stage.innerHTML = '<pre class="v-text">Chargement…</pre>';
    try {
      const r = await fetch(src, { headers: { range: 'bytes=0-1048575' } });
      const txt = await r.text();
      if (vList[vIdx] !== e) return;
      stage.querySelector('pre').textContent = txt + (e.size > 1048576 ? '\n\n… (aperçu limité au premier Mo, téléchargez le fichier pour tout voir)' : '');
    } catch { stage.querySelector('pre').textContent = 'Impossible de charger le texte.'; }
  }
  const media = stage.querySelector('img, video, audio');
  if (media) {
    media.addEventListener('error', () => {
      stage.innerHTML = `<div class="v-err"><strong>Aperçu impossible</strong><span>Ce format n'est pas lu par le navigateur.</span><a class="btn primary" href="${esc(fileUrl(rel))}" download>Télécharger</a></div>`;
    }, { once: true });
  }
  // précharge les images voisines
  for (const d of [-1, 1]) {
    const n = vList[(vIdx + d + vList.length) % vList.length];
    if (n && kindOf(n.name) === 'image') new Image().src = fileUrl(join(cwd, n.name), true);
  }
}
const vStep = (d) => { if (vList.length > 1) { vIdx = (vIdx + d + vList.length) % vList.length; showViewer(); } };
$('#vClose').addEventListener('click', closeViewer);
$('#vPrev').addEventListener('click', () => vStep(-1));
$('#vNext').addEventListener('click', () => vStep(1));
$('#vShare').addEventListener('click', () => { const e = vList[vIdx]; if (e) openShare([join(cwd, e.name)]); });
$('#vStage').addEventListener('click', (e) => { if (e.target.id === 'vStage') closeViewer(); });
document.addEventListener('keydown', (e) => {
  if (viewer.hidden || document.querySelector('dialog[open]')) return;
  if (e.key === 'Escape') closeViewer();
  if (e.key === 'ArrowLeft') vStep(-1);
  if (e.key === 'ArrowRight') vStep(1);
});
let touchX = null;
viewer.addEventListener('touchstart', (e) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
viewer.addEventListener('touchend', (e) => {
  if (touchX === null || $('#vStage').dataset.kind !== 'image') return;
  const dx = e.changedTouches[0].clientX - touchX;
  if (Math.abs(dx) > 60) vStep(dx < 0 ? 1 : -1);
  touchX = null;
});

// ---------- démarrage ----------
$('#host').textContent = location.host;
setWho();
setTab(tab);
connect();
loadMyNotes();
load();
// rafraîchit les dates relatives
setInterval(() => { if (!document.hidden) { renderList(); renderClips(); renderShares(); } }, 60000);
