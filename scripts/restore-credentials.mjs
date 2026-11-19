#!/usr/bin/env node
// Writes the Even Hub CLI credentials to $XDG_CONFIG_HOME/evenhub/credentials.yaml
// and warns before the refresh token expires. `evenhub login` needs an interactive
// terminal, so CI reuses a CI-only session created by `npm run ci-login`.
//
// Two sources, newest wins (by refresh-token expiry):
//  - the EVENHUB_CREDENTIALS_B64 secret (set by ci-login),
//  - EVENHUB_EXTRA_CREDENTIALS_B64: any other secret the ci-login output may have been
//    pasted into by mistake (the workflows pass the old EVENHUB_SECRET_WRITER_TOKEN), and
//  - the encrypted session the previous run left in the Actions cache
//    (EVENHUB_SESSION_FILE, default .evenhub-session/state.enc), which holds the
//    rotated tokens. See scripts/save-session.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { decryptSession, jwtClaims, jwtExpiry, newerCredentials, readYamlField, sessionKey } from './release-lib.mjs';

// Even Hub refresh tokens live 7 days; the keep-alive workflow refreshes daily.
const WARN_DAYS = 2;
const gh = !!process.env.GITHUB_ACTIONS;
const error = (m) => console.error(gh ? `::error title=Even Hub credentials::${m}` : m);
const warn = (m) => console.error(gh ? `::warning title=Even Hub credentials::${m}` : m);

const b64 = (process.env.EVENHUB_CREDENTIALS_B64 ?? '').trim();
if (!b64) {
  error('EVENHUB_CREDENTIALS_B64 secret is not set. Run `npm run ci-login -- --set` locally (creates a CI-only session).');
  process.exit(1);
}
const decode = (v) => {
  const text = Buffer.from((v ?? '').trim(), 'base64').toString('utf8');
  return readYamlField(text, 'refresh_token') && readYamlField(text, 'access_token') ? text : null;
};
const seed = decode(b64);
const extra = decode(process.env.EVENHUB_EXTRA_CREDENTIALS_B64);
if (!seed && !extra) {
  error('EVENHUB_CREDENTIALS_B64 does not decode to a valid credentials.yaml (missing tokens). Run `npm run ci-login -- --set` locally.');
  process.exit(1);
}

// What each source holds (refresh-token expiry only), to see at a glance which login is newest.
const expiryOf = (y) => {
  const e = y && jwtExpiry(readYamlField(y, 'refresh_token'));
  return e ? `Even Hub login, refresh token expires ${new Date(e * 1000).toISOString()}` : null;
};
console.log(`EVENHUB_CREDENTIALS_B64: ${expiryOf(seed) ?? 'not an Even Hub login'}`);
if (process.env.EVENHUB_EXTRA_CREDENTIALS_B64) {
  console.log(`EVENHUB_SECRET_WRITER_TOKEN: ${expiryOf(extra) ?? 'not an Even Hub login (no longer needed; you can delete it)'}`);
}

const sessionFile = process.env.EVENHUB_SESSION_FILE || '.evenhub-session/state.enc';
const cached = existsSync(sessionFile) ? decryptSession(readFileSync(sessionFile), sessionKey(b64)) : null;
if (existsSync(sessionFile) && !cached) console.log('Cached session is from an older ci-login; ignoring it.');
if (cached) console.log(`session cache: ${expiryOf(cached)}`);
let pick = newerCredentials(seed ?? extra, cached);
if (seed && extra) {
  const other = newerCredentials(pick.yaml, extra);
  if (other.source === 'cache') pick = { yaml: extra, source: 'extra' };
}
const { yaml, source } = pick;
const label = {
  cache: 'session cache (rotated tokens)',
  secret: seed ? 'EVENHUB_CREDENTIALS_B64 secret' : 'EVENHUB_SECRET_WRITER_TOKEN secret',
  extra: 'EVENHUB_SECRET_WRITER_TOKEN secret (a newer ci-login was pasted there)',
}[source];
console.log(`Using Even Hub credentials from the ${label}.`);
const refresh = readYamlField(yaml, 'refresh_token');

// Diagnostics (no secrets): when were these tokens issued? Helps tell a stale
// secret apart from a session the server revoked.
for (const [name, tok] of [['access', readYamlField(yaml, 'access_token')], ['refresh', refresh]]) {
  const c = jwtClaims(tok);
  if (!c) continue;
  const fmt = (t) => {
    if (typeof t !== 'number') return 'n/a';
    const min = Math.round((t * 1000 - Date.now()) / 60000);
    return `${new Date(t * 1000).toISOString()} (${min >= 0 ? `in ${min} min` : `${-min} min ago`})`;
  };
  console.log(`${name} token: issued ${fmt(c.iat)}, expires ${fmt(c.exp)}`);
}

const exp = jwtExpiry(refresh);
if (exp !== null) {
  const days = (exp * 1000 - Date.now()) / 86_400_000;
  if (days <= 0) {
    error('The Even Hub refresh token has expired. Run `npm run ci-login -- --set` locally to create a new CI-only session.');
    process.exit(2);
  }
  if (days < WARN_DAYS) warn(`The Even Hub refresh token expires in ${Math.floor(days)} day(s). Run 'npm run ci-login -- --set' soon.`);
  else console.log(`Refresh token valid for ${Math.floor(days)} more days.`);
}

const dir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'evenhub');
mkdirSync(dir, { recursive: true, mode: 0o700 });
writeFileSync(join(dir, 'credentials.yaml'), yaml, { mode: 0o600 });
console.log(`Credentials written for ${readYamlField(yaml, 'email') ?? 'unknown account'}.`);
