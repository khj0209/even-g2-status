#!/usr/bin/env node
// Writes the Even Hub CLI credentials from the EVENHUB_CREDENTIALS_B64 secret
// to $XDG_CONFIG_HOME/evenhub/credentials.yaml and warns before the refresh
// token expires. `evenhub login` needs an interactive terminal, so CI reuses
// a CI-only session created by `npm run ci-login` (see README "자동 배포").
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { jwtClaims, jwtExpiry, readYamlField } from './release-lib.mjs';

const WARN_DAYS = 14;
const gh = !!process.env.GITHUB_ACTIONS;
const error = (m) => console.error(gh ? `::error title=Even Hub credentials::${m}` : m);
const warn = (m) => console.error(gh ? `::warning title=Even Hub credentials::${m}` : m);

const b64 = (process.env.EVENHUB_CREDENTIALS_B64 ?? '').trim();
if (!b64) {
  error('EVENHUB_CREDENTIALS_B64 secret is not set. Run `npm run ci-login -- --set` locally (creates a CI-only session).');
  process.exit(1);
}
const yaml = Buffer.from(b64, 'base64').toString('utf8');
const refresh = readYamlField(yaml, 'refresh_token');
if (!refresh || !readYamlField(yaml, 'access_token')) {
  error('EVENHUB_CREDENTIALS_B64 does not decode to a valid credentials.yaml (missing tokens).');
  process.exit(1);
}

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
