#!/usr/bin/env node
// After the Even Hub CLI ran in CI, encrypt the (possibly rotated) credentials
// into EVENHUB_SESSION_FILE for the Actions cache, so the next run can log in.
// The key comes from the EVENHUB_CREDENTIALS_B64 secret; see release-lib.mjs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { encryptSession, readYamlField, sessionKey } from './release-lib.mjs';

const b64 = (process.env.EVENHUB_CREDENTIALS_B64 ?? '').trim();
const creds = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'evenhub', 'credentials.yaml');
const out = process.env.EVENHUB_SESSION_FILE || '.evenhub-session/state.enc';

if (!b64 || !existsSync(creds)) {
  console.log('No Even Hub session to save.');
  process.exit(0);
}
const yaml = readFileSync(creds, 'utf8');
if (!readYamlField(yaml, 'refresh_token')) {
  console.log('Credentials file has no refresh token; not saving.');
  process.exit(0);
}
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, encryptSession(yaml, sessionKey(b64)), { mode: 0o600 });
console.log(`Saved the Even Hub session (encrypted) to ${out}.`);
