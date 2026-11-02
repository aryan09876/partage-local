// Utilisé par l'intégration continue : attend que Partage réponde (ou soit arrêté avec --expect-down).
// node .github/ci-health.mjs <port> <http|https> [--expect-down]
import https from 'node:https';
import http from 'node:http';

const [port, scheme = 'https', flag] = process.argv.slice(2);
const expectDown = flag === '--expect-down';
const lib = scheme === 'https' ? https : http;
const probe = () => new Promise((res) => {
  // certificat auto-signé de l'instance de test : seule la disponibilité est vérifiée ici
  const r = lib.get({ host: '127.0.0.1', port: Number(port), path: '/healthz', rejectUnauthorized: false, timeout: 2000 }, (resp) => {
    let b = '';
    resp.on('data', (d) => { b += d; });
    resp.on('end', () => res(b.includes('"ok":true')));
  });
  r.on('error', () => res(false));
  r.on('timeout', () => { r.destroy(); res(false); });
});
for (let i = 0; i < 60; i++) {
  const up = await probe();
  if (up !== expectDown) { console.log(expectDown ? `Port ${port} : arrêté ✓` : `Port ${port} : en marche ✓`); process.exit(0); }
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(expectDown ? `Port ${port} répond encore` : `Port ${port} ne répond pas`);
process.exit(1);
