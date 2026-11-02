#!/usr/bin/env node
'use strict';
// partage — installe, configure et gère Partage local. Linux (systemd), Windows (tâche planifiée), macOS (launchd).
// Lancement : ./partage <commande>  (Linux/macOS)   ·   partage <commande>  (Windows)   ·   node manage.js <commande>

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const https = require('node:https');
const http = require('node:http');
const readline = require('node:readline');
const { spawnSync, spawn } = require('node:child_process');
const { ensureCerts } = require('./certs');

const APP = __dirname;
const CONF = path.join(APP, 'partage.env');
const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const LINUX = process.platform === 'linux';
const UNIT = '/etc/systemd/system/partage.service';
const LABEL = 'local.partage';
const PLIST = `/Library/LaunchDaemons/${LABEL}.plist`;
const TASK = 'Partage local';
const FW_NAME = 'Partage local';

const HELP = `
Partage local — gestion du service

  partage install                 installation guidée (questions avec valeurs par défaut)
  partage install --yes --port 4892 --access lan --https auto --password '…'
  partage status | start | stop | restart
  partage logs [-f]               journaux (-f : en continu)
  partage config                  affiche la configuration
  partage set <réglage> <valeur>  change un réglage et redémarre :
        port 8080 · access local|lan|all|10.0.0.0/8 · https auto|off · dir <dossier>
        public-url https://… (ou none) · code-length 4…12
  partage password                change le mot de passe d'accès
  partage certs [nom …]           régénère le certificat HTTPS local (noms ou IP en plus)
  partage funnel on [8443] | off  accès depuis internet via Tailscale Funnel
  partage backup [--with-files]   archive configuration, liens et notes (+ fichiers)
  partage doctor                  diagnostic complet
  partage update                  met à jour (git pull) et redémarre
  partage uninstall [--purge]     retire le service (--purge : efface aussi config, liens et notes)

Accès : local = cette machine seulement · lan = réseau local (+ Tailscale) · all = tout réseau joignable
`;

// ---------- affichage ----------
const tty = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = c(1); const dim = c(2); const green = c(32); const yellow = c(33); const red = c(31); const cyan = c(36);
const say = (s = '') => console.log(s);
const ok = (s) => console.log(`${green('✓')} ${s}`);
const warn = (s) => console.log(`${yellow('!')} ${s}`);
const step = (s) => console.log(`\n${bold(s)}`);
class Stop extends Error {}
function die(s) { console.error(red(`✗ ${s}`)); throw new Stop(); }

// ---------- utilitaires ----------
const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  return { ok: r.status === 0, status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
};
const has = (cmd) => (WIN ? run('where', [cmd]).ok : run('sh', ['-c', `command -v ${cmd}`]).ok);
const ps = (script) => run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

function isAdmin() { return WIN ? run('net', ['session']).ok : process.getuid() === 0; }
function needAdmin(args) {
  if (isAdmin()) return;
  if (WIN) die(`Lancez cette commande dans un terminal administrateur (clic droit sur « Terminal » ou « PowerShell » → Exécuter en tant qu'administrateur) : partage ${args.join(' ')}`);
  // sous Linux / macOS : relance avec sudo en gardant le même Node et l'utilisateur d'origine
  const r = spawnSync('sudo', ['--preserve-env=PARTAGE_USER,PARTAGE_PASSWORD,NO_COLOR', process.execPath, __filename, ...args], {
    stdio: 'inherit', env: { ...process.env, PARTAGE_USER: process.env.PARTAGE_USER || os.userInfo().username },
  });
  process.exit(r.status ?? 1);
}

// ---------- configuration ----------
const DEFAULTS = {
  PORT: '4892', ACCESS: 'lan', HTTPS: 'auto', SHARE_DIR: path.join(APP, 'storage'), DATA_DIR: path.join(APP, 'data'),
  PUBLIC_URL: '', SHORT_CODE_LENGTH: '4', CHUNK_MB: '16', SERVICE_USER: '', FW_RULES: '',
};
function loadConf() {
  const cfg = { ...DEFAULTS };
  try {
    for (const line of fs.readFileSync(CONF, 'utf8').split(/\r?\n/)) {
      const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) cfg[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
    }
  } catch { /* pas encore installé */ }
  return cfg;
}
function saveConf(cfg) {
  const lines = [
    '# Configuration de Partage local — modifiez avec : partage set <réglage> <valeur>',
    `PORT=${cfg.PORT}`, `HOST=${cfg.ACCESS === 'local' ? '127.0.0.1' : '0.0.0.0'}`, `ACCESS=${cfg.ACCESS}`, `HTTPS=${cfg.HTTPS}`,
    `SHARE_DIR=${cfg.SHARE_DIR}`, `DATA_DIR=${cfg.DATA_DIR}`, `AUTH_FILE=${path.join(APP, 'auth.json')}`, `CERT_DIR=${path.join(APP, 'certs')}`,
    `PUBLIC_URL=${cfg.PUBLIC_URL}`, `SHORT_CODE_LENGTH=${cfg.SHORT_CODE_LENGTH}`, `CHUNK_MB=${cfg.CHUNK_MB}`,
    `SERVICE_USER=${cfg.SERVICE_USER}`, `FW_RULES=${cfg.FW_RULES}`,
  ];
  if (!LINUX) lines.push(`LOG_FILE=${path.join(cfg.DATA_DIR, 'partage.log')}`);
  fs.writeFileSync(CONF, `${lines.join(os.EOL)}${os.EOL}`, { mode: 0o600 });
  giveToUser(cfg, CONF);
}
const scheme = (cfg) => (cfg.HTTPS !== 'off' && fs.existsSync(path.join(APP, 'certs', 'server.crt')) ? 'https' : 'http');
const validPort = (p) => /^\d+$/.test(p) && +p >= 1 && +p <= 65535;
const validAccess = (a) => /^(local|lan|all)$/.test(a) || /^[0-9.]+\/\d{1,2}$/.test(a);

// sous Linux/macOS, les fichiers créés en root sont rendus à l'utilisateur du service
function userIds(user) {
  const u = run('id', ['-u', user]); const g = run('id', ['-g', user]);
  return u.ok && g.ok ? { uid: +u.out, gid: +g.out } : null;
}
function giveToUser(cfg, ...paths) {
  if (WIN || !isAdmin() || !cfg.SERVICE_USER) return;
  const ids = userIds(cfg.SERVICE_USER);
  if (!ids) return;
  for (const p of paths) {
    if (!fs.existsSync(p)) continue;
    fs.chownSync(p, ids.uid, ids.gid);
    if (fs.statSync(p).isDirectory()) for (const e of fs.readdirSync(p)) giveToUser(cfg, path.join(p, e));
  }
}

// ---------- questions ----------
let YES = false;
let rl = null;
const rli = () => (rl ||= readline.createInterface({ input: process.stdin, output: process.stdout }));
function ask(q, def) {
  if (YES || !process.stdin.isTTY) return Promise.resolve(String(def));
  return new Promise((res) => rli().question(`${q} ${dim(`[${def}]`)} `, (a) => res(a.trim() || String(def))));
}
function askHidden(q) {
  return new Promise((res) => {
    const r = rli();
    const orig = r._writeToOutput;
    r._writeToOutput = (s) => { if (s.includes(q)) orig.call(r, s); else if (s === '\r\n' || s === '\n') orig.call(r, s); };
    r.question(q, (a) => { r._writeToOutput = orig; process.stdout.write('\n'); res(a); });
  });
}

// ---------- réseau ----------
function lanCidr() {
  let dev = null;
  if (LINUX) dev = /dev (\S+)/.exec(run('ip', ['route', 'show', 'default']).out)?.[1] || null;
  const ifs = os.networkInterfaces();
  const names = dev ? [dev] : Object.keys(ifs).filter((n) => !/^(lo|docker|br-|veth|virbr|tailscale|utun|vEthernet)/i.test(n));
  for (const n of names) {
    for (const a of ifs[n] || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const bits = Number(a.cidr.split('/')[1]);
      const ip = a.address.split('.').reduce((x, o) => (x << 8) + Number(o), 0) >>> 0;
      const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
      const netw = (ip & mask) >>> 0;
      return `${[24, 16, 8, 0].map((s) => (netw >>> s) & 255).join('.')}/${bits}`;
    }
  }
  return null;
}
function lanIps() {
  const out = [];
  for (const [n, list] of Object.entries(os.networkInterfaces())) {
    if (/^(docker|br-|veth|virbr|vEthernet)/i.test(n)) continue;
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}
function portFree(port, host) {
  return new Promise((res) => {
    const s = net.createServer().once('error', () => res(false)).once('listening', () => s.close(() => res(true)));
    s.listen(Number(port), host);
  });
}
function health(cfg) {
  const lib = scheme(cfg) === 'https' ? https : http;
  return new Promise((res) => {
    // vérifie le certificat avec la CA locale quand elle existe (sinon simple test de disponibilité)
    const caFile = path.join(APP, 'certs', 'ca.crt');
    const tlsOpts = lib === https ? (fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile), servername: 'localhost' } : { rejectUnauthorized: false }) : {};
    const r = lib.get({ host: '127.0.0.1', port: Number(cfg.PORT), path: '/healthz', timeout: 2000, ...tlsOpts }, (resp) => {
      let b = '';
      resp.on('data', (d) => { b += d; });
      resp.on('end', () => res(b.includes('"ok":true')));
    });
    r.on('error', () => res(false));
    r.on('timeout', () => { r.destroy(); res(false); });
  });
}
async function waitUp(cfg) {
  for (let i = 0; i < 40; i++) { if (await health(cfg)) return true; await new Promise((r) => setTimeout(r, 500)); }
  return false;
}
function showUrls(cfg) {
  const s = scheme(cfg);
  say(`  ${bold('Adresses :')}`);
  if (cfg.ACCESS === 'local') say(`    ${s}://127.0.0.1:${cfg.PORT}  ${dim('(cette machine seulement)')}`);
  else for (const ip of lanIps()) say(`    ${s}://${ip}:${cfg.PORT}`);
  if (cfg.PUBLIC_URL) say(`    ${cfg.PUBLIC_URL}  ${dim('(adresse des liens courts)')}`);
}

// ---------- pare-feu ----------
function fwKind() {
  if (WIN) return 'windows';
  if (MAC) return 'none';
  if (has('ufw') && /Status: active/.test(run('ufw', ['status']).out)) return 'ufw';
  if (has('firewall-cmd') && run('firewall-cmd', ['--state']).ok) return 'firewalld';
  return 'none';
}
function fwRemove(cfg) {
  const kind = fwKind();
  if (kind === 'windows') { ps(`Get-NetFirewallRule -DisplayName ${psq(FW_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule`); cfg.FW_RULES = ''; return; }
  for (const r of cfg.FW_RULES.split(';').filter(Boolean)) {
    const [src, port] = r.split('@');
    if (kind === 'ufw') {
      if (src === 'any') run('ufw', ['delete', 'allow', `${port}/tcp`]);
      else if (src === 'tailscale0') run('ufw', ['delete', 'allow', 'in', 'on', 'tailscale0', 'to', 'any', 'port', port, 'proto', 'tcp']);
      else run('ufw', ['delete', 'allow', 'from', src, 'to', 'any', 'port', port, 'proto', 'tcp']);
    } else if (kind === 'firewalld') {
      if (src === 'any' || src === 'tailscale0') run('firewall-cmd', ['-q', '--permanent', `--remove-port=${port}/tcp`]);
      else run('firewall-cmd', ['-q', '--permanent', `--remove-rich-rule=rule family=ipv4 source address=${src} port port=${port} protocol=tcp accept`]);
    }
  }
  if (kind === 'firewalld') run('firewall-cmd', ['-q', '--reload']);
  cfg.FW_RULES = '';
}
function fwApply(cfg) {
  const kind = fwKind();
  fwRemove(cfg);
  if (cfg.ACCESS === 'local') { ok('Accès limité à cette machine : aucun port ouvert dans le pare-feu'); return; }
  const port = cfg.PORT;
  if (kind === 'windows') {
    const remote = cfg.ACCESS === 'all' ? 'Any' : cfg.ACCESS === 'lan' ? 'LocalSubnet' : cfg.ACCESS;
    const extra = has('tailscale') && cfg.ACCESS === 'lan' ? ',100.64.0.0/10' : '';
    const r = ps(`New-NetFirewallRule -DisplayName ${psq(FW_NAME)} -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -Profile Any -RemoteAddress ${remote}${extra} | Out-Null`);
    if (!r.ok) warn(`Pare-feu Windows : ${r.err.split('\n')[0]}`);
    else { cfg.FW_RULES = `${remote}${extra}@${port}`; ok(`Pare-feu Windows : port ${port} ouvert (${remote === 'LocalSubnet' ? 'réseau local' : remote}${extra ? ' + Tailscale' : ''})`); }
    return;
  }
  if (kind === 'none') { say(dim(`  Aucun pare-feu géré détecté${MAC ? ' (macOS demandera l\'autorisation à la première connexion)' : ''} : le port ${port} est joignable selon votre réseau.`)); return; }
  const rules = [];
  if (cfg.ACCESS === 'all') rules.push(`any@${port}`);
  else if (cfg.ACCESS === 'lan') { const n = lanCidr(); if (n) rules.push(`${n}@${port}`); else warn('Réseau local non détecté'); } else rules.push(`${cfg.ACCESS}@${port}`);
  if (cfg.ACCESS !== 'all' && fs.existsSync('/sys/class/net/tailscale0')) rules.push(`tailscale0@${port}`);
  for (const r of rules) {
    const [src, p] = r.split('@');
    if (kind === 'ufw') {
      if (src === 'any') run('ufw', ['allow', `${p}/tcp`, 'comment', 'Partage local']);
      else if (src === 'tailscale0') run('ufw', ['allow', 'in', 'on', 'tailscale0', 'to', 'any', 'port', p, 'proto', 'tcp', 'comment', 'Partage local (Tailscale)']);
      else run('ufw', ['allow', 'from', src, 'to', 'any', 'port', p, 'proto', 'tcp', 'comment', 'Partage local']);
    } else if (src === 'any' || src === 'tailscale0') run('firewall-cmd', ['-q', '--permanent', `--add-port=${p}/tcp`]);
    else run('firewall-cmd', ['-q', '--permanent', `--add-rich-rule=rule family=ipv4 source address=${src} port port=${p} protocol=tcp accept`]);
  }
  if (kind === 'firewalld') run('firewall-cmd', ['-q', '--reload']);
  cfg.FW_RULES = rules.join(';');
  ok(`Pare-feu (${kind}) : port ${port} ouvert pour ${rules.map((r) => r.split('@')[0]).join(', ')}`);
}

// ---------- service (systemd / tâche planifiée / launchd) ----------
const svc = {
  install(cfg) {
    const node = process.execPath;
    const server = path.join(APP, 'server.js');
    if (LINUX) {
      const group = run('id', ['-gn', cfg.SERVICE_USER]).out || cfg.SERVICE_USER;
      fs.writeFileSync(UNIT, `[Unit]
Description=Partage local — partage de fichiers en réseau local
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${cfg.SERVICE_USER}
Group=${group}
WorkingDirectory=${APP}
ExecStart=${node} ${server}
Restart=always
RestartSec=2
TimeoutStopSec=15
LimitNOFILE=65536
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=${[...new Set([APP, cfg.SHARE_DIR, cfg.DATA_DIR])].join(' ')}

[Install]
WantedBy=multi-user.target
`);
      run('systemctl', ['daemon-reload']);
      run('systemctl', ['enable', 'partage']);
    } else if (WIN) {
      const r = ps(`$a = New-ScheduledTaskAction -Execute ${psq(node)} -Argument ${psq(`"${server}"`)} -WorkingDirectory ${psq(APP)}
$t = New-ScheduledTaskTrigger -AtStartup
$s = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew
$p = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName ${psq(TASK)} -Action $a -Trigger $t -Settings $s -Principal $p -Description 'Partage local — partage de fichiers en réseau local' -Force | Out-Null`);
      if (!r.ok) die(`Création de la tâche planifiée impossible : ${r.err.split('\n')[0]}`);
    } else if (MAC) {
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
      const log = path.join(cfg.DATA_DIR, 'partage.log');
      fs.writeFileSync(PLIST, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${esc(node)}</string><string>${esc(server)}</string></array>
  <key>WorkingDirectory</key><string>${esc(APP)}</string>
  <key>UserName</key><string>${esc(cfg.SERVICE_USER)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${esc(log)}</string><key>StandardErrorPath</key><string>${esc(log)}</string>
</dict></plist>
`);
      run('launchctl', ['bootout', `system/${LABEL}`]);
    } else die(`Système non pris en charge : ${process.platform}`);
  },
  start() {
    if (LINUX) return run('systemctl', ['start', 'partage']).ok;
    if (WIN) return ps(`Start-ScheduledTask -TaskName ${psq(TASK)}`).ok;
    return run('launchctl', ['bootstrap', 'system', PLIST]).ok || run('launchctl', ['kickstart', `system/${LABEL}`]).ok;
  },
  stop() {
    if (LINUX) return run('systemctl', ['stop', 'partage']).ok;
    if (WIN) {
      const r = ps(`Stop-ScheduledTask -TaskName ${psq(TASK)}; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like ${psq(`*${path.join(APP, 'server.js')}*`)} } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`);
      return r.ok;
    }
    return run('launchctl', ['bootout', `system/${LABEL}`]).ok;
  },
  restart() {
    if (LINUX) return run('systemctl', ['restart', 'partage']).ok;
    this.stop();
    return this.start();
  },
  installed() { return LINUX ? fs.existsSync(UNIT) : WIN ? ps(`Get-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction Stop | Out-Null`).ok : fs.existsSync(PLIST); },
  active() {
    if (LINUX) return run('systemctl', ['is-active', '--quiet', 'partage']).ok;
    if (WIN) return /Running/.test(ps(`(Get-ScheduledTask -TaskName ${psq(TASK)} -ErrorAction SilentlyContinue).State`).out);
    return run('launchctl', ['print', `system/${LABEL}`]).ok;
  },
  remove() {
    this.stop();
    if (LINUX) { run('systemctl', ['disable', 'partage']); fs.rmSync(UNIT, { force: true }); run('systemctl', ['daemon-reload']); }
    else if (WIN) ps(`Unregister-ScheduledTask -TaskName ${psq(TASK)} -Confirm:$false`);
    else fs.rmSync(PLIST, { force: true });
  },
};

// ---------- mot de passe & certificats ----------
async function setPassword(cfg, given) {
  let pw = given || process.env.PARTAGE_PASSWORD || '';
  if (!pw) {
    if (!process.stdin.isTTY) die('Mot de passe requis : --password … ou variable PARTAGE_PASSWORD');
    for (;;) {
      pw = await askHidden('Mot de passe d\'accès à Partage : ');
      if (pw.length < 6) { warn('6 caractères minimum'); continue; }
      if (pw === await askHidden('Confirmez : ')) break;
      warn('Les deux saisies diffèrent');
    }
  }
  const r = spawnSync(process.execPath, [path.join(APP, 'server.js'), '--set-password'], {
    input: `${pw}\n`, encoding: 'utf8', env: { ...process.env, AUTH_FILE: path.join(APP, 'auth.json'), LOG_FILE: '' },
  });
  if (r.status !== 0) die(`Enregistrement du mot de passe impossible : ${r.stderr}`);
  giveToUser(cfg, path.join(APP, 'auth.json'));
  ok('Mot de passe enregistré (seule son empreinte scrypt est stockée)');
}
function makeCerts(cfg, extra = []) {
  const host = cfg.PUBLIC_URL ? (() => { try { return new URL(cfg.PUBLIC_URL).hostname; } catch { return null; } })() : null;
  const r = ensureCerts(path.join(APP, 'certs'), [...extra, ...(host ? [host] : [])]);
  giveToUser(cfg, path.join(APP, 'certs'));
  ok(`Certificat HTTPS local créé (valable jusqu'au ${r.validTo})`);
  say(dim('  Pour supprimer l\'avertissement du navigateur, installez certs/ca.crt sur vos appareils (lien sur la page de connexion).'));
}

// ---------- commandes ----------
function parseFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--yes' || a === '-y') f.yes = true;
    else if (a.startsWith('--')) { f[a.slice(2)] = args[i + 1]; i++; } else (f._ ||= []).push(a);
  }
  return f;
}

async function cmdInstall(args) {
  needAdmin(['install', ...args]);
  const f = parseFlags(args);
  YES = !!f.yes;
  const cfg = loadConf();
  for (const [flag, key] of [['port', 'PORT'], ['access', 'ACCESS'], ['https', 'HTTPS'], ['dir', 'SHARE_DIR'], ['public-url', 'PUBLIC_URL'], ['user', 'SERVICE_USER']]) if (f[flag]) cfg[key] = f[flag];
  say(`${bold('Installation de Partage local')}  ${dim(`(${APP} · Node ${process.version} · ${WIN ? 'Windows' : MAC ? 'macOS' : 'Linux'})`)}`);
  if (Number(process.versions.node.split('.')[0]) < 20) die(`Node.js ${process.version} est trop ancien : il faut la version 20 ou plus récente`);
  if (!WIN) {
    if (!cfg.SERVICE_USER) cfg.SERVICE_USER = process.env.PARTAGE_USER || process.env.SUDO_USER || os.userInfo().username;
    if (cfg.SERVICE_USER === 'root') warn('Le service tournera en root : préférez un utilisateur normal (--user nom)');
  }
  const wasActive = svc.installed() && svc.active();

  step('1. Réseau');
  const port = await ask('Port du serveur web ?', cfg.PORT);
  if (!validPort(port)) die(`Port invalide : ${port}`);
  if (!(wasActive && port === cfg.PORT) && !(await portFree(port, '0.0.0.0'))) die(`Le port ${port} est déjà utilisé par un autre programme`);
  cfg.PORT = port;
  say(`  ${cyan('local')} = cette machine seulement · ${cyan('lan')} = réseau local${lanCidr() ? ` (${lanCidr()})` : ''} · ${cyan('all')} = tout réseau joignable · ou un sous-réseau (ex. 10.0.0.0/8)`);
  const access = await ask('Qui peut accéder ?', cfg.ACCESS);
  if (!validAccess(access)) die(`Accès invalide : ${access}`);
  cfg.ACCESS = access;

  step('2. Sécurité');
  say(`  ${cyan('auto')} = HTTPS avec un certificat local (recommandé) · ${cyan('off')} = HTTP simple`);
  const h = await ask('HTTPS ?', cfg.HTTPS);
  if (!/^(auto|off)$/.test(h)) die('Valeurs possibles : auto ou off');
  cfg.HTTPS = h;
  if (!fs.existsSync(path.join(APP, 'auth.json')) || f.password) await setPassword(cfg, f.password);
  else if (/^[oy]/i.test(await ask('Un mot de passe existe déjà. Le changer ? (o/n)', 'n'))) await setPassword(cfg);

  step('3. Stockage');
  cfg.SHARE_DIR = path.resolve(await ask('Dossier des fichiers partagés ?', cfg.SHARE_DIR));
  cfg.PUBLIC_URL = (await ask('Adresse publique des liens courts (« none » = adresse du serveur) ?', cfg.PUBLIC_URL || 'none')).replace(/\/+$/, '');
  if (cfg.PUBLIC_URL === 'none') cfg.PUBLIC_URL = '';
  for (const d of [cfg.SHARE_DIR, cfg.DATA_DIR]) fs.mkdirSync(d, { recursive: true });
  giveToUser(cfg, cfg.SHARE_DIR, cfg.DATA_DIR);
  if (cfg.HTTPS === 'auto' && !fs.existsSync(path.join(APP, 'certs', 'server.crt'))) makeCerts(cfg);

  step('4. Service');
  fwApply(cfg);
  saveConf(cfg);
  svc.install(cfg);
  if (wasActive) svc.restart(); else svc.start();
  if (await waitUp(cfg)) ok(`Partage est en marche et démarrera automatiquement avec la machine`);
  else warn('Le service ne répond pas encore : partage logs');
  say();
  showUrls(cfg);
  say(`\n${dim('Gérer : partage status · partage logs · partage set port 8080 · partage set access local · partage doctor')}`);
}

async function cmdSet(args) {
  needAdmin(['set', ...args]);
  const [key, val] = args;
  const cfg = loadConf();
  if (!svc.installed()) die('Partage n\'est pas installé : partage install');
  if (!key || val === undefined) die('Usage : partage set <port|access|https|dir|public-url|code-length> <valeur>');
  switch (key) {
    case 'port':
      if (!validPort(val)) die('Port invalide');
      if (val !== cfg.PORT && !(await portFree(val, '0.0.0.0'))) die(`Le port ${val} est déjà utilisé`);
      cfg.PORT = val; break;
    case 'access': if (!validAccess(val)) die('Valeurs : local, lan, all ou un sous-réseau (ex. 10.0.0.0/8)'); cfg.ACCESS = val; break;
    case 'https':
      if (!/^(auto|off)$/.test(val)) die('Valeurs : auto ou off');
      cfg.HTTPS = val;
      if (val === 'auto' && !fs.existsSync(path.join(APP, 'certs', 'server.crt'))) makeCerts(cfg);
      break;
    case 'dir': cfg.SHARE_DIR = path.resolve(val); fs.mkdirSync(cfg.SHARE_DIR, { recursive: true }); giveToUser(cfg, cfg.SHARE_DIR); break;
    case 'public-url': cfg.PUBLIC_URL = val === 'none' ? '' : val.replace(/\/+$/, ''); break;
    case 'code-length': if (!/^([4-9]|1[0-2])$/.test(val)) die('Entre 4 et 12'); cfg.SHORT_CODE_LENGTH = val; break;
    default: die(`Réglage inconnu : ${key}`);
  }
  if (key === 'port' || key === 'access') fwApply(cfg);
  saveConf(cfg);
  if (key === 'dir') svc.install(cfg); // les dossiers autorisés du service changent
  svc.restart();
  if (await waitUp(cfg)) ok(`« ${key} » = ${val} — Partage redémarré`); else warn('Partage ne répond pas : partage logs');
  showUrls(cfg);
}

function cmdConfig() {
  const cfg = loadConf();
  if (!fs.existsSync(CONF)) die('Aucune configuration : partage install');
  say(`${bold('Configuration')} ${dim(`(${CONF})`)}`);
  const rows = [['Port', cfg.PORT], ['Accès', cfg.ACCESS], ['HTTPS', cfg.HTTPS], ['Fichiers', cfg.SHARE_DIR], ['Données', cfg.DATA_DIR],
    ['Liens courts', `${cfg.PUBLIC_URL || '(adresse du serveur)'} · ${cfg.SHORT_CODE_LENGTH} caractères`],
    ['Utilisateur', cfg.SERVICE_USER || (WIN ? 'SYSTEM' : '—')], ['Pare-feu', cfg.FW_RULES || '(aucune règle)']];
  for (const [k, v] of rows) say(`  ${k.padEnd(13)} ${v}`);
}

async function cmdStatus() {
  const cfg = loadConf();
  if (!svc.installed()) { warn('Partage n\'est pas installé : partage install'); return; }
  if (await health(cfg)) ok(`Partage est en marche (${scheme(cfg)}, port ${cfg.PORT})`);
  else if (svc.active()) warn('Le service tourne mais ne répond pas encore');
  else warn('Partage est arrêté : partage start');
  showUrls(cfg);
}

function cmdLogs(args) {
  const follow = args.includes('-f');
  const cfg = loadConf();
  if (LINUX) { spawnSync('journalctl', ['-u', 'partage', '--no-pager', '-n', '100', ...(follow ? ['-f'] : [])], { stdio: 'inherit' }); return; }
  const f = path.join(cfg.DATA_DIR, 'partage.log');
  if (!fs.existsSync(f)) die(`Pas encore de journal (${f})`);
  const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
  say(lines.slice(-100).join('\n'));
  if (!follow) return;
  let pos = fs.statSync(f).size;
  fs.watchFile(f, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0;
    if (cur.size === pos) return;
    const s = fs.createReadStream(f, { start: pos, end: cur.size - 1, encoding: 'utf8' });
    s.on('data', (d) => process.stdout.write(d));
    pos = cur.size;
  });
  return new Promise(() => {}); // jusqu'à Ctrl+C
}

async function cmdSimple(action) {
  needAdmin([action]);
  if (!svc.installed()) die('Partage n\'est pas installé : partage install');
  const r = svc[action]();
  if (!r && action !== 'stop') warn(`${action} : la commande a échoué`);
  if (action === 'stop') { ok('Partage est arrêté'); return; }
  const cfg = loadConf();
  if (await waitUp(cfg)) ok(`Partage est en marche`); else warn('Partage ne répond pas : partage logs');
}

async function cmdPassword() {
  needAdmin(['password']);
  const cfg = loadConf();
  await setPassword(cfg);
  if (svc.installed()) { svc.restart(); ok('Toutes les sessions ont été déconnectées'); }
}

function cmdCerts(args) {
  if (!WIN && !isAdmin() && svc.installed()) needAdmin(['certs', ...args]);
  const cfg = loadConf();
  makeCerts(cfg, args);
  if (svc.installed()) { svc.restart(); ok('Partage redémarré avec le nouveau certificat'); }
}

async function cmdFunnel(args) {
  needAdmin(['funnel', ...args]);
  const cfg = loadConf();
  if (!has('tailscale')) die('Tailscale n\'est pas installé (https://tailscale.com/download)');
  const action = args[0] || 'on';
  const fport = args[1] || '8443';
  if (!/^(443|8443|10000)$/.test(fport)) die('Tailscale Funnel n\'accepte que les ports 443, 8443 et 10000');
  if (action === 'off') {
    run('tailscale', ['funnel', `--https=${fport}`, 'off']);
    cfg.PUBLIC_URL = '';
    saveConf(cfg); svc.restart();
    ok(`Funnel désactivé (port ${fport})`);
    return;
  }
  const target = scheme(cfg) === 'https' ? `https+insecure://127.0.0.1:${cfg.PORT}` : `http://127.0.0.1:${cfg.PORT}`;
  const r = run('tailscale', ['funnel', '--bg', `--https=${fport}`, target]);
  if (!r.ok) die(`Tailscale : ${r.err || r.out}`);
  const dns = JSON.parse(run('tailscale', ['status', '--json']).out).Self.DNSName.replace(/\.$/, '');
  cfg.PUBLIC_URL = `https://${dns}${fport === '443' ? '' : `:${fport}`}`;
  saveConf(cfg); svc.restart();
  ok(`Partage est accessible depuis internet : ${cfg.PUBLIC_URL}`);
  warn('La page de connexion est publique : choisissez un mot de passe solide');
}

function cmdBackup(args) {
  const withFiles = args.includes('--with-files');
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const dest = path.resolve(args.find((a) => !a.startsWith('--')) || `partage-sauvegarde-${stamp}.tar.gz`);
  const items = ['partage.env', 'auth.json', 'certs', 'data', ...(withFiles ? ['storage'] : [])].filter((x) => fs.existsSync(path.join(APP, x)));
  const r = run('tar', ['-czf', dest, '-C', APP, ...items]);
  if (!r.ok) die(`Archive impossible : ${r.err}`);
  try { fs.chmodSync(dest, 0o600); } catch { /* Windows */ }
  ok(`Sauvegarde : ${dest} (${(fs.statSync(dest).size / 1048576).toFixed(1)} Mo)${withFiles ? '' : ' — sans les fichiers (--with-files pour les inclure)'}`);
}

async function cmdDoctor() {
  const cfg = loadConf();
  say(bold('Diagnostic de Partage local'));
  const major = Number(process.versions.node.split('.')[0]);
  (major >= 20 ? ok : warn)(`Node.js ${process.version}${major >= 20 ? '' : ' (20 ou plus récent requis)'}`);
  svc.installed() ? ok(`Service installé (${LINUX ? 'systemd' : WIN ? 'tâche planifiée' : 'launchd'})`) : warn('Service non installé : partage install');
  (await health(cfg)) ? ok(`Le serveur répond (${scheme(cfg)}://127.0.0.1:${cfg.PORT})`) : warn(`Le serveur ne répond pas sur le port ${cfg.PORT}`);
  fs.existsSync(path.join(APP, 'auth.json')) ? ok('Mot de passe configuré') : warn('Aucun mot de passe : accès ouvert à tous !');
  const crt = path.join(APP, 'certs', 'server.crt');
  if (fs.existsSync(crt)) {
    const x = new (require('node:crypto').X509Certificate)(fs.readFileSync(crt));
    const days = Math.floor((new Date(x.validTo) - Date.now()) / 86400e3);
    (days > 30 ? ok : warn)(`Certificat HTTPS valable encore ${days} jours`);
  } else say(dim('  HTTPS désactivé (pas de certificat)'));
  try {
    const s = fs.statfsSync(cfg.SHARE_DIR);
    const free = (s.bavail * s.bsize) / 1073741824;
    (free > 5 ? ok : warn)(`Stockage ${cfg.SHARE_DIR} : ${free.toFixed(1)} Go libres`);
  } catch { warn(`Dossier de stockage introuvable : ${cfg.SHARE_DIR}`); }
  say(`  Pare-feu : ${isAdmin() || WIN ? fwKind() : '(sudo nécessaire pour vérifier)'} · règles : ${cfg.FW_RULES || 'aucune'}`);
  say(`  Accès : ${cfg.ACCESS} · liens courts : ${cfg.PUBLIC_URL || 'adresse du serveur'}`);
}

async function cmdUpdate() {
  needAdmin(['update']);
  const cfg = loadConf();
  if (!fs.existsSync(path.join(APP, '.git'))) die('Ce dossier n\'est pas un dépôt git (installez avec git clone pour pouvoir mettre à jour)');
  const git = !WIN && cfg.SERVICE_USER ? run('sudo', ['-u', cfg.SERVICE_USER, 'git', '-C', APP, 'pull', '--ff-only']) : run('git', ['-C', APP, 'pull', '--ff-only']);
  if (!git.ok) die(`git pull : ${git.err}`);
  say(dim(git.out));
  svc.restart();
  if (await waitUp(cfg)) ok('Partage est à jour et redémarré'); else warn('Partage ne répond pas : partage logs');
}

function cmdUninstall(args) {
  needAdmin(['uninstall', ...args]);
  const cfg = loadConf();
  svc.remove();
  fwRemove(cfg);
  ok('Service supprimé et règles de pare-feu retirées');
  if (args.includes('--purge')) {
    for (const p of ['data', 'auth.json', 'certs', 'partage.env']) fs.rmSync(path.join(APP, p), { recursive: true, force: true });
    ok(`Configuration, mot de passe, liens et notes effacés (fichiers partagés conservés : ${cfg.SHARE_DIR})`);
  } else {
    saveConf(cfg);
    say(dim('Vos fichiers, liens et notes sont conservés (--purge pour effacer configuration, liens et notes).'));
  }
}

// ---------- point d'entrée ----------
async function main() {
  const [cmd = 'help', ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'install': return cmdInstall(args);
    case 'set': return cmdSet(args);
    case 'config': return cmdConfig();
    case 'status': return cmdStatus();
    case 'start': case 'stop': case 'restart': return cmdSimple(cmd);
    case 'logs': return cmdLogs(args);
    case 'password': return cmdPassword();
    case 'certs': return cmdCerts(args);
    case 'funnel': return cmdFunnel(args);
    case 'backup': return cmdBackup(args);
    case 'doctor': return cmdDoctor();
    case 'update': return cmdUpdate();
    case 'uninstall': return cmdUninstall(args);
    case 'version': case '--version': say(require('./package.json').version); return undefined;
    case 'help': case '-h': case '--help': say(HELP); return undefined;
    default: die(`Commande inconnue : ${cmd} (partage help)`);
  }
  return undefined;
}

main().then(() => { if (rl) rl.close(); }, (e) => {
  if (rl) rl.close();
  if (!(e instanceof Stop)) console.error(red(e.stack || String(e)));
  process.exitCode = 1;
});
