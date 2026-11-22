// Entry point and invocation examples are in qualify-webtransport.sh. Only the static
// document and its published assets are fulfilled. Chrome owns QUIC, TLS and permissions.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { networkInterfaces, release } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { acceptsOnly, enrollment, sealedGrant } from './webtransport-rollover.mjs';

const [app, binaryArg, ...inputs] = process.argv.slice(2);
assert(['platform', 'tasknotes', 'editor'].includes(app), 'Run qualify-webtransport.sh platform|tasknotes|editor');
const veth = Boolean(process.env.WT_BROWSER_PEER);
const hostIP = veth ? '192.168.88.1' : '127.0.0.1';
const permissionName = veth ? 'local-network' : 'loopback-network';
assert.deepEqual(Object.keys(networkInterfaces()).sort(), veth ? ['lo', 'wt-host'] : ['lo'], 'Use the isolated shell launcher');
assert.equal(process.env.HOME, '/tmp/qualification-home', 'Use the private shell launcher');
const root = await mkdtemp('/tmp/wt-proof-');
// Aim two slots beyond the next real boundary. Both leaves are invalid at the
// driver's wall time, so a successful native TLS handshake also checks TLS time.
const slotMs = 12 * 86400_000;
const boundary = (Math.floor(Date.now() / slotMs) + 3) * slotMs;
const rollover = Boolean(process.env.WT_FAKETIME_LIB);
const offsetSeconds = Math.floor((boundary - Date.now()) / 1000) - 75;
const childEnv = rollover ? {
  ...process.env,
  LD_PRELOAD: process.env.WT_FAKETIME_LIB,
  FAKETIME: '+' + offsetSeconds,
  FAKETIME_DONT_FAKE_MONOTONIC: '1',
  FAKETIME_DISABLE_SHM: '1',
  NO_FAKE_STAT: '1',
} : process.env;
const browser = await chromium.launch({
  env: childEnv,
  executablePath: process.env.CHROME_BIN,
  ignoreDefaultArgs: true,
  headless: false,
  args: ['--remote-debugging-pipe', '--no-first-run', '--no-startup-window', '--user-data-dir=' + join(root, 'browser')],
});

async function platform() {
  const page = await browser.newPage();
  await page.goto('chrome://sandbox');
  const sandbox = await page.locator('body').innerText();
  assert.match(sandbox, /Seccomp-BPF sandbox\s+Yes/i);
  assert.match(sandbox, /PID namespaces\s+Yes/i);
  await page.goto('chrome://policy');
  const tables = page.locator('policy-table');
  await tables.first().waitFor();
  const emptyPolicies = await tables.getByText('No policies set', { exact: true }).all();
  const noPolicies = emptyPolicies.length === await tables.count() &&
    (await Promise.all(emptyPolicies.map(label => label.isVisible()))).every(Boolean);
  console.log('Enterprise policy tables all report no policies set: ' + noPolicies);
  await page.route('https://platform-qualification.invalid/', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html>' }));
  await page.goto('https://platform-qualification.invalid/');
  const browserNow = await page.evaluate(() => Date.now());
  assert(Math.abs(browserNow - Date.now() - (rollover ? offsetSeconds * 1000 : 0)) < 5000,
    'browser wall clock mismatch');
  console.log(JSON.stringify({ clock: rollover ? 'process-scoped libfaketime' : 'ordinary wall clock',
    driverUTC: new Date().toISOString(), browserUTC: new Date(browserNow).toISOString(),
    ...(rollover && { boundaryUTC: new Date(boundary).toISOString() }) }));
  const features = await page.evaluate(async () => {
    const permissions = {};
    for (const name of ['local-network-access', 'local-network', 'loopback-network']) {
      permissions[name] = await navigator.permissions.query({ name }).then(p => p.state, e => e.name);
    }
    return { secureContext: isSecureContext, webTransport: typeof globalThis.WebTransport,
      bidi: typeof globalThis.WebTransport?.prototype.createBidirectionalStream, permissions };
  });
  const require = createRequire(import.meta.url);
  console.log(JSON.stringify({ platform: 'Linux ' + release(), node: process.version, playwright: require('@playwright/test/package.json').version,
    browser: browser.version(), network: veth ? 'two private namespaces, RFC1918 veth' : 'lo only', sandbox: 'PID namespace and seccomp active', delivery: 'route.fulfill static HTTPS only', ...features }));
  assert(features.secureContext && features.webTransport === 'function' && features.bidi === 'function');
  await page.context().close();
}

const tasknotes = app === 'tasknotes';
const seedName = 'qualification-note.md';
const original = 'Loopback original';
const edited = 'Browser qualification saved';
const afterRollover = 'Browser saved after certificate rotation';
const codeField = page => page.getByLabel(/pairing code/i);
const ready = page => page.getByRole('button', { name: tasknotes ? 'Search' : seedName, exact: true });

async function record(page, expected, replacement) {
  await ready(page).click();
  if (tasknotes) {
    await page.getByRole('searchbox', { name: 'Search tasks' }).fill(expected);
    await page.getByRole('button', { name: expected, exact: true }).click();
    const title = page.getByRole('textbox', { name: 'Task title', exact: true });
    await expect(title).toHaveValue(expected);
    if (replacement) {
      await title.fill(replacement);
      await title.blur();
      await expect(page.locator('.save-state')).toHaveText('Saved', { timeout: 15000 });
    }
  } else {
    const body = page.getByRole('textbox', { name: 'Note body' });
    await expect(body).toContainText(expected);
    if (replacement) {
      await body.fill(replacement);
      await page.getByRole('button', { name: 'Save note' }).click();
      await expect(page.getByRole('status')).toHaveText('Saved');
    }
  }
}

const violations = new Set();
const results = [];
const networkErrors = new Set();
let stage = 'platform';
let daemon, daemonExit;
let backend;
let assetGets = 0;
const servedCalendarModules = new Set();
const sessions = [];
const secrets = new Set([seedName, original, edited, afterRollover, 'tasks/proof.md', 'direct-fixture', 'Synthetic fixture body', root]);

function containsPrivateValue(text) {
  const lower = text.toLowerCase();
  return /[0-9a-f]{64}/i.test(text) ||
    [...secrets].some(s => [s, encodeURIComponent(s)].some(v => lower.includes(v.toLowerCase())));
}

// Only public distribution files and exact request targets can be served. Do not
// synthesize an app shell, rewrite HTML/CSP, or satisfy requests to other origins.
async function publisher(dist) {
  const paths = new Map([['/', join(dist, 'index.html')]]);
  for (const entry of await readdir(dist, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = join(entry.parentPath, entry.name);
    const path = file.slice(dist.length);
    if (path.startsWith('/assets/') || path === '/tasknotes-mark.svg' || path === '/favicon.ico') paths.set(path, file);
  }
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.wasm': 'application/wasm' };
  const headers = {};
  const rules = await readFile(join(dist, '_headers'), 'utf8').catch(e => { if (e.code === 'ENOENT') return ''; throw e; });
  if (rules) {
    const [scope, ...lines] = rules.trimEnd().split(/\r?\n/);
    assert.equal(scope, '/*', 'Unrecognized static header scope');
    for (const line of lines) {
      const m = /^\s+([^:]+):\s*(.+)$/.exec(line);
      assert(m, 'Unrecognized static header rule');
      headers[m[1]] = m[2];
    }
  }
  const digest = createHash('sha256');
  const assets = new Map();
  for (const [path, file] of [...paths].sort(([a], [b]) => a.localeCompare(b))) {
    const body = await readFile(file);
    assets.set(path, { body, contentType: mime[extname(file)] ?? 'application/octet-stream' });
    digest.update(path).update('\0').update(createHash('sha256').update(body).digest());
  }
  digest.update(rules);
  console.log(JSON.stringify({ app, staticFixtureSha256: digest.digest('hex'), files: paths.size, responseHeaders: Object.keys(headers) }));
  return async route => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname + url.search;
    const headersIn = await request.allHeaders();
    if (containsPrivateValue(JSON.stringify([path, headersIn]))) violations.add('private value in static request');
    if (!assets.has(path) || url.username || url.password || request.method() !== 'GET' || request.postDataBuffer() || 'cookie' in headersIn || 'authorization' in headersIn) {
      violations.add('unexpected static target, credentials, method or body');
      await route.abort();
      return;
    }
    ++assetGets;
    const asset = assets.get(path);
    await route.fulfill({ ...asset, headers });
    if (asset.contentType === 'text/javascript' && asset.body.includes('WTP1')) {
      servedCalendarModules.add(path);
    }
  };
}

async function profile(origin, deliver, invitation) {
  const context = await browser.newContext({ locale: 'en-US' });
  context.on('serviceworker', worker => {
    // Stock Chrome can start its own built-in extension worker in a fresh profile.
    const protocol = new URL(worker.url()).protocol;
    if (protocol !== 'chrome-extension:') violations.add('unexpected service worker (' + protocol + ')');
  });
  context.on('request', r => {
    if (new URL(r.url()).origin !== origin && /^https?:/.test(r.url())) violations.add('HTTP request outside fixture origin');
  });
  await context.route(origin + '/**', deliver);
  const page = await context.newPage();
  context.on('page', () => violations.add('unexpected new page'));
  page.on('worker', () => violations.add('unexpected page worker'));
  page.on('framenavigated', frame => {
    const url = frame.url();
    if (url === 'about:blank' || url === invitation) return;
    // TaskNotes' documented hash route identifies the opened synthetic task.
    // Its ID remains forbidden in all HTTP targets, headers and console output.
    if (tasknotes && frame === page.mainFrame() && url === origin + '/#/task/direct-fixture') return;
    if (frame !== page.mainFrame() || new URL(url).origin !== origin ||
        containsPrivateValue(url.slice(origin.length))) violations.add('unexpected browser location');
  });
  page.setDefaultTimeout(12000);
  const cdp = await context.newCDPSession(page);
  cdp.on('Runtime.consoleAPICalled', ({ args }) => {
    if (containsPrivateValue(JSON.stringify(args))) violations.add('private value in application console');
  });
  await cdp.send('Runtime.enable');
  await cdp.send('Network.enable');
  await cdp.send('Log.enable');
  await cdp.send('Audits.enable');
  cdp.on('Audits.issueAdded', ({ issue }) => {
    const csp = issue.details.contentSecurityPolicyIssueDetails;
    if (csp) {
      const directive = csp.violatedDirective.split(' ')[0];
      const raw = csp.blockedURL;
      const target = raw && URL.canParse(raw) ? new URL(raw) : null;
      const destination = target?.origin === origin ? 'fixture origin' : target?.protocol ??
        (/^[a-z-]+$/i.test(raw ?? '') ? raw : raw ? 'redacted target' : 'no URL');
      const detail = 'CSP ' + directive + ' (' + destination + ', ' + csp.contentSecurityPolicyViolationType + ')';
      if ((target && ['http:', 'https:', 'ws:', 'wss:'].includes(target.protocol)) || directive === 'connect-src') violations.add(detail);
      else networkErrors.add(detail);
    }
    const cors = issue.details.corsIssueDetails?.corsErrorStatus.corsError;
    if (cors) networkErrors.add(cors);
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    for (const code of entry.text.match(/net::ERR_[A-Z_]+/g) ?? []) networkErrors.add(code);
  });
  const byId = new Map();
  cdp.on('Network.webSocketCreated', () => violations.add('WebSocket attempted'));
  cdp.on('Network.webTransportCreated', ({ transportId, url }) => {
    const location = new URL(url);
    const path = location.pathname;
    if (url !== backend + path || !['/_mdbase/pair', '/_mdbase/replica'].includes(path)) violations.add('unexpected WebTransport destination');
    const entry = { op: path === '/_mdbase/pair' ? 'pair' : 'replica', established: false };
    byId.set(transportId, entry);
    sessions.push(entry);
  });
  cdp.on('Network.webTransportConnectionEstablished', ({ transportId }) => {
    const entry = byId.get(transportId);
    if (entry) entry.established = true;
  });
  return page;
}

function pass(name) {
  results.push(name);
  console.log('PASS ' + name);
}

async function qualify() {
  assert.equal(inputs.length, tasknotes ? 3 : 2, 'See qualify-webtransport.sh for the required inputs');
  const [dist, origin] = inputs.slice(-2);
  assert.equal(new URL(origin).origin, origin);
  assert.equal(new URL(origin).protocol, 'https:');

  const folder = join(root, 'collection');
  const operatorArgs = ['self-host', '--state-dir', join(root, 'state'), '--collection', folder, '--origin', origin, '--auth-dir', join(root, 'auth')];
  function operator(...args) {
    return execFileSync(binary, [...operatorArgs, ...args], { env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10000 }).trim();
  }
  const deliver = await publisher(resolve(dist));
  async function invitationPage(hash, paste = false) {
    const descriptor = backend + '#sha256=' + hash;
    const invitation = origin + '/#mdbase-pair=' + encodeURIComponent(descriptor);
    const page = await profile(origin, deliver, invitation);
    const start = sessions.length;
    await page.goto(paste ? origin : invitation);
    if (paste) await page.locator('input[type=url]').fill(invitation);
    await expect(codeField(page)).toBeVisible();
    // Verify what the person authorizes. An app can hide the raw descriptor.
    await expect(page.getByText(new URL(backend).host, { exact: false }).first()).toBeVisible();
    assert.equal(new URL(page.url()).hash, '', 'pairing fragment was retained');
    assert.equal(sessions.length, start, 'connected before code submission');
    return page;
  }
  if (binaryArg === '--entry-only') {
    backend = 'https://127.0.0.1:4433';
    const pin = 'a'.repeat(64);
    secrets.add(backend);
    secrets.add(pin);
    stage = 'static invitation entry';
    const page = await invitationPage(pin);
    const code = codeField(page);
    await expect(code).toBeFocused();
    await expect(code).toHaveAttribute('autocomplete', 'one-time-code');
    await page.setViewportSize({ width: 375, height: 740 });
    await expect(code).toBeVisible();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      'pairing form overflows a narrow viewport');
    const managed = tasknotes ? 'https://app.tasknotes.dev/' : 'https://editor.mdbase.dev/';
    await expect(page.locator(`a[href="${managed}"], a[href="${new URL(managed).origin}"]`)).toBeVisible();
    await page.context().close();
    const pasted = await invitationPage(pin, true);
    await pasted.context().close();
    // Model Web IDL ignoring an unknown options key. The native permission
    // and TLS runs below always use the browser's own WebTransport.
    const link = origin + '/#mdbase-pair=' + encodeURIComponent(backend + '#sha256=' + pin);
    const unsupported = await profile(origin, deliver, link);
    await unsupported.addInitScript(() => {
      window.WebTransport = class {
        ready = Promise.resolve();
        closed = new Promise(() => {});
        close() {}
        createBidirectionalStream() { throw Error('unexpected stream'); }
      };
    });
    await unsupported.goto(link);
    await codeField(unsupported).fill('12345678');
    await unsupported.getByRole('button', { name: /pair/i }).click();
    await expect(unsupported.getByRole('alert').filter({ hasText: /browser/i })).toBeVisible();
    await expect(codeField(unsupported)).toHaveCount(0);
    await unsupported.context().close();
    assert.equal(sessions.length, 0);
    assert.equal(violations.size, 0);
    pass('opened and pasted invitations, keyboard focus, one-time-code input, managed return and narrow viewport checked; simulated pin-unaware browser received compatibility guidance');
    return;
  }
  const binary = join(root, 'mdbase');
  await copyFile(resolve(binaryArg), binary);
  stage = 'isolated collection and CLI';
  if (tasknotes) {
    const fixture = await import(pathToFileURL(resolve(inputs[0], 'scripts/direct-fixture.mjs')));
    await fixture.seedDirectFixture(folder);
  } else {
    await mkdir(folder);
    await writeFile(join(folder, 'mdbase.yaml'), 'spec_version: "0.3.0"\n');
    await writeFile(join(folder, seedName), '---\ntitle: Private qualification\n---\n' + original + '\n');
  }
  assert(operator('serve', '--help').includes('--webtransport'), 'CLI lacks serve --webtransport');
  console.log(JSON.stringify({ binarySha256: createHash('sha256').update(await readFile(binary)).digest('hex'),
    cliVersion: execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim(), origin }));
  daemon = spawn(binary, [...operatorArgs, 'serve', '--webtransport', hostIP + ':0'], { env: childEnv, stdio: ['ignore', 'pipe', 'ignore'] });
  daemonExit = once(daemon, 'exit');
  let pin, currentPin;
  const lines = createInterface({ input: daemon.stdout });
  const announced = new Promise(resolve => lines.on('line', line => {
    backend ??= /^WebTransport endpoint: (https:\/\/[0-9.]+:\d+)$/.exec(line)?.[1];
    const announcedPin = /^Certificate SHA-256: ([0-9a-f]{64})$/i.exec(line)?.[1];
    if (announcedPin) {
      currentPin = announcedPin;
      pin ??= announcedPin;
    }
    if (backend && pin) resolve();
  }));
  await Promise.race([announced, daemonExit.then(() => { throw Error('daemon exited before announcement'); }),
    delay(15000, null, { ref: false }).then(() => { throw Error('daemon announcement timeout'); })]);
  assert.equal(new URL(backend).hostname, hostIP);
  assert.notEqual(backend, origin);
  secrets.add(backend);
  secrets.add(new URL(backend).host);
  secrets.add(pin);
  const list = () => operator('list');
  const code = operator('pair', 'Qualification');
  assert(/^\d{8}$/.test(code), 'invalid operator code');
  const badCode = code === '00000000' ? '00000001' : '00000000';
  secrets.add(code);
  secrets.add(badCode);

  const permission = page => page.evaluate(name => navigator.permissions.query({ name }).then(p => p.state), permissionName);
  async function submit(page, value, remember, decision) {
    if (decision) assert.equal(await permission(page), 'prompt');
    await page.getByRole('checkbox', { name: /remember/i }).setChecked(remember);
    await codeField(page).fill(value);
    await page.getByRole('button', { name: /pair/i }).click();
    if (decision) {
      execFileSync('python', [fileURLToPath(new URL('./webtransport-permission.py', import.meta.url)), decision, permissionName],
        { stdio: ['ignore', 'ignore', 'pipe'], timeout: 8500 });
      await expect.poll(() => permission(page)).toBe(decision === 'Allow' ? 'granted' : 'denied');
    }
  }
  async function refused(page, guidance) {
    const feedback = page.locator('[role=alert], [role=status]').filter({ hasText: guidance }).first();
    await expect(feedback).toBeVisible({ timeout: 15000 });
    await expect(codeField(page)).toHaveValue('');
    return feedback.innerText();
  }
  function since(start, ops) {
    assert.deepEqual(sessions.slice(start).map(s => [s.op, s.established]), ops);
  }

  stage = 'genuine browser permission denial';
  const deniedPage = await invitationPage(pin);
  await submit(deniedPage, code, false, 'Block');
  await refused(deniedPage, /local.network|site permission/i);
  since(0, [['pair', false]]);
  assert.equal(list(), '');
  await deniedPage.context().close();
  pass('native ' + permissionName + ' permission Block denied pairing and issued no grant');

  stage = 'wrong pin with valid OTP';
  const wrong = (pin[0] === '0' ? '1' : '0') + pin.slice(1);
  const negative = await invitationPage(wrong);
  await submit(negative, code, false, 'Allow');
  const networkFailure = await refused(negative, /reach|network|connect|permission/i);
  since(1, [['pair', false]]);
  assert.equal(list(), '', 'wrong pin issued grant');
  console.log('Observed one unestablished native session and zero grants for the wrong pin');
  await negative.context().close();

  stage = 'wrong OTP with correct pin';
  const primary = await invitationPage(pin, true);
  await submit(primary, badCode, true, 'Allow');
  const codeFailure = await refused(primary, /code/i);
  assert.notEqual(codeFailure, networkFailure, 'refused code and unreachable host gave identical advice');
  await expect(primary.getByRole('checkbox', { name: /remember/i })).toBeChecked();
  since(2, [['pair', true]]);
  assert.equal(list(), '', 'wrong OTP issued grant');
  pass('pasted invitation identifies host; wrong pin and wrong code produced distinct guidance; remember choice survived retry');

  stage = 'single-use pairing';
  await submit(primary, code, true);
  await expect(ready(primary)).toBeVisible({ timeout: 20000 });
  since(3, [['pair', true], ['replica', true]]);
  const entry = list();
  assert(/^[a-f0-9]{32}\tQualification$/.test(entry), 'expected one named browser grant');
  const id = entry.split('\t')[0];
  secrets.add(id);
  const replay = await invitationPage(pin);
  await submit(replay, code, false, 'Allow');
  await refused(replay, /code/i);
  since(5, [['pair', true]]);
  assert.equal(list(), entry, 'replay changed grants');
  await replay.context().close();
  pass('valid OTP paired; replay from a fresh browser context denied');

  stage = 'disk read and confirmed write';
  await record(primary, original, edited);
  const markdown = join(folder, tasknotes ? 'tasks/proof.md' : seedName);
  await expect.poll(() => readFile(markdown, 'utf8')).toContain(tasknotes ? 'title: ' + edited : edited);
  pass('seed read through app and SDK; saved edit independently observed on disk');

  stage = 'remembered reconnect';
  const count = sessions.length;
  let before, saved;
  if (rollover) {
    stage = 'live certificate rollover';
    before = enrollment(join(root, 'auth', 'credentials.sqlite'), boundary / slotMs - 1, pin, boundary);
    saved = await sealedGrant(primary, app);
    const beforeTime = await primary.evaluate(() => Date.now());
    assert(beforeTime < boundary, 'enrollment missed the boundary');
    // Unload the app so its next read cannot use the previous connection.
    await primary.goto('about:blank');
    await expect.poll(() => currentPin, { timeout: boundary - beforeTime + 15000 }).toBe(before.next);
    const afterTime = await primary.evaluate(() => Date.now());
    assert(afterTime >= boundary && Math.abs(afterTime - Date.now() - offsetSeconds * 1000) < 5000);
    console.log(JSON.stringify({ enrolledUTC: new Date(beforeTime), rotatedUTC: new Date(afterTime),
      hostCalendarLeaves: 32, previousAndNextValidAtBoundary: true, systemTimePrecedesBothLeaves: true }));
    pass('same daemon and endpoint rotated live to the next preissued leaf');
  }
  // TaskNotes uses a hash router. Reopen the clean entry with the same site storage.
  if (rollover) {
    await primary.goto(origin + '/');
  } else {
    await primary.evaluate(() => history.replaceState(null, '', '/'));
    await primary.reload();
  }
  await expect(ready(primary)).toBeVisible({ timeout: 20000 });
  assert.equal(new URL(primary.url()).origin, origin);
  assert(!containsPrivateValue(primary.url()));
  await record(primary, edited, rollover ? afterRollover : undefined);
  since(count, [['replica', true]]);
  assert.equal(list(), entry);
  pass('remembered browser reconnected without another pairing and read back the saved edit');
  if (rollover) {
    await expect.poll(() => readFile(markdown, 'utf8')).toContain(tasknotes ? 'title: ' + afterRollover : afterRollover);
    assert.deepEqual(await sealedGrant(primary, app), saved);
    before.checkGrant();
    pass('post-boundary edit reached disk with unchanged sealed browser grant and host credential row');
    stage = 'single-pin native TLS controls after rollover';
    const probes = sessions.length;
    assert.equal(await acceptsOnly(primary, backend, pin), false);
    assert.equal(await acceptsOnly(primary, backend, before.next), true);
    // CDP delivers establishment independently of the renderer's ready promise.
    await expect(() => since(probes, [['replica', false], ['replica', true]])).toPass({ timeout: 5000 });
    pass('enrollment pin alone denied and next pin alone accepted by native TLS; neither probe sent credentials');
  } else {
    stage = 're-open the same trusted invitation';
    const prior = sessions.length;
    await primary.goto('about:blank');
    await primary.goto(origin + '/#mdbase-pair=' + encodeURIComponent(backend + '#sha256=' + pin));
    await expect(ready(primary)).toBeVisible({ timeout: 20000 });
    since(prior, [['replica', true]]);
    assert(!containsPrivateValue(primary.url()));
    await record(primary, edited);
    pass('reopening the identical invitation uses only the saved grant for that server');
  }

  stage = 'active and remembered revocation';
  const unsaved = 'Unsubmitted private edit before revocation';
  if (!tasknotes) {
    secrets.add(unsaved);
    await primary.getByRole('textbox', { name: 'Note body' }).fill(unsaved);
  }
  operator('revoke', id);
  await expect(codeField(primary)).toBeVisible({ timeout: 15000 });
  if (!tasknotes) {
    const recovery = primary.locator('textarea[readonly]');
    await expect(recovery).toHaveValue(unsaved);
    assert(!(await readFile(markdown, 'utf8')).includes(unsaved));
    pass('revoked editor left unsubmitted text available to copy without writing it to disk');
  }
  const afterRevoke = sessions.length;
  await primary.reload();
  await expect(codeField(primary)).toBeVisible();
  assert.equal(sessions.length, afterRevoke);
  assert.equal(list(), '');
  await primary.context().close();
  pass('active grant revoked and reload returned to pairing without a replica session');
  stage = 'static request and destination audit';
  assert(assetGets > 0);
  assert.equal(violations.size, 0);
  if (rollover) assert(servedCalendarModules.size > 0, 'issued calendar SDK absent from served JavaScript');
  pass('static asset GETs, browser locations, application console and native destinations passed the private-value audit');
  console.log(JSON.stringify({ assetGets, servedCalendarModules: [...servedCalendarModules], observedSessions: sessions,
    violations: [...violations], networkErrors: [...networkErrors] }));
}

try {
  await platform();
  if (app !== 'platform') await qualify();
} catch (e) {
  // Playwright exceptions may contain a descriptor, OTP, task contents or saved grant.
  const site = e.stack?.split('\n').find(s => /qualify-webtransport\.mjs:\d+/.test(s))?.match(/qualify-webtransport\.mjs:\d+/)?.[0];
  const reason = e.message === 'CLI lacks serve --webtransport' ? e.message : e.name;
  console.error(JSON.stringify({ failed: stage, reason, site, passed: results, observedSessions: sessions, assetGets, violations: [...violations], networkErrors: [...networkErrors] }));
  process.exitCode = 1;
} finally {
  await browser.close();
  if (daemon?.pid && daemon.exitCode === null && !daemon.signalCode) {
    daemon.kill('SIGTERM');
    await Promise.race([daemonExit, delay(2500, null, { ref: false })]);
    if (daemon.exitCode === null && !daemon.signalCode) daemon.kill('SIGKILL');
    await daemonExit;
  }
  // The shell launcher destroys the entire private tmpfs on exit.
}
