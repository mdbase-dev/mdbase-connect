import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

const exec = promisify(execFile);
const checker = fileURLToPath(new URL('../check-release-version.mjs', import.meta.url));
const source = await readFile(checker, 'utf8');
const packagePaths = JSON.parse(source.match(/const packagePaths = (\[[\s\S]*?\]);/)[1]);
const version = '0.1.0-beta.96';
const lockPaths = ['Cargo.lock', 'deploy/docker/Cargo.lock.hosted-provider'];
const lock = (value) => `[[package]]\nname = "mdbase-connect-hosted-provider"\nversion = "${value}"\n\n[[package]]\nname = "unrelated-library"\nversion = "1.2.3"\n`;

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), 'mdbase-release-version-'));
  async function put(path, text) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  try {
    for (const path of packagePaths) await put(path, JSON.stringify({ version }));
    await put('Cargo.toml', `[workspace]\nmembers = ["crates/provider", "crates/adapter"]\n[workspace.package]\nversion = "${version}"\n`);
    await put('crates/provider/Cargo.toml', '[package]\nname = "mdbase-connect-hosted-provider"\nversion.workspace = true\n');
    await put('crates/adapter/Cargo.toml', '[package]\nname = "mdbase-connect-testbed-adapter"\nversion = "0.0.0"\n');
    await put('services/mcp/src/mcp.ts', `const info = { version: "${version}" };\n`);
    for (const path of lockPaths) await put(path, `${lock(version)}\n[[package]]\nname = "mdbase-connect-testbed-adapter"\nversion = "0.0.0"\n`);
    await run(root, put);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('release version validates both locks without changing external dependency versions', async () => {
  await fixture(async (cwd) => {
    const { stdout } = await exec(process.execPath, [checker], { cwd });
    assert.match(stdout, /Release version 0.1.0-beta.96 is consistent/);
  });
});

for (const path of lockPaths) {
  test(`release version refuses stale workspace versions in ${path}`, async () => {
    await fixture(async (cwd, put) => {
      await put(path, lock('0.1.0-beta.95'));
      await assert.rejects(exec(process.execPath, [checker], { cwd }), error =>
        error.code === 1 && error.stderr.includes(`${path}: mdbase-connect-hosted-provider has 0.1.0-beta.95`));
    });
  });
}
