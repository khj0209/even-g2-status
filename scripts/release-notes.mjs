#!/usr/bin/env node
// Usage: node scripts/release-notes.mjs <tag-or-version> <out-file>
//
// Uses the annotated tag message if there is one (git tag -a v1.2.0 -m "..."),
// otherwise the commit subjects since the previous tag. Capped at 500 characters
// (the Even Hub changelog limit).
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { notesFromCommits, truncateNotes } from './release-lib.mjs';

const [ref, out] = process.argv.slice(2);
if (!ref || !out) {
  console.error('usage: release-notes.mjs <tag-or-version> <out-file>');
  process.exit(1);
}
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

const version = ref.replace(/^v/, '');
const isAnnotated = git('cat-file', '-t', ref) === 'tag';
let notes = isAnnotated ? git('tag', '-l', '--format=%(contents:body)', ref) || git('tag', '-l', '--format=%(contents:subject)', ref) : '';
// `npm version` creates annotated tags whose message is just the version number.
if (/^v?\d+\.\d+\.\d+$/.test(notes.trim())) notes = '';
if (!notes) {
  const head = git('rev-parse', '--verify', '--quiet', ref) ? ref : 'HEAD';
  const prev = git('describe', '--tags', '--abbrev=0', `${head}^`);
  const range = prev ? `${prev}..${head}` : head;
  notes = notesFromCommits(git('log', '--no-merges', '--format=%s', range).split('\n'), version);
}
writeFileSync(out, truncateNotes(notes) + '\n');
console.log(truncateNotes(notes));
