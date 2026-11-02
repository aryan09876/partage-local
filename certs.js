'use strict';
// Génération de certificats X.509 sans outil externe (ni openssl) : fonctionne sous Linux, macOS et Windows.
// Une autorité locale (CA) signe le certificat du serveur ; installer ca.crt sur un appareil
// supprime l'avertissement du navigateur.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');

// ---------- encodage DER minimal ----------
function derLen(n) {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n >>= 8; }
  return Buffer.from([0x80 | b.length, ...b]);
}
const der = (tag, ...parts) => {
  const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
};
const SEQ = (...p) => der(0x30, ...p);
const SET = (...p) => der(0x31, ...p);
const INT = (buf) => der(0x02, buf[0] & 0x80 ? Buffer.concat([Buffer.from([0]), buf]) : buf);
const BOOL = (v) => der(0x01, Buffer.from([v ? 0xff : 0]));
const OCTET = (buf) => der(0x04, buf);
const BITS = (buf, unused = 0) => der(0x03, Buffer.concat([Buffer.from([unused]), buf]));
const UTF8 = (s) => der(0x0c, Buffer.from(s, 'utf8'));
const NULL = Buffer.from([0x05, 0x00]);
const CTX = (n, buf) => der(0xa0 | n, buf); // [n] EXPLICIT
function OID(s) {
  const a = s.split('.').map(Number);
  const out = [40 * a[0] + a[1]];
  for (const v of a.slice(2)) {
    const st = [v & 0x7f];
    let x = Math.floor(v / 128);
    while (x > 0) { st.unshift((x & 0x7f) | 0x80); x = Math.floor(x / 128); }
    out.push(...st);
  }
  return der(0x06, Buffer.from(out));
}
function TIME(d) {
  const p = (n) => String(n).padStart(2, '0');
  const y = d.getUTCFullYear();
  const body = `${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
  return y < 2050 ? der(0x17, Buffer.from(String(y).slice(2) + body)) : der(0x18, Buffer.from(String(y) + body));
}
function ipBytes(ip) {
  if (net.isIPv4(ip)) return Buffer.from(ip.split('.').map(Number));
  const [head, tail = ''] = ip.split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  return Buffer.from(groups.flatMap((g) => { const v = parseInt(g || '0', 16); return [v >> 8, v & 0xff]; }));
}

const SHA256_RSA = SEQ(OID('1.2.840.113549.1.1.11'), NULL);
const name = (cn) => SEQ(SET(SEQ(OID('2.5.4.3'), UTF8(cn))), SET(SEQ(OID('2.5.4.10'), UTF8('Partage local'))));
const ext = (oid, critical, value) => SEQ(OID(oid), ...(critical ? [BOOL(true)] : []), OCTET(value));
const keyId = (pub) => crypto.createHash('sha1').update(pub.export({ type: 'spki', format: 'der' })).digest();

function buildCert({ subject, issuer, subjectKey, issuerKey, issuerPub, days, isCA, dns = [], ips = [] }) {
  const now = Date.now();
  const serial = crypto.randomBytes(16);
  serial[0] &= 0x7f;
  const exts = [
    ext('2.5.29.19', true, isCA ? SEQ(BOOL(true)) : SEQ()),
    ext('2.5.29.15', true, isCA ? BITS(Buffer.from([0x06]), 1) : BITS(Buffer.from([0xa0]), 5)),
    ext('2.5.29.14', false, OCTET(keyId(subjectKey))),
    ext('2.5.29.35', false, SEQ(der(0x80, keyId(issuerPub)))),
  ];
  if (!isCA) {
    exts.push(ext('2.5.29.37', false, SEQ(OID('1.3.6.1.5.5.7.3.1'))));
    exts.push(ext('2.5.29.17', false, SEQ(
      ...dns.map((d) => der(0x82, Buffer.from(d, 'ascii'))),
      ...ips.map((ip) => der(0x87, ipBytes(ip))),
    )));
  }
  const tbs = SEQ(
    CTX(0, INT(Buffer.from([2]))), INT(serial), SHA256_RSA, name(issuer),
    SEQ(TIME(new Date(now - 3600e3)), TIME(new Date(now + days * 86400e3))),
    name(subject), subjectKey.export({ type: 'spki', format: 'der' }), CTX(3, SEQ(...exts)),
  );
  const sig = crypto.sign('sha256', tbs, issuerKey);
  const certDer = SEQ(tbs, SHA256_RSA, BITS(sig));
  return `-----BEGIN CERTIFICATE-----\n${certDer.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

// noms et adresses du serveur (tous ceux par lesquels on peut l'appeler)
function localNames() {
  const host = os.hostname();
  const dns = [...new Set(['localhost', host, `${host}.local`].filter((n) => /^[A-Za-z0-9.-]+$/.test(n)))];
  const ips = ['127.0.0.1', '::1'];
  for (const list of Object.values(os.networkInterfaces())) {
    // IPv4 seulement : les adresses IPv6 publiques sont souvent temporaires (elles changent chaque jour)
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal && !ips.includes(a.address)) ips.push(a.address);
  }
  return { dns, ips };
}

// Crée (si besoin) la CA locale puis un certificat serveur neuf. Renvoie les noms couverts.
function ensureCerts(dir, extraNames = []) {
  fs.mkdirSync(dir, { recursive: true });
  const caKeyF = path.join(dir, 'ca.key');
  const caCrtF = path.join(dir, 'ca.crt');
  let caKey;
  let caPub;
  if (fs.existsSync(caKeyF) && fs.existsSync(caCrtF)) {
    caKey = crypto.createPrivateKey(fs.readFileSync(caKeyF));
    caPub = crypto.createPublicKey(caKey);
  } else {
    const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 3072 });
    caKey = kp.privateKey;
    caPub = kp.publicKey;
    const cn = `Partage local CA (${os.hostname()})`;
    const caPem = buildCert({ subject: cn, issuer: cn, subjectKey: caPub, issuerKey: caKey, issuerPub: caPub, days: 3650, isCA: true });
    fs.writeFileSync(caKeyF, caKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    fs.writeFileSync(caCrtF, caPem, { mode: 0o644 });
  }
  const caCert = new crypto.X509Certificate(fs.readFileSync(caCrtF));
  const { dns, ips } = localNames();
  for (const n of extraNames) {
    if (net.isIP(n)) { if (!ips.includes(n)) ips.push(n); } else if (/^[A-Za-z0-9.-]+$/.test(n) && !dns.includes(n)) dns.push(n);
  }
  const kp = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = buildCert({
    subject: os.hostname(), issuer: caCert.subject.match(/CN=([^\n]+)/)[1], subjectKey: kp.publicKey,
    issuerKey: caKey, issuerPub: caPub, days: 825, isCA: false, dns, ips,
  });
  fs.writeFileSync(path.join(dir, 'server.key'), kp.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(path.join(dir, 'server.crt'), pem, { mode: 0o644 });
  return { dns, ips, validTo: new crypto.X509Certificate(pem).validTo };
}

module.exports = { ensureCerts, buildCert, localNames };

if (require.main === module) {
  const dir = process.argv[2] || path.join(__dirname, 'certs');
  const r = ensureCerts(dir, process.argv.slice(3));
  console.log(`Certificat créé dans ${dir} (valable jusqu'au ${r.validTo})\n  noms : ${r.dns.join(', ')}\n  IP : ${r.ips.join(', ')}`);
}
