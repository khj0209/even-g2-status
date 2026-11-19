#!/usr/bin/env node
// Creates a SEPARATE Even Hub login session just for GitHub Actions and hands it
// to the EVENHUB_CREDENTIALS_B64 secret.
//
//   npm run ci-login            # log in, print the base64 secret value
//   npm run ci-login -- --set   # log in and store it with `gh secret set` directly
//
// Why separate: the CLI rotates the refresh token on every refresh. Two places
// sharing one credentials file (e.g. your machine / another tool and CI) would
// keep invalidating each other. This logs in under a temporary config dir, so
// ~/.config/evenhub/credentials.yaml (used by your local CLI and other tools) is
// never touched, and deletes the temporary copy afterwards — the session then
// lives only in the GitHub secret, which the Release workflow keeps up to date.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const set = args.includes('--set');
const passthrough = args.filter((a) => a !== '--set'); // e.g. -e you@example.com

const cli = fileURLToPath(new URL('../node_modules/@evenrealities/evenhub-cli/main.js', import.meta.url));
if (!existsSync(cli)) {
  console.error('Even Hub CLI not installed. Run `npm install` first.');
  process.exit(1);
}

const home = mkdtempSync(join(tmpdir(), 'evenhub-ci-'));
try {
  console.error('GitHub Actions 전용 세션으로 로그인합니다 (기존 ~/.config/evenhub 는 건드리지 않음).\n');
  const login = spawnSync(process.execPath, [cli, 'login', ...passthrough], {
    stdio: 'inherit',
    env: { ...process.env, XDG_CONFIG_HOME: home },
  });
  if (login.status !== 0) process.exit(login.status ?? 1);

  const file = join(home, 'evenhub', 'credentials.yaml');
  if (!existsSync(file)) {
    console.error('Login finished but no credentials file was written.');
    process.exit(1);
  }
  const value = readFileSync(file).toString('base64');

  if (set) {
    const gh = spawnSync('gh', ['secret', 'set', 'EVENHUB_CREDENTIALS_B64'], { input: value, stdio: ['pipe', 'inherit', 'inherit'] });
    if (gh.error || gh.status !== 0) {
      console.error('\n`gh secret set` failed. Run without --set and paste the value manually.');
      process.exit(1);
    }
    console.error('\nEVENHUB_CREDENTIALS_B64 secret updated.');
  } else {
    process.stdout.write(value + '\n');
    console.error('\n위 한 줄을 GitHub → Settings → Secrets and variables → Actions → EVENHUB_CREDENTIALS_B64 에 넣으세요.');
    console.error('비밀번호처럼 다루세요: Even Hub 계정에 업로드할 수 있는 권한입니다.');
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
