import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without type declarations
import { checkVersions, jwtExpiry, notesFromCommits, readYamlField, truncateNotes } from '../scripts/release-lib.mjs';

describe('release helpers', () => {
  it('checks tag / package.json / app.json agreement', () => {
    expect(checkVersions({ tag: 'v1.2.3', pkgVersion: '1.2.3', appVersion: '1.2.3' })).toEqual([]);
    expect(checkVersions({ tag: '', pkgVersion: '1.2.3', appVersion: '1.2.3' })).toEqual([]);
    expect(checkVersions({ tag: 'v1.2.4', pkgVersion: '1.2.3', appVersion: '1.2.3' })).toHaveLength(1);
    expect(checkVersions({ tag: undefined, pkgVersion: '1.2.3', appVersion: '1.2.0' })).toHaveLength(1);
    expect(checkVersions({ tag: undefined, pkgVersion: '1.2', appVersion: '1.2' })).toHaveLength(1);
  });

  it('caps notes at 500 code points (Korean counts as one)', () => {
    expect([...truncateNotes('가'.repeat(600))]).toHaveLength(500);
    expect(truncateNotes('짧은 노트')).toBe('짧은 노트');
  });

  it('builds notes from commits and drops version bumps', () => {
    expect(notesFromCommits(['Add transit widget', '0.2.0', '', 'Fix ICS parsing'], '0.2.0'))
      .toBe('- Add transit widget\n- Fix ICS parsing');
    expect(notesFromCommits(['0.2.0'], '0.2.0')).toBe('G2 Status 0.2.0');
  });

  it('reads credentials yaml and JWT expiry', () => {
    expect(readYamlField('email: a@b.c\nrefresh_token: "x.y.z"\n', 'refresh_token')).toBe('x.y.z');
    const payload = Buffer.from(JSON.stringify({ exp: 1_900_000_000 })).toString('base64url');
    expect(jwtExpiry(`h.${payload}.s`)).toBe(1_900_000_000);
    expect(jwtExpiry('opaque-token')).toBeNull();
  });
});

const root = fileURLToPath(new URL('..', import.meta.url));

/** Fake `evenhub`: logs argv, answers with exit codes from FAKE_<CMD>_EXIT. */
function fakeCli(dir: string): string {
  const bin = join(dir, 'evenhub');
  writeFileSync(
    bin,
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/calls.log"
var="FAKE_$(echo "$1" | tr a-z A-Z)_EXIT"
code=\${!var:-0}
if [ "$code" != 0 ]; then echo "{\\"ok\\":false,\\"exit\\":$code,\\"message\\":\\"fake $1 failed\\"}"; else echo '{"ok":true}'; fi
exit "$code"
`,
  );
  chmodSync(bin, 0o755);
  return bin;
}

function publish(env: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-'));
  const notes = join(dir, 'notes.md');
  writeFileSync(notes, '- change');
  const r = spawnSync('bash', ['scripts/publish.sh', 'x.ehpk', '0.1.0', notes], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '', EVENHUB_BIN: fakeCli(dir), ...env },
  });
  const log = join(dir, 'calls.log');
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
  return { code: r.status, calls, stderr: r.stderr };
}

describe('scripts/publish.sh', () => {
  it('uploads to an existing app and promotes to beta', () => {
    const r = publish({});
    expect(r.code).toBe(0);
    expect(r.calls.map((c: string) => c.split(' ')[0])).toEqual(['ls', 'upload', 'promote']);
    expect(r.calls[1]).toContain('x.ehpk --package-id com.khj0209.g2status -m - change --json');
    expect(r.calls[2]).toBe('promote 0.1.0 --to beta --package-id com.khj0209.g2status --json');
  });

  it('creates the app on first release with store assets', () => {
    const r = publish({ FAKE_LS_EXIT: '3', EVENHUB_BETA: 'false' });
    expect(r.code).toBe(0);
    expect(r.calls).toHaveLength(2);
    expect(r.calls[1]).toMatch(/^create x\.ehpk .*--name G2 Status --tagline .*--description-file store\/description\.md --icon store\/icon\.png --json$/);
  });

  it('treats an already uploaded version as success (re-runnable)', () => {
    const r = publish({ FAKE_UPLOAD_EXIT: '4' });
    expect(r.code).toBe(0);
    expect(r.calls.map((c: string) => c.split(' ')[0])).toEqual(['ls', 'upload', 'promote']);
  });

  it('fails with a re-login hint when credentials are invalid', () => {
    const r = publish({ FAKE_LS_EXIT: '2' });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('EVENHUB_CREDENTIALS_B64');
  });

  it('propagates upload failures', () => {
    const r = publish({ FAKE_UPLOAD_EXIT: '10' });
    expect(r.code).toBe(10);
    expect(r.calls).toHaveLength(2);
  });
});

describe('scripts/restore-credentials.mjs', () => {
  const jwt = (exp: number) => `h.${Buffer.from(JSON.stringify({ exp })).toString('base64url')}.s`;
  const run = (yaml: string | null) => {
    const home = mkdtempSync(join(tmpdir(), 'creds-'));
    const r = spawnSync('node', ['scripts/restore-credentials.mjs'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        XDG_CONFIG_HOME: home,
        EVENHUB_CREDENTIALS_B64: yaml === null ? '' : Buffer.from(yaml).toString('base64'),
      },
    });
    return { ...r, file: join(home, 'evenhub', 'credentials.yaml') };
  };

  it('writes a private credentials file', () => {
    const exp = Math.floor(Date.now() / 1000) + 90 * 86400;
    const yaml = `email: me@example.com\naccess_token: a\nrefresh_token: ${jwt(exp)}\n`;
    const r = run(yaml);
    expect(r.status).toBe(0);
    expect(readFileSync(r.file, 'utf8')).toBe(yaml);
    expect(statSync(r.file).mode & 0o777).toBe(0o600);
  });

  it('fails clearly when the secret is missing or the token expired', () => {
    expect(run(null).status).toBe(1);
    expect(run('foo: bar').status).toBe(1);
    const expired = run(`access_token: a\nrefresh_token: ${jwt(1_000_000)}\n`);
    expect(expired.status).toBe(2);
    expect(expired.stderr).toContain('expired');
  });

  it('warns when the refresh token expires soon', () => {
    const soon = Math.floor(Date.now() / 1000) + 3 * 86400;
    const r = run(`access_token: a\nrefresh_token: ${jwt(soon)}\n`);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/expires in [23] day/);
  });
});

describe('scripts/version.mjs', () => {
  it('passes for the committed versions', () => {
    expect(execFileSync('node', ['scripts/version.mjs', 'check'], { cwd: root, encoding: 'utf8' })).toContain('OK');
  });
});
