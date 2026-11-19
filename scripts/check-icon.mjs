#!/usr/bin/env node
// Validate the store icon against Even Hub's rules before trying to upload.
// Usage: node scripts/check-icon.mjs [store/icon.png]
import { existsSync, readFileSync } from 'node:fs';
import { decodePng, validateIcon } from './release-lib.mjs';

const file = process.argv[2] ?? 'store/icon.png';
if (!existsSync(file)) {
  console.log(`${file} not found; Even Hub will use a placeholder icon.`);
  process.exit(0);
}
let errors;
try {
  errors = validateIcon(decodePng(readFileSync(file)));
} catch (e) {
  errors = [e.message];
}
for (const e of errors) console.error(process.env.GITHUB_ACTIONS ? `::error file=${file}::${e}` : `${file}: ${e}`);
if (errors.length) process.exit(1);
console.log(`${file} OK`);
