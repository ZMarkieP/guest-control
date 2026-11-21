'use strict';
const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
let polling, busy = false;

async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') { showLogin(); throw new Error(data.error); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function show(id) { for (const s of ['login', 'setup', 'app']) $(s).hidden = s !== id; }
function showLogin() { clearInterval(polling); show('login'); $('password').value = ''; $('email').focus(); }
function showApp() { show('app'); refresh(); polling = setInterval(refresh, 5000); }

async function act(method, path, body) {
  $('toast').textContent = '';
  try { await api(method, path, body); await refresh(true); }
  catch (e) { $('toast').textContent = e.message; }
}

function render(s) {
  $('hello').textContent = `Hello, ${s.guestName}`;
  $('mock').hidden = !s.mock;
  $('scenes').replaceChildren(el('div', { className: 'scenes' },
    ...s.scenes.map((sc) => el('button', { onclick: () => act('POST', `/api/scenes/${sc.id}`) }, sc.name))));
  $('lights').replaceChildren(...s.lights.map((l) => {
    const card = el('div', { className: 'card' + (l.unavailable ? ' unavail' : '') });
    const t = el('button', { className: 'toggle', disabled: !!l.unavailable, textContent: l.unavailable ? 'Unavailable' : l.on ? 'On' : 'Off' });
    t.setAttribute('aria-pressed', String(!!l.on));
    t.setAttribute('aria-label', `${l.name} light`);
    t.onclick = () => act('POST', `/api/lights/${l.id}`, { on: !l.on });
    card.append(el('div', { className: 'row' }, el('span', { className: 'name' }, l.name), t));
    if (l.on && l.dimmable && l.brightness != null) {
      const r = el('input', { type: 'range', min: 1, max: 100, value: l.brightness });
      r.setAttribute('aria-label', `${l.name} brightness`);
      r.onchange = () => act('POST', `/api/lights/${l.id}`, { on: true, brightness: Number(r.value) });
      card.append(r);
    }
    return card;
  }));
  $('media').replaceChildren(...s.media.map((m) => {
    const card = el('div', { className: 'card' + (m.unavailable ? ' unavail' : '') });
    const btn = (label, action) => el('button', { textContent: label, disabled: !!m.unavailable, onclick: () => act('POST', `/api/media/${m.id}`, { action }) });
    const power = el('button', { className: 'toggle', disabled: !!m.unavailable, textContent: m.unavailable ? 'Unavailable' : m.on ? 'On' : 'Off',
      onclick: () => act('POST', `/api/media/${m.id}`, { action: m.on ? 'power_off' : 'power_on' }) });
    power.setAttribute('aria-pressed', String(!!m.on));
    card.append(el('div', { className: 'row' }, el('span', { className: 'name' }, m.name), power));
    if (m.on) card.append(el('div', { className: 'grid', style: 'margin-top:12px' },
      btn('Volume −', 'volume_down'), btn('Volume +', 'volume_up'), btn(m.muted ? 'Unmute' : 'Mute', 'mute'), btn('Play / Pause', 'play_pause')));
    return card;
  }));
}

async function refresh(force) {
  if (busy && !force) return;
  // Don't yank a slider out from under someone mid-drag.
  if (!force && document.activeElement?.type === 'range') return;
  busy = true;
  try { render(await api('GET', '/api/state')); } catch {} finally { busy = false; }
}

$('loginForm').onsubmit = async (e) => {
  e.preventDefault(); $('loginErr').textContent = '';
  try { await api('POST', '/api/login', { email: $('email').value, password: $('password').value }); showApp(); }
  catch (err) { $('loginErr').textContent = err.message; }
};
$('setupForm').onsubmit = async (e) => {
  e.preventDefault(); $('setupErr').textContent = '';
  if ($('newPassword').value !== $('newPassword2').value) { $('setupErr').textContent = 'Passwords do not match.'; return; }
  try {
    await api('POST', '/api/setup', { token: inviteToken, password: $('newPassword').value });
    history.replaceState(null, '', '/'); showApp();
  } catch (err) { $('setupErr').textContent = err.message; }
};
$('logout').onclick = async () => { await api('POST', '/api/logout').catch(() => {}); showLogin(); };

const inviteToken = new URLSearchParams(location.search).get('invite');
if (inviteToken) {
  api('GET', '/api/invite?token=' + encodeURIComponent(inviteToken))
    .then((d) => { $('setupEmail').textContent = d.email; $('setupUser').value = d.email; show('setup'); $('newPassword').focus(); })
    .catch((err) => { showLogin(); $('loginErr').textContent = err.message; });
} else {
  api('GET', '/api/state').then(() => showApp()).catch(() => showLogin());
}
