#!/usr/bin/env node
// Usage:
//   node scripts/version.mjs sync          copy package.json version into app.json (npm version hook)
//   node scripts/version.mjs check [tag]   fail if tag / package.json / app.json disagree
//   node scripts/version.mjs get           print the app.json version
import { readFileSync, writeFileSync } from 'node:fs';
import { checkVersions } from './release-lib.mjs';

const read = (f) => JSON.parse(readFileSync(f, 'utf8'));
const [cmd, tag] = process.argv.slice(2);
const pkg = read('package.json');
const app = read('app.json');

if (cmd === 'sync') {
  app.version = pkg.version;
  writeFileSync('app.json', JSON.stringify(app, null, 2) + '\n');
  console.log(`app.json version -> ${pkg.version}`);
} else if (cmd === 'check') {
  const errors = checkVersions({ tag, pkgVersion: pkg.version, appVersion: app.version });
  for (const e of errors) console.error(process.env.GITHUB_ACTIONS ? `::error::${e}` : e);
  if (errors.length) process.exit(1);
  console.log(`version ${app.version} OK`);
} else if (cmd === 'get') {
  console.log(app.version);
} else {
  console.error('usage: version.mjs sync | check [tag] | get');
  process.exit(1);
}
