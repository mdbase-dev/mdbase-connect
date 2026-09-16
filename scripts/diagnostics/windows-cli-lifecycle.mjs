// Real CLI + Task Scheduler on a disposable Windows runner. Never run on a user's machine.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const binary = resolve(process.argv[2]);
const options = { timeout: 30_000, windowsHide: true, env: { ...process.env } };
delete options.env.MDBASE_CONNECT_HOME;
delete options.env.MDBASE_CONNECT_SOCKET;
const report = { results: [], passed: false };
let ownsTask = false;
async function cli(command) {
  const result = await exec(binary, ['--json', 'connect', 'daemon', command], options);
  report.results.push({ command, ...result });
  // Match Electron: parse ALL stdout, not the last line or first JSON-looking substring.
  const value = JSON.parse(result.stdout);
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value;
}
async function running(expected) {
  for (let i = 0; i < 30; i++) {
    if ((await cli('status')).running === expected) return;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert.fail(`Daemon did not reach running=${expected}`);
}
try {
  const existing = await exec('schtasks', ['/Query', '/TN', 'mdbase connect'], options).then(() => true, error => {
    if (error.code !== 1) throw error;
    return false;
  });
  assert.equal(existing, false, 'Refusing to replace an existing task');
  assert.equal((await cli('status')).installed, false);
  ownsTask = true; // Installation can succeed even if its stdout cannot be parsed.
  assert.equal((await cli('install')).installed, true);
  await running(true);
  // Reconciliation replaces an installed runtime, exercising stop/create/run output together.
  assert.equal((await cli('install')).installed, true);
  await running(true);
  assert.equal((await cli('stop')).stopped, true);
  await running(false);
  assert.equal((await cli('start')).started, true);
  await running(true);
  assert.equal((await cli('restart')).restarted, true);
  await running(true);
  await cli('stop');
  assert.equal((await cli('uninstall')).installed, false);
  assert.equal((await cli('status')).installed, false);
  report.passed = true;
} catch (error) {
  report.error = { message: error.message, stdout: error.stdout, stderr: error.stderr };
  throw error;
} finally {
  if (ownsTask) {
    await exec('schtasks', ['/End', '/TN', 'mdbase connect'], options).catch(() => {});
    await exec('schtasks', ['/Delete', '/F', '/TN', 'mdbase connect'], options).catch(() => {});
  }
  await mkdir('.artifacts/issue428', { recursive: true });
  await writeFile('.artifacts/issue428/cli-contract.json', JSON.stringify(report, null, 2));
}
