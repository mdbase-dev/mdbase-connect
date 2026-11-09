import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { githubReleaseAsset } from '../lib/github-release-download.mjs';

export const workerTools = [
  { repository: 'wasm-bindgen/wasm-bindgen', id: 587769529, name: 'wasm-bindgen-0.2.129-x86_64-unknown-linux-musl.tar.gz', sha256: '82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e', binary: 'wasm-bindgen', variable: 'WASM_BINDGEN_BIN' },
  { repository: 'WebAssembly/binaryen', id: 512132895, name: 'binaryen-version_132-x86_64-linux.tar.gz', sha256: '195ddc94f9bc89f45abdabb0b9eea86023d727ba90eac8b35b80f2544fc30572', binary: 'bin/wasm-opt', variable: 'WASM_OPT_BIN' }
];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function prefetchWorkerTools(root, directory, { token, fetchImpl = fetch, delays, run = execFileSync, platform = process.platform, arch = process.arch, tools = workerTools } = {}) {
  assert(platform === 'linux' && arch === 'x64', 'Pinned worker-build 0.8.7 tool archives support Linux x64 runners');
  const lock = await readFile(join(root, 'runtime/deploy/cloudflare-do/Cargo.lock'), 'utf8');
  assert.match(lock, /\[\[package\]\]\r?\nname = "wasm-bindgen"\r?\nversion = "0\.2\.129"\r?\n/, 'Requalify worker-build tools after the locked wasm-bindgen version changes');
  await mkdir(directory, { recursive: true });
  const environment = {};
  for (const tool of tools) {
    const archive = join(directory, tool.name);
    let bytes;
    try { bytes = await readFile(archive); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!bytes || sha256(bytes) !== tool.sha256) {
      bytes = await githubReleaseAsset(tool.repository, tool, { token, fetchImpl, delays });
      assert.equal(sha256(bytes), tool.sha256, 'Worker tool archive checksum mismatch');
      await writeFile(archive, bytes);
    }
    const extracted = join(directory, tool.variable);
    await mkdir(extracted, { recursive: true });
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', extracted], { stdio: 'pipe' });
    environment[tool.variable] = join(extracted, tool.binary);
  }
  return environment;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [root = '.', directory = join(process.env.RUNNER_TEMP, 'verified-worker-tools')] = process.argv.slice(2);
  const environment = await prefetchWorkerTools(resolve(root), resolve(directory), { token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
  await appendFile(process.env.GITHUB_ENV, Object.entries(environment).map(([name, value]) => `${name}=${value}\n`).join(''));
}
