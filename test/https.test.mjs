// Certificats générés sans openssl, serveur en HTTPS + redirection HTTP, gestionnaire en ligne de commande.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { X509Certificate } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..');
const { ensureCerts } = require(path.join(ROOT, 'certs.js'));
let dir;
let child;
let port;

const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
const get = (lib, opts) => new Promise((res, rej) => {
  const r = lib.get(opts, (resp) => { let b = ''; resp.on('data', (d) => { b += d; }); resp.on('end', () => res({ status: resp.statusCode, headers: resp.headers, body: b })); });
  r.on('error', rej);
});

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'partage-https-'));
  ensureCerts(path.join(dir, 'certs'), ['partage.test']);
  port = await freePort();
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', TAILSCALE_FUNNEL: 'off', SHARE_DIR: path.join(dir, 'storage'),
    DATA_DIR: path.join(dir, 'data'), AUTH_FILE: path.join(dir, 'auth.json'), CERT_DIR: path.join(dir, 'certs'),
  };
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('le serveur ne démarre pas')), 15000);
    child.stdout.on('data', (d) => { if (String(d).includes('Partage prêt')) { clearTimeout(t); res(); } });
  });
});
after(async () => {
  if (child && child.exitCode === null) { const e = new Promise((r) => child.once('exit', r)); child.kill('SIGTERM'); await e; }
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
});

test('certificats : signés par la CA locale, noms et IP couverts', () => {
  const ca = new X509Certificate(readFileSync(path.join(dir, 'certs', 'ca.crt')));
  const srv = new X509Certificate(readFileSync(path.join(dir, 'certs', 'server.crt')));
  assert.equal(ca.ca, true);
  assert.equal(srv.ca, false);
  assert.ok(srv.verify(ca.publicKey), 'signature par la CA');
  assert.ok(srv.checkHost('localhost'));
  assert.ok(srv.checkHost('partage.test'));
  assert.ok(srv.checkIP('127.0.0.1'));
  assert.ok(new Date(srv.validTo) - Date.now() > 800 * 86400e3);
});

test('HTTPS vérifié avec la CA locale, HTTP redirigé vers HTTPS sur le même port', async () => {
  const ca = readFileSync(path.join(dir, 'certs', 'ca.crt'));
  const h = await get(https, { host: '127.0.0.1', port, path: '/healthz', ca, servername: 'localhost' });
  assert.equal(h.status, 200);
  assert.equal(JSON.parse(h.body).https, true);
  const r = await get(http, { host: '127.0.0.1', port, path: '/login' });
  assert.equal(r.status, 308);
  assert.match(r.headers.location, /^https:\/\//);
});

test('gestionnaire : aide, version, diagnostic sans installation', () => {
  const help = spawnSync(process.execPath, [path.join(ROOT, 'manage.js'), 'help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /partage install/);
  const v = spawnSync(process.execPath, [path.join(ROOT, 'manage.js'), 'version'], { encoding: 'utf8' });
  assert.match(v.stdout.trim(), /^\d+\.\d+\.\d+$/);
  const bad = spawnSync(process.execPath, [path.join(ROOT, 'manage.js'), 'nimportequoi'], { encoding: 'utf8' });
  assert.notEqual(bad.status, 0);
});

test('le serveur lit partage.env (PARTAGE_CONFIG)', async () => {
  const p2 = await freePort();
  const conf = path.join(dir, 'test.env');
  writeFileSync(conf, `PORT=${p2}\nHOST=127.0.0.1\nHTTPS=off\nSHARE_DIR=${path.join(dir, 's2')}\nDATA_DIR=${path.join(dir, 'd2')}\nAUTH_FILE=${path.join(dir, 'a2.json')}\nTAILSCALE_FUNNEL=off\n`);
  const env = { ...process.env, PARTAGE_CONFIG: conf };
  for (const k of ['PORT', 'HOST', 'HTTPS', 'SHARE_DIR', 'DATA_DIR', 'AUTH_FILE', 'CERT_DIR']) delete env[k];
  const c2 = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error('pas démarré')), 15000);
      c2.stdout.on('data', (d) => { if (String(d).includes('Partage prêt')) { clearTimeout(t); res(); } });
    });
    const h = await get(http, { host: '127.0.0.1', port: p2, path: '/healthz' });
    assert.equal(h.status, 200);
    assert.equal(JSON.parse(h.body).https, false);
  } finally {
    const e = new Promise((r) => c2.once('exit', r)); c2.kill('SIGTERM'); await e;
  }
});
