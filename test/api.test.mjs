// Tests de bout en bout : lance une instance isolée (dossiers temporaires, port libre)
// Usage : node --test test/
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const PW = 'mot-de-passe-test';
let dir;
let port;
let child;
let base;
let cookie = '';

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });

async function req(p, { method = 'GET', body, headers = {}, auth = true, raw = false } = {}) {
  const h = { ...headers };
  if (auth && cookie) h.cookie = cookie;
  if (body !== undefined && !(body instanceof Uint8Array)) { h['content-type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(base + p, { method, headers: h, body, redirect: 'manual' });
  if (raw) return r;
  const txt = await r.text();
  let json = null;
  try { json = JSON.parse(txt); } catch { /* pas du JSON */ }
  return { status: r.status, headers: r.headers, text: txt, json };
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'partage-test-'));
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', HTTPS: 'off', TAILSCALE_FUNNEL: 'off',
    SHARE_DIR: path.join(dir, 'storage'), DATA_DIR: path.join(dir, 'data'), AUTH_FILE: path.join(dir, 'auth.json'),
    CERT_DIR: path.join(dir, 'certs'), CHUNK_MB: '1',
  };
  execFileSync(process.execPath, [path.join(ROOT, 'server.js'), '--set-password', PW], { env });
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('le serveur ne démarre pas')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('Partage prêt')) { clearTimeout(t); res(); } });
    child.on('exit', (c) => rej(new Error(`serveur arrêté (code ${c})`)));
  });
});
after(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise((r) => child.once('exit', r));
    child.kill('SIGTERM');
    await exited; // le serveur enregistre ses données en s'arrêtant
  }
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

async function upload(name, data, dirRel = '') {
  const init = await req('/api/upload/init', { method: 'POST', body: { dir: dirRel, name, size: data.length, lastModified: 1 } });
  assert.equal(init.status, 200, init.text);
  const { id, chunkSize } = init.json;
  for (let i = 0; i * chunkSize < data.length || (data.length === 0 && i === 0); i++) {
    if (data.length === 0) break;
    const r = await req(`/api/upload/${id}/${i}`, { method: 'PUT', body: data.subarray(i * chunkSize, (i + 1) * chunkSize) });
    assert.equal(r.status, 200, r.text);
  }
  const c = await req(`/api/upload/${id}/complete`, { method: 'POST' });
  assert.equal(c.status, 200, c.text);
  return c.json;
}

test('connexion : refusée sans session, mauvais mot de passe refusé, bon accepté', async () => {
  assert.equal((await req('/api/list', { auth: false })).status, 401);
  assert.equal((await req('/', { auth: false })).status, 302);
  const bad = await req('/login', { method: 'POST', body: { password: 'faux' }, auth: false });
  assert.equal(bad.status, 401);
  const ok = await req('/login', { method: 'POST', body: { password: PW }, auth: false });
  assert.equal(ok.status, 200);
  cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await req('/api/list')).status, 200);
});

test('envoi en morceaux, reprise et téléchargement partiel', async () => {
  const data = crypto.randomBytes(2.5 * 1024 * 1024);
  const init = await req('/api/upload/init', { method: 'POST', body: { dir: '', name: 'gros.bin', size: data.length, lastModified: 1 } });
  const { id, chunkSize } = init.json;
  await req(`/api/upload/${id}/0`, { method: 'PUT', body: data.subarray(0, chunkSize) });
  const again = await req('/api/upload/init', { method: 'POST', body: { dir: '', name: 'gros.bin', size: data.length, lastModified: 1 } });
  assert.deepEqual(again.json.done, [0], 'la reprise connaît le morceau déjà reçu');
  const early = await req(`/api/upload/${id}/complete`, { method: 'POST' });
  assert.equal(early.status, 409);
  for (let i = 1; i * chunkSize < data.length; i++) await req(`/api/upload/${id}/${i}`, { method: 'PUT', body: data.subarray(i * chunkSize, (i + 1) * chunkSize) });
  assert.equal((await req(`/api/upload/${id}/complete`, { method: 'POST' })).status, 200);
  const r = await req('/f/gros.bin', { raw: true, headers: { cookie, range: 'bytes=1000-1999' } });
  assert.equal(r.status, 206);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(data.subarray(1000, 2000)));
  const full = await req('/f/gros.bin', { raw: true, headers: { cookie } });
  assert.ok(Buffer.from(await full.arrayBuffer()).equals(data));
});

test('morceau trop grand refusé, chemins hors du dossier refusés', async () => {
  const init = await req('/api/upload/init', { method: 'POST', body: { dir: '', name: 'petit.txt', size: 10, lastModified: 2 } });
  const big = await req(`/api/upload/${init.json.id}/0`, { method: 'PUT', body: new Uint8Array(50) });
  assert.ok(big.status === 400 || big.status === 413);
  assert.equal((await req('/api/list?path=..%2F..')).status, 400);
  assert.equal((await req('/api/list?path=.partial')).status, 403);
});

test('lien court pour un fichier : code de 4 caractères, insensible à la casse, limite de téléchargements', async () => {
  await upload('photo.txt', Buffer.from('bonjour le monde'));
  const r = await req('/api/shares', { method: 'POST', body: { paths: ['photo.txt'], maxDownloads: 1 } });
  assert.equal(r.status, 200, r.text);
  const { code } = r.json.share;
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(r.json.share.pw, undefined, "l'empreinte du mot de passe n'est jamais envoyée");
  const page = await req(`/${code}`, { auth: false });
  assert.equal(page.status, 200);
  assert.match(page.text, /photo\.txt/);
  const lower = await req(`/${code.toLowerCase()}`, { auth: false });
  assert.equal(lower.status, 301);
  const dl = await req(`/${code}/dl`, { auth: false });
  assert.equal(dl.text, 'bonjour le monde');
  assert.equal((await req(`/${code}/dl`, { auth: false })).status, 410, 'deuxième téléchargement refusé');
});

test('lien multi-éléments protégé par mot de passe : déverrouillage, ZIP et éléments un par un', async () => {
  await upload('a.txt', Buffer.from('AAA'));
  await upload('b.txt', Buffer.from('BBBB'));
  const r = await req('/api/shares', { method: 'POST', body: { paths: ['a.txt', 'b.txt'], password: 'secret42', title: 'Deux fichiers' } });
  const { code, locked, count } = r.json.share;
  assert.equal(locked, true);
  assert.equal(count, 2);
  assert.equal((await req(`/${code}`, { auth: false })).status, 401);
  assert.equal((await req(`/${code}/dl`, { auth: false })).status, 401);
  assert.equal((await req(`/${code}/unlock`, { method: 'POST', body: { password: 'mauvais' }, auth: false })).status, 401);
  const un = await req(`/${code}/unlock`, { method: 'POST', body: { password: 'secret42' }, auth: false });
  assert.equal(un.status, 200);
  const c = un.headers.get('set-cookie').split(';')[0];
  const page = await req(`/${code}`, { auth: false, headers: { cookie: c } });
  assert.equal(page.status, 200);
  assert.match(page.text, /Deux fichiers/);
  assert.match(page.text, /Tout télécharger/);
  const zip = Buffer.from(await (await req(`/${code}/dl`, { raw: true, auth: false, headers: { cookie: c } })).arrayBuffer());
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'signature ZIP');
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.equal(zip.readUInt16LE(eocd + 10), 2, 'deux entrées dans le ZIP');
  assert.equal((await req(`/${code}/f/1`, { auth: false, headers: { cookie: c } })).text, 'BBBB');
  // supprimer un des fichiers le retire du lien
  await req('/api/delete', { method: 'POST', body: { paths: ['a.txt'] } });
  const after = await req(`/${code}`, { auth: false, headers: { cookie: c } });
  assert.doesNotMatch(after.text, /a\.txt/);
});

test('notes : lecture publique, modification réservée au créateur, conflit, direct, mot de passe', async () => {
  assert.equal((await req('/api/notes', { method: 'POST', body: { text: 'x' }, auth: false })).status, 401, 'création réservée aux utilisateurs connectés');
  const c = await req('/api/notes', { method: 'POST', body: { title: 'Ma note', text: 'Version 1' } });
  assert.equal(c.status, 200, c.text);
  const { note, key } = c.json;
  const code = note.code;
  const pub = await req(`/${code}/data`, { auth: false });
  assert.equal(pub.json.note.text, 'Version 1');
  assert.equal(pub.json.canEdit, false);
  assert.equal((await req(`/${code}/data`, { auth: false, headers: { 'x-note-key': key } })).json.canEdit, true);
  assert.equal((await req(`/${code}`, { method: 'PUT', body: { text: 'piratée' }, auth: false })).status, 403);
  assert.equal((await req(`/${code}`, { method: 'PUT', body: { text: 'piratée' }, auth: false, headers: { 'x-note-key': 'mauvaise-cle-xxxxxxxxxxxx' } })).status, 403);

  // un lecteur connecté en direct reçoit la modification
  const sse = await fetch(`${base}/${code}/events`);
  const reader = sse.body.getReader();
  const got = (async () => {
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += new TextDecoder().decode(value);
      const m = /data: (\{.*\})/.exec(buf);
      if (m) return JSON.parse(m[1]);
    }
  })();
  await new Promise((r) => setTimeout(r, 200));
  const up = await req(`/${code}`, { method: 'PUT', body: { text: 'Version 2', baseVersion: 1 }, auth: false, headers: { 'x-note-key': key } });
  assert.equal(up.status, 200, up.text);
  assert.equal(up.json.note.version, 2);
  const evt = await got;
  assert.equal(evt.note.text, 'Version 2');
  reader.cancel();

  const stale = await req(`/${code}`, { method: 'PUT', body: { text: 'ancienne', baseVersion: 1 }, auth: false, headers: { 'x-note-key': key } });
  assert.equal(stale.status, 409, 'version périmée refusée');
  assert.equal((await req(`/${code}/raw`, { auth: false })).text, 'Version 2');

  await req(`/${code}`, { method: 'PUT', body: { password: 'pw-note' }, auth: false, headers: { 'x-note-key': key } });
  assert.equal((await req(`/${code}/data`, { auth: false })).status, 401, 'note protégée');
  const un = await req(`/${code}/unlock`, { method: 'POST', body: { password: 'pw-note' }, auth: false });
  assert.equal(un.status, 200);
  assert.equal((await req(`/${code}/data`, { auth: false, headers: { cookie: un.headers.get('set-cookie').split(';')[0] } })).status, 200);

  assert.equal((await req(`/${code}`, { method: 'DELETE', auth: false })).status, 403);
  assert.equal((await req(`/${code}`, { method: 'DELETE', auth: false, headers: { 'x-note-key': key } })).status, 200);
  assert.equal((await req(`/${code}/data`, { auth: false })).status, 404);
});

test('presse-papiers partagé', async () => {
  const r = await req('/api/clips', { method: 'POST', body: { text: 'texte partagé' } });
  assert.equal(r.status, 200);
  assert.equal((await req(`/api/clips/${r.json.clip.id}`, { method: 'DELETE' })).status, 200);
});

test('anti-énumération : trop de codes inexistants → blocage temporaire', async () => {
  let last = 0;
  const A = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  for (let i = 0; i < 25; i++) last = (await req(`/ZZ${A[i % A.length]}${(i % 8) + 2}`, { auth: false })).status;
  assert.equal(last, 429);
});
