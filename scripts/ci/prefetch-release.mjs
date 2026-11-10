// Runs before dependency installation: built-in Node modules only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubReleaseAsset, publicBytes } from '../lib/github-release-download.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const api = 'https://api.github.com/repos/';
export function electronPlan(version, cacheRoot, platform = process.platform, arch = process.arch) {
  assert.match(version, /^\d+\.\d+\.\d+$/);
  const tag = `v${version}`;
  // @electron/get 5.1.0 Cache.getCacheDirectory hashes the URL's directory,
  // without its final slash. electron/install.js honours electron_config_cache.
  const directory = sha256(`https://github.com/electron/electron/releases/download/${tag}`);
  return { version, tag, directory: join(cacheRoot, directory), name: `electron-${tag}-${platform}-${arch}.zip` };
}

export function lockedElectronVersion(lock) {
  lock = lock.replaceAll('\r\n', '\n');
  const importer = lock.split('\n  apps/desktop:\n')[1]?.split(/\n  \S/)[0];
  const entry = /^      electron:\n        specifier: ([^\n]+)\n        version: (\d+\.\d+\.\d+)(?:\([^\n]*\))?\n/m.exec(importer ?? '');
  assert(entry, 'Exact locked Electron dependency required');
  const version = entry[2];
  const snapshot = lock.split(`\n  electron@${version}(`)[1]?.split(/\n  \S/)[0];
  assert(snapshot?.includes("\n      '@electron/get': 5.1.0("),
    'Requalify Electron cache layout after dependency changes');
  return version;
}

async function cached(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function atomicWrite(path, bytes) {
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
}
function headers(token, accept) {
  assert(token, 'GitHub token required for release prefetch');
  return { authorization: `Bearer ${token}`, accept };
}
function checksum(sums, name) {
  const matches = sums.toString('utf8').split('\n').filter(line => line.endsWith(` ${name}`) || line.endsWith(`*${name}`));
  assert(matches.length === 1 && /^[a-f0-9]{64} [ *]/.test(matches[0]), 'Exact Electron checksum required');
  return matches[0].slice(0, 64);
}
export async function prefetchElectron(plan, { token, fetchImpl = fetch, delays } = {}) {
  const sumsPath = join(plan.directory, 'SHASUMS256.txt'), zipPath = join(plan.directory, plan.name);
  const [sums, zip] = await Promise.all([cached(sumsPath), cached(zipPath)]);
  if (sums && zip) {
    try { if (sha256(zip) === checksum(sums, plan.name)) return; }
    catch { /* Replace incomplete or damaged cache entries below. */ }
  }
  const repository = 'electron/electron';
  const release = JSON.parse(await publicBytes(`${api}${repository}/releases/tags/${plan.tag}`, fetchImpl, delays,
    headers(token, 'application/vnd.github+json')));
  assert(release.tag_name === plan.tag && release.draft === false, 'Exact published Electron release required');
  const download = async name => {
    const assets = release.assets.filter(asset => asset.name === name);
    assert(assets.length === 1, 'Exact Electron release asset required');
    return githubReleaseAsset(repository, assets[0], { token, fetchImpl, delays });
  };
  const newSums = await download('SHASUMS256.txt');
  const expected = checksum(newSums, plan.name);
  const newZip = await download(plan.name);
  assert.equal(sha256(newZip), expected, 'Electron archive checksum mismatch');
  await mkdir(plan.directory, { recursive: true });
  await atomicWrite(sumsPath, newSums);
  await atomicWrite(zipPath, newZip);
  // Electron's postinstall independently verifies against its npm checksums.json.
}

// Same v3.0.6 bootstrap checksums as cosign-installer at 6f9f17788090df1f26f669e9d70d6ae9567deba6
// and cloud-ops#1655; keep the installed release and trust roots unchanged.
export const cosignAssets = {
  'linux-x64': [390331694, 'c956e5dfcac53d52bcf058360d579472f0c1d2d9b69f55209e256fe7783f4c74'],
  'darwin-x64': [390332156, '4c3e7af8372d3ca3296e62fa56f23fcbb5721cc6ac1827900d398f110d7cd280'],
  'darwin-arm64': [390331960, '5fadd012ae6381a6a29ff86a7d39aa873878852f1073fc90b15995961ecfb084'],
  'win32-x64': [390332008, '9b85a88ebff2d9dd30ff4984a6f61f2cedc232dd87d81fa7f2ff3c0ed96c241c']
};
export async function installCosign(directory, { token, fetchImpl = fetch, delays, platform = process.platform, arch = process.arch } = {}) {
  const asset = cosignAssets[`${platform}-${arch}`];
  assert(asset, 'Unsupported cosign platform');
  const bytes = await githubReleaseAsset('sigstore/cosign', { id: asset[0] }, { token, fetchImpl, delays });
  assert.equal(sha256(bytes), asset[1], 'Cosign checksum mismatch');
  await mkdir(directory, { recursive: true });
  const path = join(directory, platform === 'win32' ? 'cosign.exe' : 'cosign');
  await atomicWrite(path, bytes);
  await chmod(path, 0o755);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, root = '.'] = process.argv.slice(2);
  const token = process.env.GITHUB_TOKEN;
  if (command === 'cosign') {
    const directory = join(process.env.RUNNER_TEMP, 'verified-cosign');
    await installCosign(directory, { token });
    await appendFile(process.env.GITHUB_PATH, `${directory}\n`);
  } else {
    assert(['electron-plan', 'electron-fetch'].includes(command), 'Unknown prefetch command');
    const lock = await readFile(resolve(root, 'pnpm-lock.yaml'), 'utf8');
    const version = lockedElectronVersion(lock);
    const cacheRoot = join(process.env.RUNNER_TEMP, 'electron-cache');
    const plan = electronPlan(version, cacheRoot);
    if (command === 'electron-plan') {
      await appendFile(process.env.GITHUB_OUTPUT, `version=${version}\ncache=${cacheRoot}\n`);
      await appendFile(process.env.GITHUB_ENV, `electron_config_cache=${cacheRoot}\n`);
    } else await prefetchElectron(plan, { token });
  }
}
