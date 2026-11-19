#!/usr/bin/env node
// Prints your local Even Hub CLI credentials as base64 for the
// EVENHUB_CREDENTIALS_B64 GitHub secret. Run `npx evenhub login` first.
//
//   npm run credentials                                   # print
//   npm run credentials --silent | gh secret set EVENHUB_CREDENTIALS_B64   # set directly
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const base =
  process.env.XDG_CONFIG_HOME ||
  (process.platform === 'win32' ? process.env.APPDATA : null) ||
  join(homedir(), '.config');
const file = join(base, 'evenhub', 'credentials.yaml');
if (!existsSync(file)) {
  console.error(`No credentials at ${file}. Run \`npx evenhub login\` first.`);
  process.exit(1);
}
process.stdout.write(readFileSync(file).toString('base64') + '\n');
if (process.stderr.isTTY) {
  console.error('\nCopy the line above into GitHub → Settings → Secrets and variables → Actions → EVENHUB_CREDENTIALS_B64.');
  console.error('Treat it like a password: it grants upload access to your Even Hub account.');
}
