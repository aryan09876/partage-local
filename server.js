'use strict';
// Partage de fichiers local — zéro dépendance (Node >= 20)
// Uploads en morceaux parallèles + reprise, téléchargements Range, temps réel via SSE.

const http = require('node:http');
const http2 = require('node:http2');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const { execFile } = require('node:child_process');
const zlib = require('node:zlib');

// Configuration : variables d'environnement, complétées par partage.env (écrit par « partage install »)
(function loadEnvFile() {
  const f = process.env.PARTAGE_CONFIG || path.join(__dirname, 'partage.env');
  let txt;
  try { txt = fs.readFileSync(f, 'utf8'); } catch { return; }
  for (const line of txt.split(/\r?\n/)) {
    const m = /^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
})();
// Journal dans un fichier (utile sous Windows, où le service n'a pas de console)
if (process.env.LOG_FILE) {
  const out = fs.createWriteStream(process.env.LOG_FILE, { flags: 'a' });
  const stamp = () => new Date().toISOString();
  for (const k of ['log', 'warn', 'error']) {
    const orig = console[k].bind(console);
    console[k] = (...a) => { out.write(`${stamp()} ${a.map((x) => (typeof x === 'string' ? x : require('node:util').inspect(x))).join(' ')}\n`); orig(...a); };
  }
}
const VERSION = '2.0.0';
const PORT = Number(process.env.PORT) || 4892;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = path.resolve(process.env.SHARE_DIR || path.join(__dirname, 'storage'));
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const AUTH_FILE = path.resolve(process.env.AUTH_FILE || path.join(__dirname, 'auth.json'));
const CERT_DIR = path.resolve(process.env.CERT_DIR || path.join(__dirname, 'certs'));
const HTTPS_MODE = (process.env.HTTPS || 'auto').toLowerCase(); // auto (si certificats présents) | off
const PUBLIC_URL_ENV = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const CODE_LEN = Math.min(12, Math.max(4, Number(process.env.SHORT_CODE_LENGTH) || 4));
const TRUST_PROXY = process.env.TRUST_PROXY !== 'off'; // X-Forwarded-For accepté seulement depuis 127.0.0.1
const TMP_NAME = '.partial';
const TMP = path.join(ROOT, TMP_NAME);
const PUBLIC = path.join(__dirname, 'public');
const CHUNK = (Number(process.env.CHUNK_MB) || 16) * 1024 * 1024;
const STALE_MS = 3 * 24 * 3600 * 1000; // uploads abandonnés supprimés après 3 jours
const HWM = 1 << 20; // tampons de 1 Mo pour le débit

// ---------- utilitaires ----------
class HttpError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// Sous Windows, certains caractères et noms sont interdits (et « C: » désignerait un disque) : on refuse.
const WIN = process.platform === 'win32';
const WIN_BAD = /[<>:"|?*\x00-\x1f]|[. ]$|^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;
// Rend un nouveau nom compatible Windows (les noms existants, eux, sont vérifiés par cleanRel)
const winSafe = (rel) => (!WIN ? rel : String(rel).replace(/\\/g, '/').split('/').map((seg) => {
  let x = seg.replace(/[<>:"|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(x)) x = `_${x}`;
  return x;
}).join('/'));
function cleanRel(p = '') {
  const parts = String(p).replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  for (const s of parts) {
    if (s === '..' || s.includes('\0') || s.length > 255) throw new HttpError(400, 'Chemin invalide');
    if (WIN && WIN_BAD.test(s)) throw new HttpError(400, `Nom non autorisé sous Windows : ${s}`);
  }
  if (parts[0] === TMP_NAME) throw new HttpError(403, 'Chemin interdit');
  return parts.join('/');
}

const abs = (rel) => path.join(ROOT, rel);

async function readJson(req, limit = 1 << 16) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > limit) throw new HttpError(413, 'Requête trop grande');
  }
  try { return s ? JSON.parse(s) : {}; } catch { throw new HttpError(400, 'JSON invalide'); }
}

function ipOf(req) {
  const raw = (req.socket.remoteAddress || '?').replace(/^::ffff:/, '');
  // derrière Tailscale Funnel/Serve (proxy local), la vraie IP est dans X-Forwarded-For
  const xff = req.headers['x-forwarded-for'];
  if (TRUST_PROXY && xff && (raw === '127.0.0.1' || raw === '::1')) return String(xff).split(',')[0].trim() || raw;
  return raw;
}

function userOf(req, url) {
  let u = req.headers['x-user'] || url.searchParams.get('u') || '';
  try { u = decodeURIComponent(u); } catch { u = ''; }
  u = u.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 40);
  return u || ipOf(req);
}

async function exists(p) {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function uniquePath(p) {
  if (!(await exists(p))) return p;
  const dir = path.dirname(p);
  const ext = path.extname(p);
  const base = path.basename(p, ext);
  for (let i = 1; ; i++) {
    const c = path.join(dir, `${base} (${i})${ext}`);
    if (!(await exists(c))) return c;
  }
}

function fmtSize(b) {
  const u = ['o', 'Ko', 'Mo', 'Go', 'To'];
  let i = 0;
  while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(i ? 1 : 0).replace('.', ',')} ${u[i]}`;
}

const MIME = {
  html: 'text/html', htm: 'text/html', css: 'text/css', js: 'text/javascript', mjs: 'text/javascript',
  json: 'application/json', txt: 'text/plain', md: 'text/plain', log: 'text/plain', csv: 'text/csv',
  xml: 'application/xml', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', bmp: 'image/bmp',
  mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime', avi: 'video/x-msvideo',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', opus: 'audio/opus',
  pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', iso: 'application/x-iso9660-image',
};
const TEXTLIKE = new Set(['html', 'htm', 'js', 'mjs', 'css', 'json', 'txt', 'md', 'log', 'csv', 'xml', 'svg',
  'py', 'sh', 'yml', 'yaml', 'ini', 'conf', 'ts', 'c', 'h', 'cpp', 'java', 'go', 'rs', 'sql']);

function mimeOf(name, inline) {
  const ext = path.extname(name).slice(1).toLowerCase();
  // En affichage inline, le HTML/SVG/JS est servi en texte brut (pas d'exécution sur l'origine).
  if (inline && TEXTLIKE.has(ext)) return 'text/plain; charset=utf-8';
  const m = MIME[ext] || 'application/octet-stream';
  return m.startsWith('text/') ? `${m}; charset=utf-8` : m;
}

// ---------- temps réel (SSE) ----------
const clients = new Set();
const activity = [];
const ACTIVITY_FILE = path.join(DATA_DIR, 'activity.json');
let activityTimer = null;
function saveActivitySoon() {
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    fsp.writeFile(ACTIVITY_FILE + '.tmp', JSON.stringify(activity))
      .then(() => fsp.rename(ACTIVITY_FILE + '.tmp', ACTIVITY_FILE)).catch(() => {});
  }, 1000);
}
async function loadActivity() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try { activity.push(...JSON.parse(await fsp.readFile(ACTIVITY_FILE, 'utf8')).slice(-200)); } catch { /* aucun historique */ }
}

function broadcast(ev) {
  const s = `data: ${JSON.stringify(ev)}\n\n`;
  for (const c of clients) c.res.write(s);
}

function presence() {
  const users = [...new Set([...clients].map((c) => c.user))];
  return { type: 'presence', users, count: clients.size };
}

function log(user, kind, text) {
  const item = { t: Date.now(), user, kind, text };
  activity.push(item);
  if (activity.length > 200) activity.shift();
  saveActivitySoon();
  broadcast({ type: 'activity', item });
}

let statsTimer = null;
async function getStats() {
  try {
    const s = await fsp.statfs(ROOT);
    return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
  } catch { return null; }
}
function changed(dirs) {
  broadcast({ type: 'change', dirs });
  clearTimeout(statsTimer);
  statsTimer = setTimeout(async () => broadcast({ type: 'stats', stats: await getStats() }), 300);
}

// ---------- uploads (morceaux, reprise) ----------
const uploads = new Map();

function chunkLen(u, i) { return Math.min(u.chunk, u.size - i * u.chunk); }
function nChunks(u) { return Math.ceil(u.size / u.chunk); }
function received(u) {
  let b = u.live;
  for (const i of u.done) b += chunkLen(u, i);
  return Math.min(b, u.size);
}
function pubUpload(u) {
  const stalled = Date.now() - Math.max(u.touched || 0, u.updatedAt || 0) > 20000;
  return { id: u.id, name: u.name, dir: u.dir, size: u.size, received: received(u), user: u.user, tab: u.tab, startedAt: u.startedAt, stalled };
}

function progress(u, force) {
  const now = Date.now();
  if (!force && now - u.lastBroadcast < 300) return;
  u.lastBroadcast = now;
  broadcast({ type: 'progress', upload: pubUpload(u) });
}

function scheduleSave(u) {
  if (u.saveTimer) return;
  u.saveTimer = setTimeout(() => { u.saveTimer = null; saveMeta(u).catch(() => {}); }, 500);
}
async function saveMeta(u) {
  const meta = {
    id: u.id, dir: u.dir, name: u.name, size: u.size, chunk: u.chunk, lastModified: u.lastModified,
    user: u.user, startedAt: u.startedAt, updatedAt: u.updatedAt, done: [...u.done],
  };
  const f = path.join(TMP, `${u.id}.json`);
  await fsp.writeFile(f + '.tmp', JSON.stringify(meta));
  await fsp.rename(f + '.tmp', f);
}

async function dropUpload(u) {
  uploads.delete(u.id);
  clearTimeout(u.saveTimer);
  await fsp.rm(u.tmp, { force: true });
  await fsp.rm(path.join(TMP, `${u.id}.json`), { force: true });
}

async function loadMetas() {
  await fsp.mkdir(TMP, { recursive: true });
  for (const f of await fsp.readdir(TMP)) {
    if (!f.endsWith('.json')) continue;
    try {
      const m = JSON.parse(await fsp.readFile(path.join(TMP, f), 'utf8'));
      const tmp = path.join(TMP, `${m.id}.part`);
      if (!(await exists(tmp))) { await fsp.rm(path.join(TMP, f), { force: true }); continue; }
      uploads.set(m.id, { ...m, tmp, done: new Set(m.done), live: 0, lastBroadcast: 0, tab: null });
    } catch { /* méta corrompue : ignorée */ }
  }
}

async function handleInit(req, res, url) {
  const b = await readJson(req);
  const dir = cleanRel(b.dir);
  const name = cleanRel(winSafe(b.name));
  const size = Number(b.size);
  if (!name) throw new HttpError(400, 'Nom manquant');
  if (!Number.isSafeInteger(size) || size < 0) throw new HttpError(400, 'Taille invalide');
  const lastModified = Number(b.lastModified) || 0;
  const user = userOf(req, url);
  const id = crypto.createHash('sha256').update(`${dir}\n${name}\n${size}\n${lastModified}`).digest('hex').slice(0, 32);

  let u = uploads.get(id);
  const resumed = !!u;
  if (!u) {
    const st = await getStats();
    if (st && st.free < size) throw new HttpError(507, `Espace disque insuffisant (${fmtSize(st.free)} libres)`);
    u = {
      id, dir, name, size, chunk: CHUNK, lastModified, user, startedAt: Date.now(), updatedAt: Date.now(),
      tmp: path.join(TMP, `${id}.part`), done: new Set(), live: 0, lastBroadcast: 0,
    };
    const fh = await fsp.open(u.tmp, 'w');
    try { await fh.truncate(size); } finally { await fh.close(); }
    uploads.set(id, u);
    await saveMeta(u);
    log(user, 'upload-start', `commence l'envoi de ${name} (${fmtSize(size)})`);
  }
  u.user = user;
  u.tab = req.headers['x-tab'] || null;
  u.updatedAt = Date.now();
  progress(u, true);
  sendJson(res, 200, { id, chunkSize: u.chunk, done: [...u.done], resumed });
}

async function handleChunk(req, res, u, idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= nChunks(u)) throw new HttpError(400, 'Index de morceau invalide');
  const start = idx * u.chunk;
  const len = chunkLen(u, idx);
  // Content-Length est facultatif en HTTP/2 (Safari ne l'envoie pas) : on compte nous-mêmes.
  const cl = req.headers['content-length'];
  if (cl !== undefined && Number(cl) !== len) throw new HttpError(400, `Taille de morceau inattendue (${cl} au lieu de ${len})`);
  let got = 0;
  const limiter = new Transform({
    transform(c, _enc, cb) {
      got += c.length;
      if (got > len) return cb(new HttpError(413, 'Morceau trop grand'));
      u.live += c.length;
      u.touched = Date.now();
      progress(u);
      cb(null, c);
    },
  });
  const ws = fs.createWriteStream(u.tmp, { flags: 'r+', start, highWaterMark: HWM });
  try {
    await pipeline(req, limiter, ws);
  } finally {
    u.live -= Math.min(got, len);
  }
  if (ws.bytesWritten !== len) throw new HttpError(400, 'Morceau incomplet');
  u.done.add(idx);
  u.updatedAt = Date.now();
  scheduleSave(u);
  progress(u);
  sendJson(res, 200, { ok: true });
}

async function handleComplete(req, res, u) {
  const n = nChunks(u);
  if (u.done.size !== n) {
    const missing = [];
    for (let i = 0; i < n; i++) if (!u.done.has(i)) missing.push(i);
    return sendJson(res, 409, { error: 'Morceaux manquants', missing });
  }
  if (u.completing) throw new HttpError(409, 'Finalisation déjà en cours');
  u.completing = true;
  try {
    clearTimeout(u.saveTimer);
    const target = abs(cleanRel(path.posix.join(u.dir, u.name)));
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const final = await uniquePath(target);
    await fsp.rename(u.tmp, final);
    if (u.lastModified) {
      const t = new Date(u.lastModified);
      await fsp.utimes(final, t, t).catch(() => {});
    }
    uploads.delete(u.id);
    await fsp.rm(path.join(TMP, `${u.id}.json`), { force: true });
    const rel = path.relative(ROOT, final).split(path.sep).join('/');
    const secs = Math.max(0.001, (Date.now() - u.startedAt) / 1000);
    broadcast({ type: 'upload-done', id: u.id, path: rel });
    log(u.user, 'upload', `a envoyé ${rel} (${fmtSize(u.size)})`);
    changed([path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel), u.dir]);
    sendJson(res, 200, { ok: true, path: rel, name: path.basename(final), seconds: secs });
  } catch (e) {
    u.completing = false;
    throw e;
  }
}

// ---------- fichiers ----------
async function handleList(res, url) {
  const rel = cleanRel(url.searchParams.get('path') ?? '');
  const dir = abs(rel);
  let items;
  try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new HttpError(404, 'Dossier introuvable');
    throw e;
  }
  const entries = (await Promise.all(items.map(async (d) => {
    if (!rel && d.name === TMP_NAME) return null;
    try {
      const st = await fsp.stat(path.join(dir, d.name));
      return { name: d.name, dir: st.isDirectory(), size: st.isDirectory() ? 0 : st.size, mtime: st.mtimeMs };
    } catch { return null; }
  }))).filter(Boolean);
  sendJson(res, 200, { path: rel, entries });
}

function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${type}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

const dirOf = (r) => (path.posix.dirname(r) === '.' ? '' : path.posix.dirname(r));

// Sert un fichier avec Range/ETag. onStart() est appelé au début d'une lecture complète.
async function serveFile(req, res, rel, { inline = false, onStart = null } = {}) {
  const p = abs(rel);
  let st;
  try { st = await fsp.stat(p); } catch { throw new HttpError(404, 'Fichier introuvable'); }
  if (st.isDirectory()) throw new HttpError(400, 'Impossible de télécharger un dossier');
  const name = path.basename(p);
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const headers = {
    'accept-ranges': 'bytes',
    'etag': etag,
    'last-modified': st.mtime.toUTCString(),
    'content-type': mimeOf(name, inline),
    'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', name),
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }

  let start = 0;
  let end = st.size - 1;
  let status = 200;
  const range = req.headers.range;
  if (range && st.size > 0) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (m && (m[1] || m[2])) {
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2]) end = Math.min(Number(m[2]), st.size - 1); }
      if (start > end || start >= st.size) {
        res.writeHead(416, { 'content-range': `bytes */${st.size}` });
        return res.end();
      }
      status = 206;
      headers['content-range'] = `bytes ${start}-${end}/${st.size}`;
    }
  }
  headers['content-length'] = st.size === 0 ? 0 : end - start + 1;
  res.writeHead(status, headers);
  if (req.method === 'HEAD') return res.end();
  if (start === 0 && onStart) onStart(st);
  if (st.size === 0) return res.end();
  const rs = fs.createReadStream(p, { start, end, highWaterMark: HWM });
  pipeline(rs, res).catch(() => {});
}

async function handleDownload(req, res, url, rel) {
  rel = cleanRel(rel);
  const inline = url.searchParams.has('inline');
  // les vignettes (?thumb) ne polluent pas le journal d'activité
  const quiet = url.searchParams.has('thumb');
  return serveFile(req, res, rel, {
    inline,
    onStart: quiet ? null : (st) => log(userOf(req, url), 'download', `${inline ? 'ouvre' : 'télécharge'} ${rel} (${fmtSize(st.size)})`),
  });
}

async function handleMkdir(req, res, url) {
  const b = await readJson(req);
  const rel = cleanRel(winSafe(b.path));
  if (!rel) throw new HttpError(400, 'Nom manquant');
  if (await exists(abs(rel))) throw new HttpError(409, 'Existe déjà');
  await fsp.mkdir(abs(rel), { recursive: true });
  log(userOf(req, url), 'mkdir', `a créé le dossier ${rel}`);
  changed([dirOf(rel)]);
  sendJson(res, 200, { ok: true });
}

async function removeItems(rels) {
  const done = [];
  for (const rel of rels) {
    if (!rel) continue;
    if (!(await exists(abs(rel)))) continue;
    await fsp.rm(abs(rel), { recursive: true, force: true });
    done.push(rel);
  }
  if (done.length) dropSharesUnder(done);
  return done;
}

async function handleDelete(req, res, url) {
  const rel = cleanRel(url.searchParams.get('path') ?? '');
  if (!rel) throw new HttpError(400, 'Impossible de supprimer la racine');
  if (!(await exists(abs(rel)))) throw new HttpError(404, 'Introuvable');
  await removeItems([rel]);
  log(userOf(req, url), 'delete', `a supprimé ${rel}`);
  changed([dirOf(rel)]);
  sendJson(res, 200, { ok: true });
}

async function handleBatchDelete(req, res, url) {
  const b = await readJson(req, 1 << 20);
  if (!Array.isArray(b.paths) || !b.paths.length) throw new HttpError(400, 'Aucun élément');
  const rels = [...new Set(b.paths.map((x) => cleanRel(x)).filter(Boolean))];
  const done = await removeItems(rels);
  const u = userOf(req, url);
  if (done.length === 1) log(u, 'delete', `a supprimé ${done[0]}`);
  else if (done.length) log(u, 'delete', `a supprimé ${done.length} éléments dans /${dirOf(done[0])}`);
  changed([...new Set(done.map(dirOf))]);
  sendJson(res, 200, { ok: true, deleted: done.length });
}

async function handleRename(req, res, url) {
  const b = await readJson(req);
  const from = cleanRel(b.from);
  const to = cleanRel(winSafe(b.to));
  if (!from || !to) throw new HttpError(400, 'Chemin manquant');
  if (!(await exists(abs(from)))) throw new HttpError(404, 'Introuvable');
  if (await exists(abs(to))) throw new HttpError(409, 'Un élément porte déjà ce nom');
  await fsp.mkdir(path.dirname(abs(to)), { recursive: true });
  await fsp.rename(abs(from), abs(to));
  moveShares(from, to);
  log(userOf(req, url), 'rename', `a renommé ${from} → ${to}`);
  changed([dirOf(from), dirOf(to)]);
  sendJson(res, 200, { ok: true });
}

// ---------- stockage JSON (liens publics, presse-papiers) ----------
function jsonStore(name, fallback) {
  const file = path.join(DATA_DIR, name);
  return {
    data: fallback,
    timer: null,
    async load() { try { this.data = JSON.parse(await fsp.readFile(file, 'utf8')); } catch { /* vide */ } },
    save() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush().catch(() => {}), 400); },
    async flush() {
      clearTimeout(this.timer);
      await fsp.writeFile(`${file}.tmp`, JSON.stringify(this.data), { mode: 0o600 });
      await fsp.rename(`${file}.tmp`, file);
    },
  };
}
const shares = jsonStore('shares.json', []);
const clips = jsonStore('clips.json', []);
const notes = jsonStore('notes.json', []);
const usedCodes = jsonStore('codes.json', []); // codes courts déjà attribués : jamais réutilisés

// ---------- codes courts (liens publics https://serveur/AB3K) ----------
// Alphabet sans caractères ambigus (ni 0/O ni 1/I/L) ; insensible à la casse.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{4,12}$`);
function newCode() {
  const used = new Set(usedCodes.data);
  for (let i = 0; i < 20000; i++) {
    let c = '';
    for (let j = 0; j < CODE_LEN; j++) c += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!used.has(c)) { usedCodes.data.push(c); usedCodes.save(); return c; }
  }
  throw new HttpError(507, 'Plus de code court disponible : augmentez SHORT_CODE_LENGTH');
}
const findByCode = (code) => shares.data.find((x) => x.code === code) || notes.data.find((x) => x.code === code) || null;

// Anti-énumération : une IP qui tente trop de codes inexistants est bloquée 15 min.
const probes = new Map();
function probeGuard(ip) {
  const now = Date.now();
  let p = probes.get(ip);
  if (!p || p.reset < now) { p = { n: 0, reset: now + 600e3, until: 0 }; probes.set(ip, p); }
  if (p.until > now) throw new HttpError(429, 'Trop de liens invalides essayés depuis votre adresse. Réessayez dans quelques minutes.');
  return p;
}
function probeMiss(ip) {
  const p = probeGuard(ip);
  if (++p.n >= 20) p.until = Date.now() + 15 * 60e3;
}

// Mot de passe optionnel par lien / note (empreinte scrypt) et jeton de déverrouillage (cookie)
let linkSecret = null;
async function loadLinkSecret() {
  const f = path.join(DATA_DIR, 'secret');
  try { linkSecret = (await fsp.readFile(f, 'utf8')).trim(); } catch { /* absent */ }
  if (!linkSecret) { linkSecret = crypto.randomBytes(32).toString('hex'); await fsp.writeFile(f, linkSecret, { mode: 0o600 }); }
}
async function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: (await scrypt(String(pw), salt)).toString('hex') };
}
async function pwOk(obj, pw) {
  if (!obj.pw) return true;
  const k = await scrypt(String(pw || ''), obj.pw.salt);
  return crypto.timingSafeEqual(k, Buffer.from(obj.pw.hash, 'hex'));
}
const unlockToken = (obj) => crypto.createHmac('sha256', linkSecret).update(`${obj.code}:${obj.pw.hash}`).digest('base64url');
function isUnlocked(req, obj) {
  if (!obj.pw) return true;
  if (isAuthed(req) && auth) return true; // les utilisateurs connectés à Partage passent
  const c = readCookie(req, `u_${obj.code}`);
  if (!c) return false;
  const want = Buffer.from(unlockToken(obj));
  const got = Buffer.from(c);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}
const pwFails = new Map();
async function handleUnlock(req, res, obj) {
  const ip = ipOf(req);
  const a = pwFails.get(`${ip}:${obj.code}`) || { fails: 0, until: 0 };
  if (a.until > Date.now()) throw new HttpError(429, `Trop d'essais. Réessayez dans ${Math.ceil((a.until - Date.now()) / 1000)} s.`);
  const b = await readJson(req, 4096);
  const key = req.headers['x-note-key'];
  const ok = (obj.keyHash && key && noteKeyOk(obj, key)) || (obj.pw && await pwOk(obj, b.password));
  if (!ok) {
    a.fails++;
    if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (a.fails - 5));
    pwFails.set(`${ip}:${obj.code}`, a);
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, 'Mot de passe incorrect.');
  }
  pwFails.delete(`${ip}:${obj.code}`);
  if (obj.pw) res.setHeader('set-cookie', `u_${obj.code}=${unlockToken(obj)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=43200${secure(req)}`);
  sendJson(res, 200, { ok: true });
}

// ---------- liens de partage publics ----------
function shareState(s) {
  if (s.expiresAt && s.expiresAt <= Date.now()) return 'expired';
  if (s.maxDownloads && s.downloads >= s.maxDownloads) return 'exhausted';
  return 'active';
}
// jamais l'empreinte du mot de passe côté client
const pubShare = ({ pw, ...s }) => ({ ...s, locked: !!pw, state: shareState({ ...s }) });
const sharesChanged = () => { shares.save(); broadcast({ type: 'shares', shares: shares.data.map(pubShare) }); };

// Un élément supprimé disparaît des liens qui le contiennent ; un lien vide est supprimé.
function dropSharesUnder(rels) {
  const hit = (x) => rels.some((r) => x === r || x.startsWith(`${r}/`));
  let changed = false;
  shares.data = shares.data.filter((s) => {
    const keep = s.paths.filter((x) => !hit(x));
    if (keep.length !== s.paths.length) { changed = true; s.paths = keep; s.path = keep[0]; s.count = keep.length; }
    return keep.length > 0;
  });
  if (changed) sharesChanged();
}
function moveShares(from, to) {
  let n = 0;
  for (const s of shares.data) {
    s.paths = s.paths.map((x) => {
      if (x === from) { n++; return to; }
      if (x.startsWith(`${from}/`)) { n++; return to + x.slice(from.length); }
      return x;
    });
    s.path = s.paths[0];
  }
  if (n) sharesChanged();
}
function migrateShares() {
  let n = 0;
  for (const s of shares.data) {
    if (!s.paths) { s.paths = [s.path]; n++; }
    if (!s.code) { s.code = newCode(); n++; }
    if (s.count == null) { s.count = s.paths.length; n++; }
  }
  if (n) shares.save();
}

async function handleShareCreate(req, res, url) {
  const b = await readJson(req, 1 << 20);
  const list = Array.isArray(b.paths) ? b.paths : [b.path];
  const rels = [...new Set(list.map((x) => cleanRel(x)))];
  if (!rels.length || rels.some((r) => !r)) throw new HttpError(400, 'Impossible de partager la racine');
  if (rels.length > 500) throw new HttpError(413, '500 éléments maximum par lien');
  const stats = [];
  for (const rel of rels) {
    try { stats.push(await fsp.stat(abs(rel))); } catch { throw new HttpError(404, `Introuvable : ${rel}`); }
  }
  const ttl = Number(b.expiresIn) || 0;
  const max = Math.floor(Number(b.maxDownloads) || 0);
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const single = rels.length === 1;
  const s = {
    id: crypto.randomBytes(16).toString('base64url'),
    code: newCode(),
    paths: rels, path: rels[0], count: rels.length,
    title: String(b.title || '').trim().slice(0, 120) || null,
    dir: single && stats[0].isDirectory(), size: single && !stats[0].isDirectory() ? stats[0].size : null,
    by: userOf(req, url), createdAt: Date.now(),
    expiresAt: ttl > 0 ? Date.now() + Math.min(ttl, 366 * 86400) * 1000 : null,
    maxDownloads: max > 0 ? Math.min(max, 100000) : null,
    downloads: 0,
    pw: password ? await hashPw(password) : null,
  };
  shares.data.unshift(s);
  sharesChanged();
  log(s.by, 'share', `a créé le lien /${s.code} pour ${single ? rels[0] : `${rels.length} éléments`}${s.pw ? ' (protégé par mot de passe)' : ''}`);
  sendJson(res, 200, { share: pubShare(s) });
}

// Ajoute, change ou retire le mot de passe d'un lien existant
async function handleSharePassword(req, res, url, id) {
  const s = shares.data.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'Lien introuvable');
  const b = await readJson(req, 4096);
  const pw = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  s.pw = pw ? await hashPw(pw) : null;
  sharesChanged();
  log(userOf(req, url), 'share', `${s.pw ? 'a protégé' : 'a retiré le mot de passe de'} le lien /${s.code}`);
  sendJson(res, 200, { share: pubShare(s) });
}

async function handleShareDelete(req, res, url, id) {
  const s = shares.data.find((x) => x.id === id);
  if (!s) throw new HttpError(404, 'Lien introuvable');
  shares.data = shares.data.filter((x) => x.id !== id);
  sharesChanged();
  log(userOf(req, url), 'unshare', `a désactivé le lien /${s.code}`);
  sendJson(res, 200, { ok: true });
}

const PREVIEWABLE = /\.(jpe?g|png|gif|webp|avif|bmp|svg|mp4|webm|mov|m4v|mp3|wav|ogg|flac|m4a|opus|aac|pdf|txt|md|log|csv|json)$/i;

async function sharePage(res, code, { title, body, cls = '' }) {
  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="color-scheme" content="light dark">
<title>${esc(title)}</title><link rel="stylesheet" href="/style.css">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7.5' fill='%23007aff'/%3E%3Cpath d='M11 22V10m0 0-4 4m4-4 4 4M21 10v12m0 0-4-4m4 4 4-4' stroke='white' stroke-width='2.4' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E">
</head><body class="share-page ${cls}"><main class="sp">${body}</main></body></html>`;
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex',
    'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
  });
  res.end(html);
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGO = '<span class="logo" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M11 22V10m0 0-4 4m4-4 4 4M21 10v12m0 0-4-4m4 4 4-4"/></svg></span>';

function fmtLeft(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} jour${s >= 172800 ? 's' : ''}`;
}

const LOCK_ICON = '<span class="logo lock" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></span>';
function passwordPage(res, obj, base) {
  return sharePage(res, 401, {
    title: 'Contenu protégé · Partage',
    body: `${LOCK_ICON}<h1>Contenu protégé</h1><p class="lead">Saisissez le mot de passe donné par la personne qui a partagé ce lien.</p>
<form class="sp-form" id="unlockForm" data-unlock="${esc(base)}/unlock"><input class="input" type="password" id="unlockPw" placeholder="Mot de passe" autocomplete="off" autofocus aria-label="Mot de passe">
<button class="btn primary sp-btn" type="submit">Ouvrir</button><p class="sp-err" id="unlockErr" role="alert"></p></form><script src="/pub.js"></script>`,
  });
}
const goneMsg = {
  missing: ['Lien introuvable', 'Ce lien n\'existe pas ou a été désactivé par la personne qui l\'a partagé.'],
  expired: ['Lien expiré', 'Ce lien de partage a expiré. Demandez un nouveau lien à la personne qui vous l\'a envoyé.'],
  exhausted: ['Limite atteinte', 'Ce lien a atteint son nombre maximal de téléchargements.'],
};
function gonePage(res, state) {
  const msg = goneMsg[state];
  return sharePage(res, state === 'missing' ? 404 : 410, { title: msg[0], body: `${LOGO}<h1>${esc(msg[0])}</h1><p class="lead">${esc(msg[1])}</p>` });
}
async function shareItems(s) {
  const out = [];
  for (const rel of s.paths) {
    const st = await fsp.stat(abs(rel)).catch(() => null);
    if (st) out.push({ rel, name: path.posix.basename(rel), dir: st.isDirectory(), size: st.isDirectory() ? null : st.size });
  }
  return out;
}
const safeName = (x) => String(x).replace(/[/\\:*?"<>|\x00-\x1f]/g, '_').slice(0, 120) || 'partage';
const DL_ICON = '<svg viewBox="0 0 24 24"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>';
const DIR_SVG = '<svg viewBox="0 0 24 24"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>';

// action : null (page), 'dl' (tout), 'f' (élément idx), 'unlock'
async function handleSharePublic(req, res, url, s, action, idx, base) {
  const state = shareState(s);
  if (state !== 'active') {
    if (action) throw new HttpError(410, goneMsg[state][0]);
    return gonePage(res, state);
  }
  if (action === 'unlock') return handleUnlock(req, res, s);
  if (!isUnlocked(req, s)) {
    if (action) throw new HttpError(401, 'Mot de passe requis');
    return passwordPage(res, s, base);
  }
  const items = await shareItems(s);
  if (!items.length) {
    if (action) throw new HttpError(404, 'Fichiers introuvables');
    return sharePage(res, 404, { title: 'Fichiers introuvables', body: `${LOGO}<h1>Fichiers introuvables</h1><p class="lead">Les fichiers partagés ont été déplacés ou supprimés.</p>` });
  }
  const title = s.title || (items.length === 1 ? items[0].name : `${items.length} éléments`);
  const who = ipOf(req);
  const count = (what) => {
    s.downloads++;
    shares.save();
    broadcast({ type: 'shares', shares: shares.data.map(pubShare) });
    log(`Lien public (${who})`, 'download', `télécharge ${what} via /${s.code}${s.maxDownloads ? ` — ${s.downloads}/${s.maxDownloads}` : ''}`);
  };
  const canPreview = !s.maxDownloads; // aperçu seulement si les téléchargements sont illimités

  if (action === 'dl') {
    if (items.length === 1 && !items[0].dir) {
      const inline = url.searchParams.has('inline') && canPreview;
      return serveFile(req, res, items[0].rel, { inline, onStart: inline ? null : () => count(items[0].rel) });
    }
    if (req.method !== 'HEAD') count(items.length === 1 ? items[0].rel : `${items.length} éléments (ZIP)`);
    return sendZip(req, res, items.map((i) => i.rel), `${safeName(title)}.zip`);
  }
  if (action === 'f') {
    const it = items[idx];
    if (!it) throw new HttpError(404, 'Élément introuvable');
    if (it.dir) {
      if (req.method !== 'HEAD') count(it.rel);
      return sendZip(req, res, [it.rel], `${safeName(it.name)}.zip`);
    }
    const inline = url.searchParams.has('inline') && canPreview;
    return serveFile(req, res, it.rel, { inline, onStart: inline ? null : () => count(it.rel) });
  }

  // page du lien
  const meta = [`Partagé par ${esc(s.by)}`];
  if (s.expiresAt) meta.push(`expire dans ${fmtLeft(s.expiresAt - Date.now())}`);
  if (s.maxDownloads) {
    const left = s.maxDownloads - s.downloads;
    meta.push(`${left} téléchargement${left > 1 ? 's' : ''} restant${left > 1 ? 's' : ''}`);
  }
  if (s.pw) meta.push('protégé par mot de passe');
  const dirSize = async (rel) => (await collectZipEntries([rel])).reduce((a, e) => a + (e.dir ? 0 : e.size), 0);
  for (const it of items) if (it.dir) it.size = await dirSize(it.rel);
  const total = items.reduce((a, it) => a + (it.size || 0), 0);

  if (items.length === 1) {
    const it = items[0];
    const dl = `${base}/dl`;
    let preview = '';
    if (!it.dir && canPreview && PREVIEWABLE.test(it.name)) {
      const ext = path.extname(it.name).slice(1).toLowerCase();
      if (/^(jpe?g|png|gif|webp|avif|bmp|svg)$/.test(ext)) preview = `<img class="sp-media" src="${dl}?inline" alt="">`;
      else if (/^(mp4|webm|mov|m4v)$/.test(ext)) preview = `<video class="sp-media" src="${dl}?inline" controls playsinline preload="metadata"></video>`;
      else if (/^(mp3|wav|ogg|flac|m4a|opus|aac)$/.test(ext)) preview = `<audio class="sp-audio" src="${dl}?inline" controls preload="metadata"></audio>`;
    }
    const icon = it.dir ? `<span class="ico dir sp-ico">${DIR_SVG}</span>` : `<span class="ico sp-ico">${esc(path.extname(it.name).slice(1, 5) || '—')}</span>`;
    return sharePage(res, 200, {
      title: `${title} · Partage`,
      body: `${preview || icon}<h1 class="sp-name">${esc(title)}</h1>
<p class="lead">${it.dir ? 'Dossier · ' : ''}${esc(fmtSize(it.size || 0))}</p>
<a class="btn primary sp-btn" href="${dl}" download>${DL_ICON}${it.dir ? 'Télécharger le dossier (ZIP)' : 'Télécharger'}</a>
<p class="sp-meta">${meta.join(' · ')}</p>`,
    });
  }
  const rows = items.map((it, i) => {
    const ext = path.extname(it.name).slice(1, 5);
    const icon = it.dir ? `<span class="ico dir">${DIR_SVG}</span>` : `<span class="ico">${esc(ext || '—')}</span>`;
    const open = !it.dir && canPreview && PREVIEWABLE.test(it.name) ? `${base}/f/${i}?inline` : `${base}/f/${i}`;
    return `<li class="sp-li">${icon}<a class="sp-li-t" href="${open}"${open.endsWith('inline') ? ' target="_blank" rel="noopener"' : ' download'}><b>${esc(it.name)}</b><span>${it.dir ? 'Dossier · ' : ''}${esc(fmtSize(it.size || 0))}</span></a>
<a class="ib" href="${base}/f/${i}" download aria-label="Télécharger ${esc(it.name)}" title="Télécharger">${DL_ICON}</a></li>`;
  }).join('');
  return sharePage(res, 200, {
    title: `${title} · Partage`,
    cls: 'multi',
    body: `<span class="ico dir sp-ico">${DIR_SVG}</span><h1 class="sp-name">${esc(title)}</h1>
<p class="lead">${items.length} éléments · ${esc(fmtSize(total))}</p>
<a class="btn primary sp-btn" href="${base}/dl" download>${DL_ICON}Tout télécharger (ZIP)</a>
<ul class="sp-list">${rows}</ul>
<p class="sp-meta">${meta.join(' · ')}</p>`,
  });
}

// ---------- notes partagées (lecture publique, modification par le créateur seul) ----------
const MAX_NOTE = 200000;
const noteSubs = new Map(); // code -> Set(res) : lecteurs connectés en direct
const keyHash = (k) => crypto.createHash('sha256').update(String(k)).digest('hex');
function noteKeyOk(n, key) {
  if (!key || !n.keyHash) return false;
  const a = Buffer.from(keyHash(key));
  const b = Buffer.from(n.keyHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const pubNote = (n) => ({ code: n.code, title: n.title, text: n.text, by: n.by, createdAt: n.createdAt, updatedAt: n.updatedAt, version: n.version, locked: !!n.pw });
function noteChanged(n, deleted = false) {
  notes.save();
  const subs = noteSubs.get(n.code);
  if (subs) {
    const msg = `data: ${JSON.stringify(deleted ? { type: 'deleted' } : { type: 'update', note: pubNote(n) })}\n\n`;
    for (const r of subs) r.write(msg);
    if (deleted) { for (const r of subs) r.end(); noteSubs.delete(n.code); }
  }
  broadcast({ type: 'note', code: n.code, version: n.version, updatedAt: n.updatedAt, deleted });
}
async function handleNoteCreate(req, res, url) {
  const b = await readJson(req, MAX_NOTE * 4 + 4096);
  const text = String(b.text ?? '');
  if (text.length > MAX_NOTE) throw new HttpError(413, 'Texte trop long (200 000 caractères maximum)');
  if (notes.data.length >= 5000) throw new HttpError(507, 'Nombre maximal de notes atteint');
  const key = crypto.randomBytes(24).toString('base64url');
  const password = typeof b.password === 'string' ? b.password.slice(0, 200) : '';
  const now = Date.now();
  const n = {
    id: crypto.randomBytes(16).toString('base64url'), code: newCode(),
    title: String(b.title ?? '').trim().slice(0, 120), text,
    by: userOf(req, url), createdAt: now, updatedAt: now, version: 1,
    keyHash: keyHash(key), pw: password ? await hashPw(password) : null,
  };
  notes.data.unshift(n);
  noteChanged(n);
  log(n.by, 'note', `a créé la note /${n.code}${n.pw ? ' (protégée par mot de passe)' : ''}`);
  sendJson(res, 200, { note: pubNote(n), key });
}
async function handleNotePublic(req, res, url, n, action, base) {
  const m = req.method;
  const key = req.headers['x-note-key'];
  const owner = noteKeyOk(n, key);
  if (action === 'unlock' && m === 'POST') return handleUnlock(req, res, n);
  // modification / suppression : uniquement avec la clé d'édition du créateur
  if (!action && (m === 'PUT' || m === 'DELETE')) {
    if (!owner) { await new Promise((r) => setTimeout(r, 300)); throw new HttpError(403, 'Seule la personne qui a créé cette note peut la modifier'); }
    if (m === 'DELETE') {
      notes.data = notes.data.filter((x) => x !== n);
      noteChanged(n, true);
      log(n.by, 'note', `a supprimé la note /${n.code}`);
      return sendJson(res, 200, { ok: true });
    }
    const b = await readJson(req, MAX_NOTE * 4 + 4096);
    if (b.baseVersion != null && Number(b.baseVersion) !== n.version) return sendJson(res, 409, { error: 'La note a été modifiée ailleurs', note: pubNote(n) });
    if (b.text != null) {
      const text = String(b.text);
      if (text.length > MAX_NOTE) throw new HttpError(413, 'Texte trop long (200 000 caractères maximum)');
      n.text = text;
    }
    if (b.title != null) n.title = String(b.title).trim().slice(0, 120);
    if (b.password !== undefined) n.pw = typeof b.password === 'string' && b.password ? await hashPw(b.password.slice(0, 200)) : null;
    n.version++;
    n.updatedAt = Date.now();
    noteChanged(n);
    return sendJson(res, 200, { note: pubNote(n) });
  }
  if (m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Méthode non permise');
  const unlocked = owner || isUnlocked(req, n);
  if (!action) {
    if (!unlocked) return passwordPage(res, n, base);
    return sharePage(res, 200, {
      title: `${n.title || 'Note'} · Partage`,
      cls: 'note-page',
      body: `<div id="note" data-code="${esc(n.code)}" data-base="${esc(base)}" data-public="${esc(publicUrl || '')}"><p class="lead">Chargement…</p></div><script src="/vendor/qrcode.js"></script><script src="/pub.js"></script>`,
    });
  }
  if (!unlocked) throw new HttpError(401, 'Mot de passe requis');
  if (action === 'data') return sendJson(res, 200, { note: pubNote(n), canEdit: owner });
  if (action === 'raw') {
    const body = Buffer.from(n.text, 'utf8');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(body);
  }
  if (action === 'events') {
    const subs = noteSubs.get(n.code) || new Set();
    if (subs.size >= 200) throw new HttpError(429, 'Trop de lecteurs connectés');
    noteSubs.set(n.code, subs);
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
    res.write('retry: 3000\n\n');
    subs.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => { clearInterval(ping); subs.delete(res); });
    return undefined;
  }
  throw new HttpError(404, 'Introuvable');
}

// ---------- ZIP en streaming (sans compression, ZIP64, CRC à la volée) ----------
const MAX32 = 0xffffffff;

async function collectZipEntries(rels) {
  const out = [];
  const walk = async (absDir, zipDir) => {
    let items;
    try { items = await fsp.readdir(absDir, { withFileTypes: true }); } catch { return; }
    items.sort((a, b) => a.name.localeCompare(b.name));
    for (const d of items) {
      if (absDir === ROOT && d.name === TMP_NAME) continue;
      const a = path.join(absDir, d.name);
      let st;
      try { st = await fsp.stat(a); } catch { continue; }
      if (st.isDirectory()) {
        out.push({ name: `${zipDir}${d.name}/`, dir: true, size: 0, mtime: st.mtimeMs });
        await walk(a, `${zipDir}${d.name}/`);
      } else if (st.isFile()) {
        out.push({ name: zipDir + d.name, abs: a, dir: false, size: st.size, mtime: st.mtimeMs });
      }
    }
  };
  const seen = new Set();
  for (const rel of rels) {
    if (!rel) { await walk(ROOT, ''); continue; } // racine entière
    let st;
    try { st = await fsp.stat(abs(rel)); } catch { continue; }
    let base = path.posix.basename(rel);
    for (let i = 1; seen.has(base); i++) base = `${path.posix.basename(rel)} (${i})`;
    seen.add(base);
    if (st.isDirectory()) {
      out.push({ name: `${base}/`, dir: true, size: 0, mtime: st.mtimeMs });
      await walk(abs(rel), `${base}/`);
    } else if (st.isFile()) out.push({ name: base, abs: abs(rel), dir: false, size: st.size, mtime: st.mtimeMs });
  }
  return out;
}

function dosTime(ms) {
  const d = new Date(ms);
  const y = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function planZip(entries) {
  let off = 0;
  for (const e of entries) {
    e.nameBuf = Buffer.from(e.name, 'utf8');
    e.dos = dosTime(e.mtime);
    e.z64 = e.size >= MAX32;
    e.offset = off;
    e.localLen = 30 + e.nameBuf.length + (e.z64 ? 20 : 0);
    e.descLen = e.dir ? 0 : e.z64 ? 24 : 16;
    off += e.localLen + e.size + e.descLen;
    const ext = (e.size >= MAX32 ? 2 : 0) + (e.offset >= MAX32 ? 1 : 0);
    e.cdExtra = ext ? 4 + 8 * ext : 0;
    e.cdLen = 46 + e.nameBuf.length + e.cdExtra;
  }
  const cdOffset = off;
  const cdSize = entries.reduce((a, e) => a + e.cdLen, 0);
  const z64 = entries.length >= 0xffff || cdOffset >= MAX32 || cdSize >= MAX32;
  return { cdOffset, cdSize, z64, total: cdOffset + cdSize + (z64 ? 76 : 0) + 22 };
}

function localHeader(e) {
  const b = Buffer.alloc(e.localLen);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(e.z64 ? 45 : 20, 4);
  b.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 6); // UTF-8 (+ descripteur de données)
  b.writeUInt16LE(e.dos.time, 10);
  b.writeUInt16LE(e.dos.date, 12);
  if (e.z64) { b.writeUInt32LE(MAX32, 18); b.writeUInt32LE(MAX32, 22); }
  b.writeUInt16LE(e.nameBuf.length, 26);
  b.writeUInt16LE(e.z64 ? 20 : 0, 28);
  e.nameBuf.copy(b, 30);
  if (e.z64) { const o = 30 + e.nameBuf.length; b.writeUInt16LE(1, o); b.writeUInt16LE(16, o + 2); }
  return b;
}

function descriptor(e) {
  const b = Buffer.alloc(e.descLen);
  b.writeUInt32LE(0x08074b50, 0);
  b.writeUInt32LE(e.crc, 4);
  if (e.z64) { b.writeBigUInt64LE(BigInt(e.size), 8); b.writeBigUInt64LE(BigInt(e.size), 16); }
  else { b.writeUInt32LE(e.size, 8); b.writeUInt32LE(e.size, 12); }
  return b;
}

function centralEntry(e) {
  const b = Buffer.alloc(e.cdLen);
  const bigSize = e.size >= MAX32;
  const bigOff = e.offset >= MAX32;
  b.writeUInt32LE(0x02014b50, 0);
  b.writeUInt16LE((3 << 8) | 45, 4); // Unix, v4.5
  b.writeUInt16LE(e.z64 || bigOff ? 45 : 20, 6);
  b.writeUInt16LE(e.dir ? 0x0800 : 0x0808, 8);
  b.writeUInt16LE(e.dos.time, 12);
  b.writeUInt16LE(e.dos.date, 14);
  b.writeUInt32LE(e.crc || 0, 16);
  b.writeUInt32LE(bigSize ? MAX32 : e.size, 20);
  b.writeUInt32LE(bigSize ? MAX32 : e.size, 24);
  b.writeUInt16LE(e.nameBuf.length, 28);
  b.writeUInt16LE(e.cdExtra, 30);
  b.writeUInt32LE((e.dir ? ((0o40755 << 16) | 0x10) : (0o100644 << 16)) >>> 0, 38);
  b.writeUInt32LE(bigOff ? MAX32 : e.offset, 42);
  e.nameBuf.copy(b, 46);
  if (e.cdExtra) {
    let o = 46 + e.nameBuf.length;
    b.writeUInt16LE(1, o); b.writeUInt16LE(e.cdExtra - 4, o + 2); o += 4;
    if (bigSize) { b.writeBigUInt64LE(BigInt(e.size), o); b.writeBigUInt64LE(BigInt(e.size), o + 8); o += 16; }
    if (bigOff) b.writeBigUInt64LE(BigInt(e.offset), o);
  }
  return b;
}

function endRecords(n, plan) {
  const parts = [];
  if (plan.z64) {
    const z = Buffer.alloc(56);
    z.writeUInt32LE(0x06064b50, 0);
    z.writeBigUInt64LE(44n, 4);
    z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
    z.writeBigUInt64LE(BigInt(n), 24); z.writeBigUInt64LE(BigInt(n), 32);
    z.writeBigUInt64LE(BigInt(plan.cdSize), 40); z.writeBigUInt64LE(BigInt(plan.cdOffset), 48);
    const l = Buffer.alloc(20);
    l.writeUInt32LE(0x07064b50, 0);
    l.writeBigUInt64LE(BigInt(plan.cdOffset + plan.cdSize), 8);
    l.writeUInt32LE(1, 16);
    parts.push(z, l);
  }
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0);
  e.writeUInt16LE(Math.min(n, 0xffff), 8); e.writeUInt16LE(Math.min(n, 0xffff), 10);
  e.writeUInt32LE(Math.min(plan.cdSize, MAX32), 12); e.writeUInt32LE(Math.min(plan.cdOffset, MAX32), 16);
  parts.push(e);
  return Buffer.concat(parts);
}

async function* zipStream(entries, plan) {
  for (const e of entries) {
    yield localHeader(e);
    if (e.dir) continue;
    let crc = 0;
    let n = 0;
    for await (const chunk of fs.createReadStream(e.abs, { highWaterMark: HWM })) {
      const take = n + chunk.length > e.size ? chunk.subarray(0, e.size - n) : chunk;
      crc = zlib.crc32(take, crc);
      n += take.length;
      yield take;
      if (n >= e.size) break;
    }
    if (n !== e.size) throw new Error(`Le fichier ${e.name} a changé pendant la création du ZIP`);
    e.crc = crc >>> 0;
    yield descriptor(e);
  }
  for (const e of entries) yield centralEntry(e);
  yield endRecords(entries.length, plan);
}

async function sendZip(req, res, rels, fileName) {
  const entries = await collectZipEntries(rels);
  if (!entries.length) throw new HttpError(404, 'Rien à télécharger');
  const plan = planZip(entries);
  res.writeHead(200, {
    'content-type': 'application/zip',
    'content-length': plan.total, // taille exacte connue d'avance → barre de progression du navigateur
    'content-disposition': contentDisposition('attachment', fileName),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  await pipeline(Readable.from(zipStream(entries, plan), { objectMode: false }), res).catch(() => res.destroy());
  return entries;
}

async function handleZip(req, res, url) {
  let rels;
  let name = url.searchParams.get('name') || '';
  if (req.method === 'POST') {
    let body = '';
    for await (const c of req) { body += c; if (body.length > 4 << 20) throw new HttpError(413, 'Sélection trop grande'); }
    const f = new URLSearchParams(body);
    rels = f.getAll('p');
    name = f.get('name') || name;
  } else rels = url.searchParams.getAll('path');
  rels = [...new Set(rels.map((r) => cleanRel(r)))];
  if (!rels.length) throw new HttpError(400, 'Aucun élément');
  const zipName = (name || (rels.length === 1 ? path.posix.basename(rels[0]) || 'Partage' : 'Partage')).replace(/[/\\]/g, '_');
  const entries = await sendZip(req, res, rels.map((r) => r || ''), `${zipName}.zip`);
  if (entries) {
    const files = entries.filter((e) => !e.dir);
    log(userOf(req, url), 'download', `télécharge ${rels.length === 1 ? rels[0] || 'tout' : `${rels.length} éléments`} en ZIP (${files.length} fichier${files.length > 1 ? 's' : ''}, ${fmtSize(files.reduce((a, e) => a + e.size, 0))})`);
  }
}

// ---------- presse-papiers partagé ----------
const MAX_CLIP = 200000;
async function handleClipAdd(req, res, url) {
  const b = await readJson(req, MAX_CLIP * 4 + 1024);
  const text = String(b.text ?? '');
  if (!text.trim()) throw new HttpError(400, 'Texte vide');
  if (text.length > MAX_CLIP) throw new HttpError(413, 'Texte trop long (200 000 caractères maximum)');
  const clip = { id: crypto.randomBytes(8).toString('hex'), text, by: userOf(req, url), t: Date.now() };
  clips.data.unshift(clip);
  if (clips.data.length > 100) clips.data.length = 100;
  clips.save();
  broadcast({ type: 'clip-add', clip });
  log(clip.by, 'clip', `a ajouté au presse-papiers : « ${text.trim().replace(/\s+/g, ' ').slice(0, 60)}${text.length > 60 ? '…' : ''} »`);
  sendJson(res, 200, { clip });
}

// ---------- Tailscale Funnel : adresse publique (internet) ----------
let publicUrl = PUBLIC_URL_ENV || null;
function detectFunnel() {
  if (PUBLIC_URL_ENV) return; // adresse publique fixée par la configuration
  execFile('tailscale', ['serve', 'status', '--json'], { timeout: 5000 }, (err, out) => {
    if (err) return;
    let found = null;
    try {
      const j = JSON.parse(out || '{}');
      for (const [hp, on] of Object.entries(j.AllowFunnel || {})) {
        if (!on) continue;
        const handlers = (j.Web && j.Web[hp] && j.Web[hp].Handlers) || {};
        const ours = Object.values(handlers).some((h) => new RegExp(`:${PORT}/?$`).test(h.Proxy || ''));
        if (!ours) continue;
        const [host, port] = hp.split(':');
        found = `https://${host}${port === '443' ? '' : `:${port}`}`;
      }
    } catch { return; }
    if (found !== publicUrl) {
      publicUrl = found;
      console.log(publicUrl ? `Accessible depuis internet (Funnel) : ${publicUrl}` : 'Funnel inactif pour ce service');
      broadcast({ type: 'public-url', url: publicUrl, addresses: serverAddresses() });
    }
  });
}

// adresses utiles pour ouvrir le service depuis un autre appareil (QR code)
function serverAddresses() {
  const scheme = tlsCtx ? 'https' : 'http';
  const out = [];
  if (publicUrl) out.push({ label: 'Internet', url: publicUrl });
  if (tlsCtx) for (const n of tlsCtx.byName.keys()) out.push({ label: 'Tailscale', url: `https://${n}:${PORT}` });
  for (const [ifn, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|lo)/.test(ifn)) continue;
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const label = /^wl/.test(ifn) ? 'Wi-Fi' : /^(en|eth)/.test(ifn) ? 'Ethernet' : /^tailscale/.test(ifn) ? 'Tailscale IP' : ifn;
      out.push({ label, url: `${scheme}://${a.address}:${PORT}` });
    }
  }
  return out;
}

async function handleEvents(req, res, url) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    'x-accel-buffering': 'no',
  });
  try { if (req.httpVersionMajor < 2) res.socket.setNoDelay(true); } catch { /* sans importance */ }
  const client = { res, user: userOf(req, url) };
  clients.add(client);
  res.write('retry: 2000\n\n');
  res.write(`data: ${JSON.stringify({
    ...presence(), type: 'hello', you: client.user, activity, uploads: [...uploads.values()].map(pubUpload),
    shares: shares.data.map(pubShare), clips: clips.data, addresses: serverAddresses(), publicUrl, codeLen: CODE_LEN,
    stats: await getStats(), chunkSize: CHUNK,
  })}\n\n`);
  broadcast(presence());
  const ping = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
    broadcast(presence());
  });
}

// ---------- authentification ----------
const SESSION_DAYS = 30;
const SCRYPT = { N: 16384, r: 8, p: 1 };
let auth = null; // { salt, hash, secret, v } — seule l'empreinte du mot de passe est stockée

const scrypt = (pw, salt) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, 64, SCRYPT, (e, k) => (e ? rej(e) : res(k))));

async function setPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const data = {
    salt, hash: (await scrypt(pw, salt)).toString('hex'),
    secret: crypto.randomBytes(32).toString('hex'), v: Date.now().toString(36),
  };
  await fsp.writeFile(AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}
async function loadAuth() {
  try { auth = JSON.parse(await fsp.readFile(AUTH_FILE, 'utf8')); } catch { auth = null; }
}

const secure = (req) => (req.socket && req.socket.encrypted ? '; Secure' : '');
const sign = (s) => crypto.createHmac('sha256', auth.secret).update(s).digest('base64url');
function makeSession() {
  const payload = Buffer.from(JSON.stringify({ v: auth.v, exp: Date.now() + SESSION_DAYS * 864e5 })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readCookie(req, name) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
function isAuthed(req) {
  if (!auth) return true;
  const c = readCookie(req, 'sid');
  if (!c) return false;
  const [payload, sig] = c.split('.');
  if (!payload || !sig) return false;
  const want = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return false;
  try {
    const d = JSON.parse(Buffer.from(payload, 'base64url').toString());
    return d.v === auth.v && d.exp > Date.now();
  } catch { return false; }
}

// anti-force brute : 5 essais libres puis blocage croissant par IP (30 s → 15 min)
const attempts = new Map();
async function handleLogin(req, res, url) {
  const ip = ipOf(req);
  const a = attempts.get(ip) || { fails: 0, until: 0 };
  const wait = () => Math.ceil((a.until - Date.now()) / 1000);
  if (a.until > Date.now()) throw new HttpError(429, `Trop d'essais. Réessayez dans ${wait()} s.`);
  const b = await readJson(req, 4096);
  const key = await scrypt(String(b.password || ''), auth.salt);
  if (!crypto.timingSafeEqual(key, Buffer.from(auth.hash, 'hex'))) {
    a.fails++;
    if (a.fails >= 5) a.until = Date.now() + Math.min(15 * 60e3, 30e3 * 2 ** (a.fails - 5));
    attempts.set(ip, a);
    await new Promise((r) => setTimeout(r, 400));
    throw new HttpError(401, a.until > Date.now()
      ? `Mot de passe incorrect. Réessayez dans ${wait()} s.`
      : 'Mot de passe incorrect.');
  }
  attempts.delete(ip);
  res.setHeader('set-cookie', `sid=${makeSession()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}${secure(req)}`);
  log(userOf(req, url), 'login', 's\'est connecté');
  sendJson(res, 200, { ok: true });
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, a] of attempts) if (a.until < now - 3600e3) attempts.delete(ip);
}, 600e3).unref();

async function sendPage(res, file) {
  const body = await fsp.readFile(path.join(PUBLIC, file));
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8', 'content-length': body.length, 'cache-control': 'no-store',
    'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
  });
  res.end(body);
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/pub.js': ['pub.js', 'text/javascript; charset=utf-8'],
};

async function handleStatic(res, pathname) {
  const [file, type] = STATIC[pathname];
  const body = await fsp.readFile(path.join(PUBLIC, file));
  res.writeHead(200, { 'content-type': type, 'content-length': body.length, 'cache-control': 'no-cache' });
  res.end(body);
}

// ---------- routeur ----------
async function route(req, res) {
  const url = new URL(req.url, 'http://local');
  const p = url.pathname;
  const m = req.method;

  // pages publiques : écran de connexion + feuille de style
  if (p === '/login' && (m === 'GET' || m === 'HEAD')) {
    if (auth && isAuthed(req)) { res.writeHead(302, { location: '/' }); return res.end(); }
    return sendPage(res, 'login.html');
  }
  if (p === '/login' && m === 'POST') {
    if (!auth) return sendJson(res, 200, { ok: true });
    return handleLogin(req, res, url);
  }
  if (p === '/healthz') return sendJson(res, 200, { ok: true, version: VERSION, https: !!tlsCtx });
  if ((p === '/style.css' || p === '/pub.js') && m === 'GET') return handleStatic(res, p);
  if (p === '/vendor/qrcode.js' && m === 'GET') {
    const body = await fsp.readFile(path.join(PUBLIC, 'vendor', 'qrcode.js'));
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-length': body.length, 'cache-control': 'max-age=86400' });
    return res.end(body);
  }
  // anciens liens longs /s/<id>
  const sm = /^\/s\/([A-Za-z0-9_-]{16,64})(?:\/(dl|unlock|f\/(\d{1,4})))?$/.exec(p);
  if (sm) {
    const ip = ipOf(req);
    probeGuard(ip);
    const s = shares.data.find((x) => x.id === sm[1]);
    if (!s) { probeMiss(ip); if (sm[2]) throw new HttpError(404, 'Lien introuvable'); return gonePage(res, 'missing'); }
    const act = sm[2] ? (sm[2].startsWith('f/') ? 'f' : sm[2]) : null;
    if (act === 'unlock' ? m !== 'POST' : m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Méthode non permise');
    return handleSharePublic(req, res, url, s, act, Number(sm[3]), `/s/${s.id}`);
  }
  // liens courts /AB3K (fichiers ou note), insensibles à la casse
  const cm = /^\/([A-Za-z0-9]{4,12})(?:\/(dl|data|events|raw|unlock|f\/(\d{1,4})))?\/?$/.exec(p);
  if (cm && CODE_RE.test(cm[1].toUpperCase())) {
    const code = cm[1].toUpperCase();
    const ip = ipOf(req);
    probeGuard(ip);
    const obj = findByCode(code);
    if (!obj) { probeMiss(ip); if (cm[2]) throw new HttpError(404, 'Lien introuvable'); return gonePage(res, 'missing'); }
    if (cm[1] !== code && !cm[2]) { res.writeHead(301, { location: `/${code}` }); return res.end(); }
    const act = cm[2] ? (cm[2].startsWith('f/') ? 'f' : cm[2]) : null;
    if (obj.keyHash) return handleNotePublic(req, res, url, obj, act, `/${code}`);
    if (!['dl', 'f', 'unlock', null].includes(act)) throw new HttpError(404, 'Introuvable');
    if (act === 'unlock' ? m !== 'POST' : m !== 'GET' && m !== 'HEAD') throw new HttpError(405, 'Méthode non permise');
    return handleSharePublic(req, res, url, obj, act, Number(cm[3]), `/${code}`);
  }
  if (p === '/ca.crt' && m === 'GET') {
    let body;
    try { body = await fsp.readFile(path.join(CERT_DIR, 'ca.crt')); } catch { throw new HttpError(404, 'Pas de certificat local'); }
    res.writeHead(200, {
      'content-type': 'application/x-x509-ca-cert', 'content-length': body.length,
      'content-disposition': 'attachment; filename="Partage-CA.crt"',
    });
    return res.end(body);
  }

  if (!isAuthed(req)) {
    if (p.startsWith('/api/')) throw new HttpError(401, 'Session expirée, reconnectez-vous');
    const next = p === '/' ? '' : `?next=${encodeURIComponent(req.url)}`;
    res.writeHead(302, { location: `/login${next}`, 'cache-control': 'no-store' });
    return res.end();
  }
  if (p === '/api/logout' && m === 'POST') {
    res.setHeader('set-cookie', `sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure(req)}`);
    return sendJson(res, 200, { ok: true });
  }

  if ((m === 'GET' || m === 'HEAD') && STATIC[p]) return handleStatic(res, p);
  if ((m === 'GET' || m === 'HEAD') && p.startsWith('/f/')) {
    let rel;
    try { rel = decodeURIComponent(p.slice(3)); } catch { throw new HttpError(400, 'URL invalide'); }
    return handleDownload(req, res, url, rel);
  }
  if (m === 'GET' && p === '/api/events') return handleEvents(req, res, url);
  if (m === 'GET' && p === '/api/list') return handleList(res, url);
  if ((m === 'GET' || m === 'POST') && p === '/zip') return handleZip(req, res, url);
  if (m === 'POST' && p === '/api/delete') return handleBatchDelete(req, res, url);
  if (m === 'POST' && p === '/api/shares') return handleShareCreate(req, res, url);
  const shm = /^\/api\/shares\/([A-Za-z0-9_-]{16,64})$/.exec(p);
  if (m === 'DELETE' && shm) return handleShareDelete(req, res, url, shm[1]);
  const shp = /^\/api\/shares\/([A-Za-z0-9_-]{16,64})\/password$/.exec(p);
  if (m === 'POST' && shp) return handleSharePassword(req, res, url, shp[1]);
  if (m === 'POST' && p === '/api/notes') return handleNoteCreate(req, res, url);
  if (m === 'POST' && p === '/api/clips') return handleClipAdd(req, res, url);
  if (m === 'DELETE' && p === '/api/clips') {
    clips.data = [];
    clips.save();
    broadcast({ type: 'clips', clips: [] });
    log(userOf(req, url), 'clear', 'a vidé le presse-papiers');
    return sendJson(res, 200, { ok: true });
  }
  const clm = /^\/api\/clips\/([a-f0-9]{16})$/.exec(p);
  if (m === 'DELETE' && clm) {
    clips.data = clips.data.filter((c) => c.id !== clm[1]);
    clips.save();
    broadcast({ type: 'clip-del', id: clm[1] });
    return sendJson(res, 200, { ok: true });
  }
  if (m === 'DELETE' && p === '/api/activity') {
    activity.length = 0;
    broadcast({ type: 'activity-clear' });
    log(userOf(req, url), 'clear', 'a effacé l\'historique');
    return sendJson(res, 200, { ok: true });
  }
  if (m === 'GET' && p === '/api/stats') return sendJson(res, 200, await getStats());
  if (m === 'POST' && p === '/api/mkdir') return handleMkdir(req, res, url);
  if (m === 'POST' && p === '/api/rename') return handleRename(req, res, url);
  if (m === 'DELETE' && p === '/api/item') return handleDelete(req, res, url);
  if (m === 'POST' && p === '/api/upload/init') return handleInit(req, res, url);

  const um = /^\/api\/upload\/([a-f0-9]{32})(?:\/(\d+|complete))?$/.exec(p);
  if (um) {
    const u = uploads.get(um[1]);
    if (!u) throw new HttpError(404, 'Envoi inconnu ou expiré');
    if (m === 'PUT' && um[2] && um[2] !== 'complete') return handleChunk(req, res, u, Number(um[2]));
    if (m === 'POST' && um[2] === 'complete') return handleComplete(req, res, u);
    if (m === 'DELETE' && !um[2]) {
      await dropUpload(u);
      broadcast({ type: 'upload-cancel', id: u.id });
      log(userOf(req, url), 'cancel', `a annulé l'envoi de ${u.name}`);
      return sendJson(res, 200, { ok: true });
    }
  }
  throw new HttpError(404, 'Introuvable');
}

function onRequest(req, res) {
  route(req, res).catch((e) => {
    const code = e instanceof HttpError ? e.code : 500;
    if (code === 500 && e.code !== 'ECONNRESET' && e.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(e);
    else if (code >= 400 && code !== 401) console.warn(`${req.method} ${req.url.split('?')[0]} → ${code} ${e.message} (${ipOf(req)})`);
    if (res.headersSent) return res.destroy();
    // On vide le corps restant pour garder la connexion keep-alive saine.
    req.resume();
    sendJson(res, code, { error: e instanceof HttpError ? e.message : 'Erreur serveur' });
  });
}

// ---------- HTTPS (HTTP/2) + HTTP sur le même port ----------
let tlsCtx = null; // { def: SecureContext, byName: Map<nom, SecureContext> }

async function loadCerts() {
  const pair = async (name) => {
    try {
      const [key, cert] = await Promise.all([
        fsp.readFile(path.join(CERT_DIR, `${name}.key`)), fsp.readFile(path.join(CERT_DIR, `${name}.crt`)),
      ]);
      return { key, cert };
    } catch { return null; }
  };
  const def = HTTPS_MODE === 'off' ? null : await pair('server');
  if (!def) { tlsCtx = null; return; }
  const byName = new Map();
  // certificat Tailscale (Let's Encrypt) servi pour son nom *.ts.net, si présent
  const ts = await pair('tailscale');
  if (ts) {
    const names = (new crypto.X509Certificate(ts.cert).subjectAltName || '').split(', ')
      .filter((n) => n.startsWith('DNS:')).map((n) => n.slice(4));
    const ctx = tls.createSecureContext(ts);
    for (const n of names) byName.set(n, ctx);
  }
  tlsCtx = { def: tls.createSecureContext(def), byName, defPair: def };
}

const H2_WINDOW = 32 * 1024 * 1024; // grande fenêtre de flux : débit plein en LAN
let h2 = null;

function makeTlsServer() {
  h2 = http2.createSecureServer({
    ...tlsCtx.defPair,
    allowHTTP1: true,
    SNICallback: (name, cb) => cb(null, tlsCtx.byName.get(name) || tlsCtx.def),
    settings: { initialWindowSize: 8 * 1024 * 1024, maxConcurrentStreams: 256 },
    maxSessionMemory: 64,
  }, onRequest);
  h2.on('session', (session) => {
    session.on('localSettings', () => { try { session.setLocalWindowSize(H2_WINDOW); } catch { /* ignoré */ } });
    session.on('error', () => {});
  });
  h2.on('tlsClientError', () => {}); // ex. certificat refusé par le navigateur
  h2.setTimeout(0);
}

// En clair : si HTTPS est actif, on redirige vers https sur le même port.
const plain = http.createServer({ highWaterMark: HWM, requestTimeout: 0, keepAliveTimeout: 65000 }, (req, res) => {
  if (!tlsCtx) return onRequest(req, res);
  const host = (req.headers.host || 'localhost').replace(/:\d+$/, '');
  res.writeHead(308, { location: `https://${host}:${PORT}${req.url}`, 'cache-control': 'no-store' });
  res.end();
});
plain.timeout = 0;

// Aiguillage : un octet 0x16 = poignée de main TLS → HTTPS, sinon HTTP.
const front = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.once('data', (buf) => {
    socket.pause();
    socket.unshift(buf);
    (buf[0] === 0x16 && h2 ? h2 : plain).emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
});

setInterval(async () => {
  const now = Date.now();
  // liens expirés/épuisés depuis plus de 7 jours : supprimés
  const keep = shares.data.filter((x) => shareState(x) === 'active' || now - (x.expiresAt || now) < 7 * 86400e3);
  if (keep.length !== shares.data.length) { shares.data = keep; sharesChanged(); }
  for (const u of uploads.values()) {
    if (now - u.updatedAt > STALE_MS && !u.completing) {
      await dropUpload(u).catch(() => {});
      broadcast({ type: 'upload-cancel', id: u.id });
    }
  }
}, 3600 * 1000).unref();

async function shutdown() {
  clearTimeout(activityTimer);
  await fsp.writeFile(ACTIVITY_FILE, JSON.stringify(activity)).catch(() => {});
  await shares.flush().catch(() => {});
  await notes.flush().catch(() => {});
  await usedCodes.flush().catch(() => {});
  await clips.flush().catch(() => {});
  await Promise.all([...uploads.values()].map((u) => { clearTimeout(u.saveTimer); return saveMeta(u).catch(() => {}); }));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
if (WIN) process.on('SIGBREAK', shutdown);

(async () => {
  if (process.argv[2] === '--set-password') {
    let pw = process.argv[3];
    if (!pw) {
      process.stdout.write('Nouveau mot de passe : ');
      for await (const line of require('node:readline').createInterface({ input: process.stdin })) { pw = line; break; }
    }
    if (!pw) { console.error('Mot de passe vide, rien changé.'); process.exit(1); }
    await setPassword(pw);
    console.log(`Mot de passe enregistré dans ${AUTH_FILE} (empreinte scrypt). Les sessions existantes sont déconnectées.`);
    process.exit(0);
  }
  await loadAuth();
  await loadCerts();
  await loadActivity();
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await loadLinkSecret();
  await usedCodes.load();
  await shares.load();
  await clips.load();
  await notes.load();
  for (const x of [...shares.data, ...notes.data]) if (x.code && !usedCodes.data.includes(x.code)) usedCodes.data.push(x.code);
  migrateShares();
  await fsp.mkdir(ROOT, { recursive: true });
  await loadMetas();
  if (tlsCtx) {
    makeTlsServer();
    // recharge les certificats régulièrement (renouvellement Tailscale)
    setInterval(async () => {
      await loadCerts().catch(() => {});
      if (tlsCtx) h2.setSecureContext(tlsCtx.defPair);
    }, 6 * 3600e3).unref();
  }
  detectFunnel();
  setInterval(detectFunnel, 60e3).unref();
  front.listen(PORT, HOST, () => {
    const scheme = tlsCtx ? 'https' : 'http';
    const addrs = Object.values(os.networkInterfaces()).flat()
      .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => `${scheme}://${a.address}:${PORT}`);
    if (tlsCtx) for (const n of tlsCtx.byName.keys()) addrs.unshift(`https://${n}:${PORT}  (certificat Tailscale)`);
    console.log(`Partage prêt — dossier : ${ROOT}`);
    console.log(`Morceaux de ${CHUNK / 1048576} Mo, ${uploads.size} envoi(s) à reprendre`);
    console.log(tlsCtx ? 'HTTPS + HTTP/2 actif (HTTP redirigé)' : 'HTTP seul (lancez ./gen-certs.sh pour HTTPS)');
    console.log(auth ? 'Accès protégé par mot de passe' : 'ATTENTION : aucun mot de passe (node server.js --set-password)');
    for (const a of addrs) console.log(`  → ${a}`);
  });
})();
