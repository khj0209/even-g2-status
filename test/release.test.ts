import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs helper without type declarations
import { checkVersions, decodePng, jwtExpiry, notesFromCommits, readYamlField, truncateNotes, validateIcon } from '../scripts/release-lib.mjs';
import { deflateSync } from 'node:zlib';

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
    expect(notesFromCommits(['Initial commit', 'Add x'], '0.2.0')).toBe('- Add x');
  });

  it('reads tokens the way the CLI writes them (js-yaml folded style)', () => {
    const long = 'eyJ' + 'a'.repeat(200) + '.eyJ' + 'b'.repeat(100) + '.sig';
    const folded = `email: me@example.com\nrole: 1\naccess_token: >-\n  ${long}\nrefresh_token: >-\n  ${long}x\n`;
    expect(readYamlField(folded, 'access_token')).toBe(long);
    expect(readYamlField(folded, 'refresh_token')).toBe(long + 'x');
    expect(readYamlField('not: [valid', 'x')).toBeNull();
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

  it('warns when the refresh token expires within 2 days, not before', () => {
    const now = Math.floor(Date.now() / 1000);
    const soon = run(`access_token: a\nrefresh_token: ${jwt(now + 36 * 3600)}\n`);
    expect(soon.status).toBe(0);
    expect(soon.stderr).toMatch(/expires in 1 day/);
    const fine = run(`access_token: a\nrefresh_token: ${jwt(now + 3 * 86400)}\n`);
    expect(fine.status).toBe(0);
    expect(fine.stderr).not.toMatch(/expires in/);
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
    const r = setup('access_token: x\nrefresh_token: a\n', 'access_token: x\nrefresh_token: a\n');
    expect(r.status).toBe(0);
    expect(r.args).toBeNull();
  });

  it('ignores formatting differences when the tokens are the same', () => {
    const r = setup('email: me@example.com\naccess_token: "x"\nrefresh_token: "a"\n', 'refresh_token: a\naccess_token: x\n');
    expect(r.status).toBe(0);
    expect(r.args).toBeNull();
  });

  it('saves when the stored secret cannot be parsed (safe default)', () => {
    const r = setup('access_token: x\nrefresh_token: a\n', 'garbage');
    expect(r.status).toBe(0);
    expect(r.args).not.toBeNull();
  });

  it('writes rotated tokens back via stdin, never argv', () => {
    const r = setup('access_token: x2\nrefresh_token: NEW\n', 'access_token: x\nrefresh_token: old\n');
    expect(r.status).toBe(0);
    expect(r.args!.trim()).toBe('secret set EVENHUB_CREDENTIALS_B64 --repo me/repo');
    expect(Buffer.from(r.stdin!, 'base64').toString()).toBe('access_token: x2\nrefresh_token: NEW\n');
  });

  it('fails loudly if tokens rotated but no writer token is configured', () => {
    const r = setup('access_token: x2\nrefresh_token: NEW\n', 'access_token: x\nrefresh_token: old\n', false);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('EVENHUB_SECRET_WRITER_TOKEN');
  });

  it('detects rotated tokens in the folded format the CLI actually writes', () => {
    const tok = (t: string) => 'eyJ' + t.repeat(120) + '.eyJ' + t.repeat(80) + '.sig';
    const cli = (a: string, r: string) => `email: me@example.com\naccess_token: >-\n  ${a}\nrefresh_token: >-\n  ${r}\n`;
    const same = setup(cli(tok('a'), tok('b')), cli(tok('a'), tok('b')));
    expect(same.args).toBeNull();
    const rotated = setup(cli(tok('c'), tok('d')), cli(tok('a'), tok('b')));
    expect(rotated.status).toBe(0);
    expect(rotated.args).not.toBeNull();
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

describe('store icon validation (mirrors evenhub create --icon)', () => {
  /** Build a 24x24 RGBA PNG; `pixel(x, y)` returns [r, g, b, a]. */
  function png(pixel: (x: number, y: number) => number[], filter = 0): Buffer {
    const rows: number[] = [];
    for (let y = 0; y < 24; y++) {
      rows.push(filter);
      const line = Array.from({ length: 24 }, (_, x) => pixel(x, y)).flat();
      // Filter 1 (Sub): store the difference from the pixel to the left.
      rows.push(...line.map((v, i) => (filter === 1 && i >= 4 ? (v - line[i - 4] + 256) & 255 : v)));
    }
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)]); // CRC not checked by our decoder
    };
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(24, 0); ihdr.writeUInt32BE(24, 4); ihdr[8] = 8; ihdr[9] = 6;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0)),
    ]);
  }
  const INK = [0xf4, 0xf4, 0xf4, 255];
  const CLEAR = [0, 0, 0, 0];

  it('accepts the committed store icon', () => {
    expect(validateIcon(decodePng(readFileSync(join(root, 'store/icon.png'))))).toEqual([]);
  });

  it('accepts 2x2-aligned ink on transparency, with any PNG filter', () => {
    const ok = (x: number, y: number) => (x >= 2 && x < 6 && y >= 4 && y < 6 ? INK : CLEAR);
    expect(validateIcon(decodePng(png(ok)))).toEqual([]);
    expect(validateIcon(decodePng(png(ok, 1)))).toEqual([]);
  });

  it('rejects wrong colours, partial alpha and broken 2x2 blocks', () => {
    expect(validateIcon(decodePng(png(() => [0, 0, 0, 255])))[0]).toMatch(/pixel \(0, 0\) is #000000/);
    expect(validateIcon(decodePng(png((x, y) => (x < 2 && y < 2 ? [0xf4, 0xf4, 0xf4, 128] : CLEAR))))[0]).toMatch(/alpha 128/);
    expect(validateIcon(decodePng(png((x, y) => (x === 1 && y < 2 ? INK : CLEAR))))[0]).toMatch(/2x2 block/);
    expect(validateIcon(decodePng(png((x, y) => (x >= 1 && x < 3 && y < 2 ? INK : CLEAR))))).toEqual([]); // odd offset is fine if the block is whole
  });
});
