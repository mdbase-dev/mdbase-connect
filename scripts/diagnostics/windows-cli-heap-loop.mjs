// Diagnostic only: loop the CLI service lifecycle on a disposable Windows runner,
// recording each command's exit code and duration. A command that runs longer
// than HANG_MS gets every mdbase.exe process dumped with cdb before it is killed.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const exec = promisify(execFile);
assert.equal(process.platform, 'win32');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const binary = resolve(process.argv[2]);
const iterations = Number(process.argv[3] ?? 60);
const out = resolve('.artifacts/heap');
const cdb = 'C:\\Program Files (x86)\\Windows Kits\\10\\Debuggers\\x64\\cdb.exe';
const HANG_MS = 20_000;
const KILL_MS = 60_000;
const env = { ...process.env };
delete env.MDBASE_CONNECT_HOME;
delete env.MDBASE_CONNECT_SOCKET;
await mkdir(out, { recursive: true });

async function pids() {
  const { stdout } = await exec('tasklist', ['/FI', 'IMAGENAME eq mdbase.exe', '/FO', 'CSV', '/NH']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').map((line) => line.split('","')[1]).filter(Boolean).map(Number);
}

async function dumpAll(tag) {
  for (const pid of await pids()) {
    const file = `${out}\\hang-${tag}-${pid}.dmp`;
    await exec(cdb, ['-p', String(pid), '-pv', '-c', `.dump /ma ${file}; q`], { timeout: 60_000 }).catch((error) => console.log(`dump ${pid} failed: ${error.message}`));
    console.log(`dumped ${pid} -> ${file}`);
  }
}

function run(command, tag) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(binary, ['--json', 'connect', 'daemon', command], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const hang = setTimeout(() => {
      console.log(`${tag} ${command}: still running after ${HANG_MS} ms (pid ${child.pid}); dumping`);
      void dumpAll(`${tag}-${command}`);
    }, HANG_MS);
    const kill = setTimeout(() => child.kill(), KILL_MS);
    child.on('exit', (code, signal) => {
      clearTimeout(hang);
      clearTimeout(kill);
      done({ command, code, signal, ms: Date.now() - started, stdout, stderr });
    });
  });
}

const log = [];
let failures = 0;
const steps = ['status', 'install', 'status', 'install', 'status', 'stop', 'status', 'start', 'status', 'restart', 'status', 'stop', 'uninstall', 'status'];
for (let i = 1; i <= iterations; i++) {
  const results = [];
  for (const step of steps) {
    const result = await run(step, `i${i}`);
    results.push(result);
    const bad = result.code !== 0;
    if (bad || result.ms > 10_000) {
      console.log(`i${i} ${step}: code=${result.code} (0x${(result.code >>> 0).toString(16)}) signal=${result.signal} ms=${result.ms} stdout=${JSON.stringify(result.stdout.slice(0, 300))} stderr=${JSON.stringify(result.stderr.slice(0, 300))}`);
    }
    if (bad) { failures++; break; }
    // Let the scheduled task start or stop, as the contract test's status polling does.
    if (['install', 'start', 'restart', 'stop'].includes(step)) await new Promise((r) => setTimeout(r, 1500));
  }
  log.push({ iteration: i, results });
  await exec(binary, ['--json', 'connect', 'daemon', 'uninstall'], { env, timeout: 30_000 }).catch(() => {});
  await exec('schtasks', ['/End', '/TN', 'mdbase connect']).catch(() => {});
  await exec('schtasks', ['/Delete', '/F', '/TN', 'mdbase connect']).catch(() => {});
  await exec('taskkill', ['/F', '/IM', 'mdbase.exe']).catch(() => {});
  console.log(`iteration ${i} done (${failures} failures so far)`);
}
await writeFile(`${out}\\log.json`, JSON.stringify(log, null, 2));
console.log(`failures: ${failures} / ${iterations}`);
