import yaml from 'js-yaml';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
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
    .filter((s) => !/^v?\d+\.\d+\.\d+$/.test(s) && !/^(chore\(release\)|release)\b/i.test(s) && !/^initial commit$/i.test(s))
    .map((s) => `- ${s}`);
  return lines.length ? lines.join('\n') : `G2 Status ${version}`;
}

/**
 * Read a field from the CLI's credentials.yaml. Uses js-yaml, the same library the
 * CLI writes it with: long tokens are dumped in folded style (`key: >-` with the
 * value on the next line), so a line-based regex is not enough.
 */
export function readYamlField(text, key) {
  try {
    const doc = yaml.load(text);
    const v = doc && typeof doc === 'object' ? doc[key] : undefined;
    return v === undefined || v === null ? null : String(v);
  } catch {
    return null;
  }
}

/** Decoded JWT payload, or null if the token isn't a JWT. */
export function jwtClaims(token) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}

/** Seconds-since-epoch `exp` claim of a JWT, or null if it isn't one. */
export function jwtExpiry(token) {
  const exp = jwtClaims(token)?.exp;
  return typeof exp === 'number' ? exp : null;
}

/**
 * Decode an 8-bit, non-interlaced PNG into RGBA pixels (enough for store icons).
 * Returns { width, height, rgba } or throws with a readable message.
 */
export function decodePng(buf) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 33 || sig.some((b, i) => buf[i] !== b)) throw new Error('not a PNG file');
  let pos = 8;
  let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
  let palette = null, trns = null;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      depth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'PLTE') palette = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (depth !== 8 || interlace !== 0) throw new Error('re-export the icon as an 8-bit, non-interlaced PNG');
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) throw new Error(`unsupported PNG color type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? out[y * stride + x - channels] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels] : 0;
      let v;
      if (filter === 0) v = cur;
      else if (filter === 1) v = cur + a;
      else if (filter === 2) v = cur + b;
      else if (filter === 3) v = cur + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = cur + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad PNG filter ${filter}`);
      out[y * stride + x] = v & 255;
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const s = out.subarray(i * channels, i * channels + channels);
    let r, g, b, al = 255;
    if (colorType === 0) { r = g = b = s[0]; if (trns && trns.readUInt16BE(0) === s[0]) al = 0; }
    else if (colorType === 4) { r = g = b = s[0]; al = s[1]; }
    else if (colorType === 2) { [r, g, b] = s; }
    else if (colorType === 6) { [r, g, b, al] = s; }
    else { const k = s[0]; r = palette[k * 3]; g = palette[k * 3 + 1]; b = palette[k * 3 + 2]; al = trns && k < trns.length ? trns[k] : 255; }
    rgba.set([r, g, b, al], i * 4);
  }
  return { width, height, rgba };
}

/**
 * Even Hub store icon rules (mirrors `evenhub create --icon` validation):
 * 24x24; every pixel fully transparent or opaque #F4F4F4; visible pixels form
 * complete 2x2 blocks scanning from the top-left. Returns a list of errors.
 */
export function validateIcon({ width, height, rgba }) {
  if (width !== 24 || height !== 24) return [`icon must be 24x24 (got ${width}x${height})`];
  const vis = new Uint8Array(576);
  for (let i = 0; i < 576; i++) {
    const [r, g, b, a] = rgba.subarray(i * 4, i * 4 + 4);
    if (a === 0) continue;
    if (a !== 255 || r !== 0xf4 || g !== 0xf4 || b !== 0xf4) {
      const hex = [r, g, b].map((v) => v.toString(16).padStart(2, '0').toUpperCase()).join('');
      return [`pixel (${i % 24}, ${Math.floor(i / 24)}) is #${hex}${a === 255 ? '' : ` alpha ${a}`}; visible pixels must be opaque #F4F4F4, others fully transparent`];
    }
    vis[i] = 1;
  }
  const used = new Uint8Array(576);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const p = y * 24 + x;
      if (!vis[p] || used[p]) continue;
      if (x === 23 || y === 23 || !vis[p + 1] || !vis[p + 24] || !vis[p + 25]) {
        return [`pixel (${x}, ${y}) must start a complete 2x2 block (draw on a 12x12 grid scaled 2x)`];
      }
      used[p] = used[p + 1] = used[p + 24] = used[p + 25] = 1;
    }
  }
  return [];
}

// ---------------------------------------------------------------- CI session cache
//
// The Even Hub CLI rotates its refresh token on every refresh, so CI must keep
// the newest credentials between runs. They are stored in the GitHub Actions
// cache, encrypted (AES-256-GCM) with a key derived from the
// EVENHUB_CREDENTIALS_B64 secret: the repository is public and caches can be
// restored by fork pull requests, which never see secrets.

/** Encryption key for the cached session, derived from the seed secret. */
export function sessionKey(seedB64) {
  return crypto.createHash('sha256').update(`g2status-evenhub-session:${seedB64.trim()}`).digest();
}

export function encryptSession(yamlText, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(yamlText, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from('G2S1'), iv, cipher.getAuthTag(), body]);
}

/** Returns the YAML text, or null if the blob is missing, corrupt, or from another seed. */
export function decryptSession(blob, key) {
  try {
    if (!blob || blob.length < 4 + 12 + 16 || blob.subarray(0, 4).toString() !== 'G2S1') return null;
    const iv = blob.subarray(4, 16);
    const tag = blob.subarray(16, 32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(blob.subarray(32)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Pick the newer of the seed (secret) and cached credentials by refresh-token
 * expiry: a fresh `ci-login` beats an old cache, a rotated cache beats the seed.
 */
export function newerCredentials(seedYaml, cachedYaml) {
  if (!cachedYaml || !readYamlField(cachedYaml, 'refresh_token')) return { yaml: seedYaml, source: 'secret' };
  const seedExp = jwtExpiry(readYamlField(seedYaml, 'refresh_token')) ?? 0;
  const cacheExp = jwtExpiry(readYamlField(cachedYaml, 'refresh_token')) ?? 0;
  return cacheExp >= seedExp ? { yaml: cachedYaml, source: 'cache' } : { yaml: seedYaml, source: 'secret' };
}
