// Ballast on your phone, with no server and no cloud bill: Ballast itself listens on your home
// network and/or your Tailscale network (never the open internet), and a phone pairs once with
// a short code shown on the PC. Each paired phone gets its own revocable key.
import http from 'node:http';
import os from 'node:os';
import crypto from 'node:crypto';
import { db, save, uid } from './store.mjs';
import { changed } from './bus.mjs';

let port = 0;
let handler = null;
const servers = new Map(); // address -> server
const errors = {}; // address -> last listen error
let code = null; // { value, expires, tries }

const hash = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// Tailscale hands out 100.64.0.0/10 addresses; home networks use the private ranges.
function kindOf(name, address) {
  const [a, b] = address.split('.').map(Number);
  if (/tailscale/i.test(name) || (a === 100 && b >= 64 && b <= 127)) return 'tailscale';
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'lan';
  return null;
}

export function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      const kind = kindOf(name, i.address);
      if (kind && !/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)) out.push({ address: i.address, kind, iface: name });
    }
  }
  return out;
}

const settings = () => (db.settings.phone ||= { lan: false, tailscale: false });

export function init(baseHandler, basePort) {
  handler = baseHandler;
  port = Number(process.env.BALLAST_PHONE_PORT) || basePort + 2;
  apply();
  // Wi-Fi changes and Tailscale coming up both change the address list.
  setInterval(apply, 60e3).unref();
}

export function apply() {
  if (!handler) return;
  const s = settings();
  const want = new Set(addresses().filter((a) => s[a.kind]).map((a) => a.address));
  for (const [addr, srv] of servers) if (!want.has(addr)) { srv.close(); servers.delete(addr); }
  for (const addr of want) {
    if (servers.has(addr)) continue;
    const srv = http.createServer((req, res) => handler(req, res, true));
    srv.on('error', (err) => { errors[addr] = err.code === 'EADDRINUSE' ? `Port ${port} is in use on ${addr}` : err.message; servers.delete(addr); changed(); });
    srv.listen(port, addr, () => { delete errors[addr]; changed(); });
    servers.set(addr, srv);
  }
}

export function info() {
  if (!code || code.expires < Date.now()) newCode();
  return {
    ...settings(),
    port,
    addresses: addresses().map((a) => ({ ...a, url: `http://${a.address}:${port}`, listening: servers.has(a.address), error: errors[a.address] || null })),
    code: code.value,
    codeExpires: code.expires,
    devices: (db.devices || []).map(({ id, name, createdAt, lastSeen }) => ({ id, name, createdAt, lastSeen })),
  };
}

export function update(body = {}) {
  const s = settings();
  for (const k of ['lan', 'tailscale']) if (body[k] !== undefined) s[k] = !!body[k];
  save();
  apply();
  changed();
  return info();
}

export function newCode() {
  code = { value: String(crypto.randomInt(0, 1e6)).padStart(6, '0'), expires: Date.now() + 15 * 60e3, tries: 0 };
  return code;
}

export function revoke(id) {
  db.devices = (db.devices || []).filter((d) => d.id !== id);
  save();
  changed();
}

export function deviceFor(token) {
  if (!token) return null;
  const h = hash(token);
  const d = (db.devices || []).find((x) => x.tokenHash === h);
  if (d && Date.now() - (d.lastSeen || 0) > 5 * 60e3) { d.lastSeen = Date.now(); save(); }
  return d || null;
}

function deviceName(ua = '') {
  const m = ua.match(/iPhone|iPad|Android[^;)]*|Windows|Macintosh/);
  return m ? m[0].replace('Macintosh', 'Mac').trim() : 'Phone';
}

const PAGE = (msg = '', err = false) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Pair with Ballast</title>
<link rel="icon" href="/favicon.svg"><meta name="theme-color" content="#0e1013">
<style>body{margin:0;background:#0e1013;color:#e8ebf0;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh}
main{width:min(360px,90vw);text-align:center}img{width:200px;margin-bottom:12px}p{color:#8b94a3}
input{width:100%;box-sizing:border-box;font-size:28px;letter-spacing:.3em;text-align:center;padding:12px;border-radius:10px;border:1px solid #323844;background:#15181d;color:#e8ebf0}
input.name{font-size:16px;letter-spacing:0;margin-top:10px}button{margin-top:14px;width:100%;padding:12px;font-size:16px;font-weight:700;border:0;border-radius:10px;background:#e9a820;color:#111}
.msg{color:${err ? '#ef6b6b' : '#4cc97c'}}</style></head><body><main><img src="/logo.svg" alt="Ballast">
<p>Enter the 6-digit code shown in Ballast on your PC (<b>Settings → Phone</b>).</p>
<form method="post" action="/pair"><input name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus>
<input class="name" name="name" placeholder="Name this device (optional)" maxlength="40"><button>Pair</button></form>
${msg ? `<p class="msg">${msg}</p>` : ''}</main></body></html>`;

export function pairPage(req, res, form) {
  const html = (body, status = 200, headers = {}) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers }); res.end(body); };
  if (!form) return html(PAGE());
  if (!code || code.expires < Date.now() || code.tries >= 5) return html(PAGE('That code has expired. Show a new one in Ballast on your PC.', true), 400);
  if (String(form.code || '').trim() !== code.value) {
    code.tries++;
    return html(PAGE(code.tries >= 5 ? 'Too many tries. Show a new code on your PC.' : 'That code doesn’t match. Try again.', true), 400);
  }
  const token = crypto.randomBytes(32).toString('hex');
  const name = String(form.name || '').trim().slice(0, 40) || deviceName(req.headers['user-agent']);
  (db.devices ||= []).push({ id: uid('dev'), name, tokenHash: hash(token), createdAt: Date.now(), lastSeen: Date.now() });
  code = null; // one pairing per code
  save();
  changed();
  html('', 302, { location: '/', 'set-cookie': `ballast_device=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` });
}
