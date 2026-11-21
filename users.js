'use strict';
// Shared user store for server.js and manage.js. Passwords are scrypt-hashed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const FILE = process.env.GUEST_USERS || path.join(__dirname, 'data', 'users.json');

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 254;
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
}
function save(users) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
async function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  const expected = Buffer.from(hashHex || '', 'hex');
  const actual = await scrypt(pw, Buffer.from(saltHex || '', 'hex'), 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
// Used to spend the same time on unknown emails as on known ones.
const DUMMY = hashPassword('dummy-password');

function newInvite(user, hours = 72) {
  const token = crypto.randomBytes(24).toString('base64url');
  user.inviteHash = sha256(token);
  user.inviteExpires = new Date(Date.now() + hours * 3600e3).toISOString();
  return token;
}
function findByInvite(users, token) {
  const h = sha256(token);
  for (const [email, u] of Object.entries(users)) {
    if (u.inviteHash && u.inviteHash === h && Date.parse(u.inviteExpires) > Date.now()) return email;
  }
  return null;
}
function isActive(u) {
  const now = Date.now();
  if (!u || !u.passwordHash) return false;
  if (u.starts && Date.parse(u.starts) > now) return false;
  if (u.expires && Date.parse(u.expires) <= now) return false;
  return true;
}

module.exports = { FILE, load, save, normEmail, validEmail, hashPassword, verifyPassword, DUMMY, newInvite, findByInvite, isActive };
