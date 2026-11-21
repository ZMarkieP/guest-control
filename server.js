#!/usr/bin/env node
// Guest Control: a dependency-free Node server that lets a guest on the guest
// WiFi control an allowlisted set of Home Assistant entities after entering a
// personal PIN. The HA token never leaves this server.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Users = require('./users');

const CONFIG_PATH = process.env.GUEST_CONFIG || path.join(__dirname, 'config.json');
const PORT = Number(process.env.PORT || 8080);
const HA_TOKEN = process.env.HA_TOKEN || '';
const PUBLIC_DIR = path.join(__dirname, 'public');

const SESSION_MAX_MS = 24 * 3600e3;
const MAX_FAILS = 5;
const LOCKOUT_MS = 5 * 60e3;

function loadConfig() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  cfg.lights ||= []; cfg.media ||= []; cfg.scenes ||= [];
  return cfg;
}
let config = loadConfig();
// Re-read config on change so device edits apply without restarting.
fs.watchFile(CONFIG_PATH, { interval: 2000 }, () => {
  try { config = loadConfig(); console.log('config reloaded'); }
  catch (e) { console.error('config reload failed, keeping old config:', e.message); }
});

const MOCK = !HA_TOKEN;
const mockState = new Map();
function mockGet(id) {
  if (!mockState.has(id)) mockState.set(id, { state: 'off', attributes: { brightness: 128, is_volume_muted: false } });
  return mockState.get(id);
}

async function ha(method, apiPath, body) {
  const res = await fetch(config.homeAssistant.url.replace(/\/$/, '') + apiPath, {
    method,
    headers: { Authorization: `Bearer ${HA_TOKEN}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HA ${res.status}`);
  return res.json();
}
const getState = async (id) => MOCK ? mockGet(id) : ha('GET', `/api/states/${encodeURIComponent(id)}`);
const callService = (domain, service, data) =>
  MOCK ? Promise.resolve(mockService(domain, service, data)) : ha('POST', `/api/services/${domain}/${service}`, data);

function mockService(domain, service, d) {
  if (domain === 'scene') return;
  const s = mockGet(d.entity_id);
  if (service === 'turn_on') { s.state = 'on'; if (d.brightness_pct != null) s.attributes.brightness = Math.round(d.brightness_pct * 2.55); }
  if (service === 'turn_off') s.state = 'off';
  if (service === 'volume_mute') s.attributes.is_volume_muted = d.is_volume_muted;
}

// ---- sessions & login throttling -------------------------------------------
const sessions = new Map(); // token -> { email, name, ph, expires }
const fails = new Map();    // "ip:1.2.3.4" or "email:x@y.z" -> { count, until }

// Throttle by IP (5 tries) and by account (15 tries), so one guest can't
// hammer another guest's account but also can't lock her out with a few tries.
const LIMITS = { ip: MAX_FAILS, email: 15 };
const keysFor = (ip, email) => [['ip', `ip:${ip}`], ['email', `email:${email}`]];
function lockedOut(ip, email) {
  return keysFor(ip, email).some(([, k]) => { const f = fails.get(k); return f && f.until > Date.now(); });
}
function recordFail(ip, email) {
  for (const [kind, k] of keysFor(ip, email)) {
    const f = fails.get(k) || { count: 0, until: 0 };
    if (f.until && f.until <= Date.now()) { f.count = 0; f.until = 0; }
    f.count++;
    if (f.count >= LIMITS[kind]) f.until = Date.now() + LOCKOUT_MS;
    fails.set(k, f);
  }
}
function clearFails(ip, email) { for (const [, k] of keysFor(ip, email)) fails.delete(k); }
const MIN_PASSWORD = 8;
function cookieToken(req) {
  const m = /(?:^|;\s*)gc=([a-f0-9]{64})/.exec(req.headers.cookie || '');
  return m && m[1];
}
function sessionFor(req) {
  const t = cookieToken(req);
  const s = t && sessions.get(t);
  if (!s) return null;
  if (s.expires <= Date.now()) { sessions.delete(t); return null; }
  // Guest revoked, expired, or password changed/reset → session dies too.
  const u = Users.load()[s.email];
  if (!Users.isActive(u) || u.passwordHash !== s.ph) { sessions.delete(t); return null; }
  return s;
}

// ---- http helpers ----------------------------------------------------------
function send(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 4096) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {}); } catch { reject(new Error('bad json')); } });
  });
}
const SECURITY = {
  'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
};
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

// ---- actions ---------------------------------------------------------------
const find = (list, id) => list.find((x) => x.id === id);

async function snapshot() {
  const out = { guestName: undefined, mock: MOCK, lights: [], media: [], scenes: config.scenes.map(({ id, name }) => ({ id, name })) };
  await Promise.all([
    ...config.lights.map(async (l) => {
      try { const s = await getState(l.id); out.lights.push({ id: l.id, name: l.name, on: s.state === 'on', dimmable: l.dimmable !== false,
        brightness: s.attributes?.brightness != null ? Math.round(s.attributes.brightness / 2.55) : null }); }
      catch { out.lights.push({ id: l.id, name: l.name, unavailable: true }); }
    }),
    ...config.media.map(async (m) => {
      try { const s = await getState(m.id); out.media.push({ id: m.id, name: m.name, on: !['off', 'unavailable', 'standby'].includes(s.state),
        muted: !!s.attributes?.is_volume_muted }); }
      catch { out.media.push({ id: m.id, name: m.name, unavailable: true }); }
    }),
  ]);
  const order = (list) => (a, b) => list.findIndex((x) => x.id === a.id) - list.findIndex((x) => x.id === b.id);
  out.lights.sort(order(config.lights)); out.media.sort(order(config.media));
  return out;
}

const MEDIA_ACTIONS = {
  power_on: ['turn_on'], power_off: ['turn_off'],
  volume_up: ['volume_up'], volume_down: ['volume_down'],
  play_pause: ['media_play_pause'],
};

function startSession(res, ip, email, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Math.min(Date.now() + SESSION_MAX_MS, user.expires ? Date.parse(user.expires) : Infinity);
  sessions.set(token, { email, name: user.name, ph: user.passwordHash, expires });
  console.log(`login: ${email} from ${ip}`);
  return send(res, 200, { name: user.name }, {
    'Set-Cookie': `gc=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor((expires - Date.now()) / 1000)}` });
}

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress;

  if (req.method === 'POST' && url.pathname === '/api/login') {
    const body = await readJson(req);
    const email = Users.normEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    if (lockedOut(ip, email)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const user = Users.load()[email];
    // Always run a hash so unknown emails take as long as real ones.
    const ok = await Users.verifyPassword(password, user?.passwordHash || await Users.DUMMY);
    if (!user || !ok || !Users.isActive(user)) {
      recordFail(ip, email);
      return send(res, 401, { error: 'Email or password did not match.' });
    }
    clearFails(ip, email);
    return startSession(res, ip, email, user);
  }

  // Invite link: look up who it's for, so the page can show the email.
  if (req.method === 'GET' && url.pathname === '/api/invite') {
    const email = Users.findByInvite(Users.load(), url.searchParams.get('token') || '');
    return email ? send(res, 200, { email }) : send(res, 404, { error: 'This setup link is invalid or has expired. Ask your host for a new one.' });
  }
  // First-time password choice (also used after a "reset").
  if (req.method === 'POST' && url.pathname === '/api/setup') {
    if (lockedOut(ip, '')) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    const { token, password } = await readJson(req);
    const users = Users.load();
    const email = typeof token === 'string' ? Users.findByInvite(users, token) : null;
    if (!email) { recordFail(ip, ''); return send(res, 404, { error: 'This setup link is invalid or has expired. Ask your host for a new one.' }); }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD || password.length > 200)
      return send(res, 400, { error: `Password must be at least ${MIN_PASSWORD} characters.` });
    const user = users[email];
    user.passwordHash = await Users.hashPassword(password);
    delete user.inviteHash; delete user.inviteExpires;
    Users.save(users);
    return startSession(res, ip, email, user);
  }

  if (!url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res);

  const session = sessionFor(req);
  if (!session) return send(res, 401, { error: 'Please sign in.' });
  // CSRF defence in depth: state-changing calls must be same-origin.
  if (req.method !== 'GET') {
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'Bad origin' });
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    sessions.delete(cookieToken(req));
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'gc=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const snap = await snapshot(); snap.guestName = session.name; return send(res, 200, snap);
  }

  const m = /^\/api\/(lights|media|scenes)\/([\w.]+)$/.exec(url.pathname);
  if (req.method === 'POST' && m) {
    const [, kind, id] = m;
    const body = await readJson(req);
    const log = (what) => console.log(`${session.email}: ${what} ${id}`);
    if (kind === 'lights') {
      const l = find(config.lights, id); if (!l) return send(res, 404, { error: 'Unknown light' });
      if (body.on === false) { log('off'); await callService('light', 'turn_off', { entity_id: id }); }
      else {
        const data = { entity_id: id };
        if (body.brightness != null && l.dimmable !== false) {
          const b = Number(body.brightness);
          if (!Number.isFinite(b)) return send(res, 400, { error: 'Bad brightness' });
          data.brightness_pct = Math.min(100, Math.max(1, Math.round(b)));
        }
        log('on'); await callService('light', 'turn_on', data);
      }
      return send(res, 200, { ok: true });
    }
    if (kind === 'media') {
      const d = find(config.media, id); if (!d) return send(res, 404, { error: 'Unknown device' });
      if (body.action === 'mute') {
        const cur = await getState(id);
        log('mute'); await callService('media_player', 'volume_mute', { entity_id: id, is_volume_muted: !cur.attributes?.is_volume_muted });
      } else if (MEDIA_ACTIONS[body.action]) {
        log(body.action); await callService('media_player', MEDIA_ACTIONS[body.action][0], { entity_id: id });
      } else return send(res, 400, { error: 'Unknown action' });
      return send(res, 200, { ok: true });
    }
    const sc = find(config.scenes, id); if (!sc) return send(res, 404, { error: 'Unknown scene' });
    log('scene'); await callService('scene', 'turn_on', { entity_id: id });
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

function serveStatic(p, res) {
  const rel = p === '/' ? '/index.html' : p;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...SECURITY });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    console.error(e.message);
    if (!res.headersSent) send(res, e.message === 'bad json' || e.message === 'too large' ? 400 : 502, { error: 'Something went wrong.' });
  });
});
if (require.main === module) {
  server.listen(PORT, () => console.log(`Guest Control on :${PORT}${MOCK ? ' (MOCK mode: no HA_TOKEN set)' : ''}`));
  setInterval(() => { const n = Date.now(); for (const [t, s] of sessions) if (s.expires <= n) sessions.delete(t); }, 600e3).unref();
}
module.exports = { server };
