// Pure helpers used by the release scripts (unit-tested in test/release.test.ts).

const SEMVER = /^\d+\.\d+\.\d+$/;

/** Ensure the git tag, package.json and app.json all agree on the version. */
export function checkVersions({ tag, pkgVersion, appVersion }) {
  const errors = [];
  if (!SEMVER.test(appVersion)) errors.push(`app.json version "${appVersion}" must be x.y.z`);
  if (pkgVersion !== appVersion) errors.push(`package.json (${pkgVersion}) and app.json (${appVersion}) versions differ`);
  if (tag !== undefined && tag !== '' && tag !== `v${appVersion}`) {
    errors.push(`tag "${tag}" does not match app.json version (expected v${appVersion})`);
  }
  return errors;
}

/** Even Hub caps changelogs at 500 Unicode code points. */
export function truncateNotes(text, max = 500) {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join('');
  return chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** Build release notes from commit subjects, skipping version-bump noise. */
export function notesFromCommits(subjects, version) {
  const lines = subjects
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !/^v?\d+\.\d+\.\d+$/.test(s) && !/^(chore\(release\)|release)\b/i.test(s))
    .map((s) => `- ${s}`);
  return lines.length ? lines.join('\n') : `G2 Status ${version}`;
}

/** Read a field from the CLI's simple credentials.yaml without a YAML dependency. */
export function readYamlField(yaml, key) {
  const m = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(yaml);
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : null;
}

/** Seconds-since-epoch `exp` claim of a JWT, or null if it isn't one. */
export function jwtExpiry(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
