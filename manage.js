#!/usr/bin/env node
'use strict';
// Manage guest accounts.
//   node manage.js invite her@example.com --name Alex --starts 2026-11-24T14:00 --expires 2026-11-27T11:00
//   node manage.js reset  her@example.com      (new setup link; old password stops working)
//   node manage.js revoke her@example.com
//   node manage.js list
const U = require('./users');
const BASE = process.env.BASE_URL || 'http://10.10.10.110:8080';
const [cmd, rawEmail, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i += 2) opt[rest[i].replace(/^--/, '')] = rest[i + 1];
const die = (m) => { console.error(m); process.exit(1); };
const users = U.load();
const email = U.normEmail(rawEmail);
const link = (u) => `${BASE}/?invite=${U.newInvite(u)}`;
const date = (s) => { if (!s) return undefined; const d = new Date(s); if (isNaN(d)) die(`Bad date: ${s}`); return d.toISOString(); };

if (cmd === 'invite') {
  if (!U.validEmail(email)) die('Usage: node manage.js invite <email> [--name N] [--starts T] [--expires T]');
  if (users[email]?.passwordHash) die('That guest already has a password. Use "reset" instead.');
  const u = users[email] = { name: opt.name || email.split('@')[0], starts: date(opt.starts), expires: date(opt.expires), ...users[email] };
  console.log(`Send ${email} this setup link (valid 72h, one use):\n\n  ${link(u)}\n`);
} else if (cmd === 'reset') {
  if (!users[email]) die('No such guest.');
  delete users[email].passwordHash;
  console.log(`New setup link for ${email}:\n\n  ${link(users[email])}\n`);
} else if (cmd === 'revoke') {
  if (!users[email]) die('No such guest.');
  delete users[email];
  console.log(`Removed ${email}`);
} else if (cmd === 'list') {
  for (const [e, u] of Object.entries(users))
    console.log(`${e}\t${u.name}\t${u.passwordHash ? (U.isActive(u) ? 'active' : 'inactive (outside dates)') : 'awaiting setup'}\texpires ${u.expires || 'never'}`);
  process.exit(0);
} else die('Commands: invite | reset | revoke | list');
U.save(users);
