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
    expect(r.stderr).toContain('npm run ci-login');
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

describe('scripts/save-credentials.sh', () => {
  /** Fake `gh` that records argv and stdin. */
  function setup(fileContent: string | null, secretContent: string, withToken = true) {
    const dir = mkdtempSync(join(tmpdir(), 'save-'));
    if (fileContent !== null) {
      execFileSync('mkdir', ['-p', join(dir, 'evenhub')]);
      writeFileSync(join(dir, 'evenhub', 'credentials.yaml'), fileContent);
    }
    const gh = join(dir, 'gh');
    writeFileSync(gh, `#!/usr/bin/env bash\necho "$*" > "${dir}/gh.args"\ncat > "${dir}/gh.stdin"\n`);
    chmodSync(gh, 0o755);
    const r = spawnSync('bash', ['scripts/save-credentials.sh'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_ACTIONS: '',
        GITHUB_REPOSITORY: 'me/repo',
        XDG_CONFIG_HOME: dir,
        GH_BIN: gh,
        GH_TOKEN: withToken ? 'pat' : '',
        EVENHUB_CREDENTIALS_B64: Buffer.from(secretContent).toString('base64'),
      },
    });
    const read = (f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null);
    return { ...r, args: read('gh.args'), stdin: read('gh.stdin') };
  }

  it('does nothing when the tokens were not refreshed', () => {
    const r = setup('refresh_token: a\n', 'refresh_token: a\n');
    expect(r.status).toBe(0);
    expect(r.args).toBeNull();
  });

  it('writes rotated tokens back via stdin, never argv', () => {
    const r = setup('refresh_token: NEW\n', 'refresh_token: old\n');
    expect(r.status).toBe(0);
    expect(r.args!.trim()).toBe('secret set EVENHUB_CREDENTIALS_B64 --repo me/repo');
    expect(Buffer.from(r.stdin!, 'base64').toString()).toBe('refresh_token: NEW\n');
  });

  it('fails loudly if tokens rotated but no writer token is configured', () => {
    const r = setup('refresh_token: NEW\n', 'refresh_token: old\n', false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('EVENHUB_SECRET_WRITER_TOKEN');
  });

  it('is a no-op without a credentials file', () => {
    expect(setup(null, 'x').status).toBe(0);
  });
});

describe('scripts/ci-login.mjs', () => {
  it('logs in under a temporary config dir and never touches the real one', () => {
    // Fake CLI in place of node_modules/@evenrealities/evenhub-cli/main.js is not possible
    // without editing node_modules, so run the script against a copied tree.
    const tree = mkdtempSync(join(tmpdir(), 'cilogin-'));
    execFileSync('mkdir', ['-p', join(tree, 'scripts'), join(tree, 'node_modules/@evenrealities/evenhub-cli')]);
    writeFileSync(join(tree, 'scripts/ci-login.mjs'), readFileSync(join(root, 'scripts/ci-login.mjs')));
    writeFileSync(
      join(tree, 'node_modules/@evenrealities/evenhub-cli/main.js'),
      `const fs=require('fs'),p=require('path');const d=p.join(process.env.XDG_CONFIG_HOME,'evenhub');
       fs.mkdirSync(d,{recursive:true});fs.writeFileSync(p.join(d,'credentials.yaml'),'refresh_token: ci-only\\n');
       fs.writeFileSync(process.env.SPY,process.env.XDG_CONFIG_HOME+' '+process.argv.slice(2).join(' '));`,
    );
    writeFileSync(join(tree, 'node_modules/@evenrealities/evenhub-cli/package.json'), '{"type":"commonjs"}');
    const realHome = mkdtempSync(join(tmpdir(), 'realcfg-'));
    const spy = join(tree, 'spy');
    const r = spawnSync('node', ['scripts/ci-login.mjs', '-e', 'me@example.com'], {
      cwd: tree,
      encoding: 'utf8',
      env: { ...process.env, XDG_CONFIG_HOME: realHome, SPY: spy },
    });
    expect(r.status).toBe(0);
    expect(Buffer.from(r.stdout.trim(), 'base64').toString()).toBe('refresh_token: ci-only\n');
    const [usedHome, ...argv] = readFileSync(spy, 'utf8').split(' ');
    expect(argv).toEqual(['login', '-e', 'me@example.com']);
    expect(usedHome).not.toBe(realHome);
    expect(existsSync(usedHome)).toBe(false); // temporary copy removed
    expect(existsSync(join(realHome, 'evenhub'))).toBe(false); // real config untouched
  });
});
