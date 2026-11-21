# Guest Control

A phone-friendly web app for guests on your guest WiFi. A guest signs in with her email and a password she chooses, then can control only the lights, TV and scenes you list. Backed by Home Assistant. No npm dependencies (Node 18+). Designed to run on a Raspberry Pi at `10.10.10.110:8080`.

## Setup on the Pi
1. In Home Assistant: Profile → Security → **Long-lived access tokens** → create one.
2. `cp config.example.json config.json` and edit the HA URL and the entity IDs guests may control. Anything not listed is unreachable. Device edits reload automatically.
3. Run once to try it: `HA_TOKEN=<token> node server.js`. Without `HA_TOKEN` it runs in **demo mode** with fake devices.
4. To run on boot, see `guest-control.service` (systemd; the token goes in `/etc/guest-control.env`).

## Inviting a guest
```
node manage.js invite her@example.com --name Alex --starts 2026-11-24T14:00 --expires 2026-11-27T11:00
```
This prints a one-time setup link (`http://10.10.10.110:8080/?invite=...`, valid 72h). Send it to her. She opens it on the guest WiFi, chooses her password (8+ characters), and from then on signs in with email + password.

Other commands: `list`, `reset <email>` (forgot password: new link, old password and sessions stop working), `revoke <email>`.

Accounts live in `data/users.json` (gitignored, mode 600). Passwords are stored only as scrypt hashes.

## Network (important)
- Let the guest VLAN reach the Pi **only on port 8080**, and never Home Assistant itself (8123). This server is the only door, and it only exposes the allowlist.
- This is plain HTTP, so on shared WiFi the password is readable by anyone sniffing the network. Fine on a WPA2/3 guest network you trust; for more protection put a TLS reverse proxy (Caddy) in front.
- Don't reuse a password you use elsewhere. Tell guests that too.

## Security notes
- The invite link is what proves she's the right person; nobody else can claim her email, and the link works once.
- Login throttling: 5 wrong tries per device and 15 per account triggers a 5-minute lockout. Unknown emails and wrong passwords return the same message and take the same time.
- Sessions last at most 24h or until her expiry date, and die immediately on revoke or reset. They are held in memory, so restarting the server signs everyone out.
- Actions are logged to stdout with the guest's email.
