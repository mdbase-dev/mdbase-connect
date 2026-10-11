// Diagnostic only: repeat start/stop of the installed task, running each `stop`
// under cdb so a heap-corruption failure is caught with every thread's stack.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const binary = resolve(process.argv[2]);
const cycles = Number(process.argv[3] ?? 150);
const out = resolve('.artifacts/heap');
const cdb = 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';
const symbols = `srv*D:\\sym*https://msdl.microsoft.com/download/symbols;${resolve('target/debug')}`;
const env = { ...process.env };
delete env.MDBASE_CONNECT_HOME;
delete env.MDBASE_CONNECT_SOCKET;
await mkdir(out, { recursive: true });
const cli = (command) => exec(binary, ['--json', 'connect', 'daemon', command], { env, timeout: 60_000 }).then(
  (r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function untilRunning(expected) {
  for (let i = 0; i < 40; i++) {
    const r = await cli('status');
    try { if (JSON.parse(r.stdout).running === expected) return true; } catch {}
    await sleep(250);
  }
  return false;
}

let crashes = 0;
assert.equal((await cli('install')).code, 0);
for (let i = 1; i <= cycles; i++) {
  if (!(await untilRunning(true))) { console.log(`c${i}: daemon did not start`); await cli('start'); continue; }
  const dump = `${out}\\stop-${i}.dmp`;
  const handler = `.echo CRASH; .lines -e; .ecxr; kP 100; ~*kn 80; .dump /ma ${dump}; q`;
  const args = ['-g', '-G', '-y', symbols, '-c',
    `sxe -c "${handler}" c0000374; sxe -c "${handler}" av; sxe -c "${handler}" bpe; g`,
    binary, '--json', 'connect', 'daemon', 'stop'];
  const direct = process.env.DIAG_CDB === '0';
  const r = direct
    ? await exec(binary, ['--json', 'connect', 'daemon', 'stop'], { env, timeout: 60_000 }).then((v) => ({ ...v, code: 0 }), (e) => e)
    : await exec(cdb, args, { env, timeout: 300_000, maxBuffer: 64 << 20 }).then((v) => v, (e) => e);
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (direct ? r.code !== 0 : /CRASH|c0000374|Critical error detected/i.test(text)) {
    if (direct) console.log(`c${i}: stop exited ${r.code} (0x${(Number(r.code) >>> 0).toString(16)})`);
    crashes++;
    await writeFile(`${out}\\stop-${i}.txt`, text);
    console.log(`c${i}: CRASH captured`);
    console.log(text.split('\n').slice(-400).join('\n'));
  }
  await untilRunning(false);
  await cli('start');
  if (i % 25 === 0) console.log(`cycle ${i}, crashes ${crashes}`);
}
await cli('uninstall');
console.log(`crashes: ${crashes} / ${cycles}`);
