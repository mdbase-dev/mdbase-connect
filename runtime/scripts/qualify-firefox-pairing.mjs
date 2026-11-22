// See qualify-firefox-pairing.sh. Use new operator codes against the actual Editor.
// A consumed code with a newly issued host grant can still leave the browser unpaired.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { extname } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

assert.equal(process.env.HOME, '/tmp/home');
assert.deepEqual(Object.keys(networkInterfaces()), ['lo']);
const origin = process.argv[2];
assert.equal(new URL(origin).protocol, 'https:');
assert.equal(new URL(origin).origin, origin);
const args = ['self-host', '--origin', origin, '--collection', '/tmp/notes', '--state-dir', '/tmp/state', '--auth-dir', '/tmp/auth'];
const operator = (...command) => execFileSync('/mdbase', [...args, ...command], { encoding: 'utf8', timeout: 10000 }).trim();
mkdirSync('/tmp/notes');
writeFileSync('/tmp/notes/mdbase.yaml', 'spec_version: "0.3.0"\n');
writeFileSync('/tmp/notes/Firefox.md', '---\ntitle: Firefox fixture\n---\nSynthetic note\n');
mkdirSync('/tmp/profile');
// Opt out of WebDriver's recommended preference overrides, including permission-testing settings.
writeFileSync('/tmp/profile/user.js', 'user_pref("remote.prefs.recommended", false);\n');
const daemon = spawn('/mdbase', [...args, 'serve', '--webtransport', '127.0.0.1:0'], { stdio: ['ignore', 'pipe', 'ignore'] });
let firefox, socket;
try {
  let endpoint, pin;
  for await (const line of createInterface({ input: daemon.stdout })) {
    endpoint ??= /^WebTransport endpoint: (https:\/\/127\.0\.0\.1:\d+)$/.exec(line)?.[1];
    pin ??= /^Certificate SHA-256: ([a-f0-9]{64})$/.exec(line)?.[1];
    if (endpoint && pin) break;
  }
  assert(endpoint && pin && endpoint !== origin, 'Expected a separate loopback WebTransport endpoint');
  firefox = spawn('/usr/bin/firefox', ['--no-remote', '--profile', '/tmp/profile', '--remote-debugging-port', '9222', 'about:blank'], { stdio: 'ignore' });
  for (let i = 0; i < 200; i++) {
    const attempt = new WebSocket('ws://127.0.0.1:9222/session');
    const opened = await new Promise(resolve => {
      attempt.onopen = () => resolve(true);
      attempt.onerror = () => resolve(false);
    });
    if (opened) { socket = attempt; break; }
    assert.equal(firefox.exitCode, null, 'Firefox exited before BiDi startup');
    await delay(100);
  }
  assert(socket, 'Firefox BiDi startup timed out');

  let sequence = 0;
  const replies = new Map();
  function command(method, params = {}) {
    const id = ++sequence;
    const reply = Promise.withResolvers();
    replies.set(id, reply);
    socket.send(JSON.stringify({ id, method, params }));
    return reply.promise;
  }
  const assets = new Map([['/', '/dist/index.html']]);
  for (const file of readdirSync('/dist/assets', { withFileTypes: true })) {
    if (file.isFile()) assets.set('/assets/' + file.name, '/dist/assets/' + file.name);
  }
  const [scope, ...rules] = readFileSync('/dist/_headers', 'utf8').trimEnd().split(/\r?\n/);
  assert.equal(scope, '/*');
  const headers = rules.map(line => {
    const [, name, value] = /^\s+([^:]+):\s*(.+)$/.exec(line);
    return { name, value: { type: 'string', value } };
  });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
  socket.onmessage = async event => {
    const msg = JSON.parse(event.data);
    if ('id' in msg) {
      const reply = replies.get(msg.id);
      replies.delete(msg.id);
      if (msg.type === 'error') reply.reject(new Error(msg.error)); // BiDi details may contain invitation data.
      else reply.resolve(msg.result);
    } else if (msg.method === 'network.beforeRequestSent' && msg.params.isBlocked) {
      const request = msg.params.request;
      const url = new URL(request.url);
      assert.equal(url.origin, origin);
      const file = assets.get(url.pathname);
      assert(file && !url.search && request.method === 'GET' && !request.bodySize);
      assert(!request.headers.some(h => /^(cookie|authorization)$/i.test(h.name)));
      await command('network.provideResponse', {
        request: request.request, statusCode: 200, body: { type: 'base64', value: readFileSync(file).toString('base64') },
        headers: [...headers, { name: 'Content-Type', value: { type: 'string', value: mime[extname(file)] ?? 'application/octet-stream' } }],
      });
    }
  };
  const { capabilities } = await command('session.new', { capabilities: { alwaysMatch: { acceptInsecureCerts: false } } });
  assert.equal(capabilities.acceptInsecureCerts, false);
  const { context } = await command('browsingContext.create', { type: 'tab' });
  await command('session.subscribe', { events: ['network.beforeRequestSent'], contexts: [context] });
  await command('network.addIntercept', { contexts: [context], phases: ['beforeRequestSent'],
    urlPatterns: [...assets.keys()].map(path => ({ type: 'string', pattern: origin + path })) });
  const navigate = url => command('browsingContext.navigate', { context, url, wait: 'complete' });
  async function evaluate(expression) {
    const result = await command('script.evaluate', { expression, target: { context }, awaitPromise: false });
    assert.equal(result.type, 'success', 'Page evaluation failed');
    return result.result.value;
  }
  async function waitFor(expression, stage) {
    for (let i = 0; i < 150; i++) {
      const value = await evaluate(expression);
      if (value) return value;
      await delay(100);
    }
    throw Error(stage + ' timed out');
  }
  const descriptor = endpoint + '#sha256=' + pin;
  const binarySha256 = createHash('sha256').update(readFileSync('/mdbase')).digest('hex');
  console.log(JSON.stringify({ firefox: capabilities.browserVersion, build: capabilities['moz:buildID'], binarySha256 }));
  let opened = 0;
  for (let i = 1; i <= 12; i++) {
    await navigate('about:blank');
    await navigate(origin + '/#mdbase-pair=' + encodeURIComponent(descriptor));
    await waitFor('location.hash === "" && !!document.querySelector("#pairing") && document.body.innerText.includes(' +
      JSON.stringify(new URL(endpoint).host) + ')', 'Invitation');
    const code = operator('pair', 'Firefox');
    assert(/^\d{8}$/.test(code));
    await evaluate('document.querySelector("#pairing").value=' + JSON.stringify(code) + ';document.querySelector("button[type=submit]").focus()');
    await command('input.performActions', { context, actions: [{ type: 'key', id: 'keyboard',
      actions: [{ type: 'keyDown', value: '\uE007' }, { type: 'keyUp', value: '\uE007' }] }] });
    const result = await waitFor('document.body.innerText.includes("Firefox.md") ? "opened" : ' +
      'document.querySelector("#pairing") && /refused|could not be confirmed/i.test(document.querySelector("[role=status]")?.textContent ?? "") && "pairing failed"', 'Pairing');
    const row = /^([a-f0-9]{32})\tFirefox$/.exec(operator('list'));
    assert(row, 'Expected one issued grant');
    console.log(JSON.stringify({ attempt: i, grantIssued: true, result }));
    if (result === 'opened') opened++;
    operator('revoke', row[1]);
  }
  await command('session.end');
  assert.equal(opened, 12, 'Valid pairings that opened the Editor');
} finally {
  socket?.close();
  firefox?.kill();
  daemon.kill();
}
