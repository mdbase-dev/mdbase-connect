#!/usr/bin/env node
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {chromium} from '@playwright/test';
import {apps, sizes, result, median} from './results.mjs';

const configPath = resolve(process.argv[2] ?? '');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const samplesPerCell = config.samples ?? 3;
if (!Number.isInteger(samplesPerCell) || samplesPerCell < 3 || samplesPerCell > 7) throw Error('invalid_sample_count');
for (const size of sizes) if (!/^[0-9a-f-]{36}$/.test(config.collections[size])) throw Error('invalid_collection_config');
const portalState = JSON.parse(await readFile(config.portal_state, 'utf8'));
// Only the control-plane login is reused. Every cold app origin starts empty.
if (portalState.origins?.length || portalState.cookies.some(cookie => cookie.domain !== 'connect.mdbase.dev')) throw Error('invalid_portal_state');
const ingestToken = (await readFile(config.token_file, 'utf8')).trim();
if (!ingestToken || /\s/.test(ingestToken)) throw Error('invalid_ingest_token');
const output = resolve(config.output);
await mkdir(dirname(output), {recursive: true, mode: 0o700});
const report = [];
const browser = await chromium.launch({headless: true, args: ['--enable-precise-memory-info']});
const failed = (stage, code, revision = 'unavailable') => ({stages: {}, revision, error: {stage, code}});

async function revision(page) {
  return page.evaluate(() => {
    const meta = document.querySelector('meta[name="mdbase-build"]')?.content;
    if (/^[a-f0-9]{12,40}$/.test(meta ?? '')) return meta;
    const entry = [...document.querySelectorAll('script[type="module"][src]')]
      .map(script => new URL(script.src).pathname).find(path => /\/assets\/index.*-[a-f0-9]{12}\.js$/.test(path));
    return entry?.match(/-([a-f0-9]{12})\.js$/)?.[1] ?? 'unavailable';
  });
}

async function instrument(page, selector) {
  await page.addInitScript(({selector}) => {
    const sample = {firstRecords: null, lcp: null};
    new PerformanceObserver(list => {
      const entries = list.getEntries(); sample.lcp = entries.at(-1).startTime;
    }).observe({type: 'largest-contentful-paint', buffered: true});
    let checking = false;
    const observer = new MutationObserver(() => {
      if (sample.firstRecords !== null || checking) return;
      checking = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        checking = false;
        const visible = [...document.querySelectorAll(selector)].some(element => {
          const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
          return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.visibility === 'visible' && style.display !== 'none';
        });
        if (visible) {sample.firstRecords = performance.now(); observer.disconnect();}
      }));
    });
    observer.observe(document, {subtree: true, childList: true, attributes: true});
    window.appTimings = sample;
  }, {selector});
}

async function visit(page, app, collection, cold, collectionName) {
  let build = 'unavailable', stage = 'navigation';
  try {
    await page.goto(`${apps[app].origin}/?collection=${encodeURIComponent(collection)}`, {waitUntil: 'domcontentloaded', timeout: 45000});
    build = await revision(page);
    stage = 'approval';
    if (cold) {
      // Cold includes automated consent with a saved Connect login. No password
      // or app installation state is injected into the measured origin.
      const signIn = page.getByRole('button', {name: 'Sign in', exact: true});
      await signIn.waitFor({state: 'visible', timeout: 30000});
      const popupPromise = page.waitForEvent('popup');
      await signIn.click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      if (new URL(popup.url()).pathname === '/login') return failed('auth', 'auth_expired', build);
      await popup.getByRole('option', {name: collectionName, exact: true}).click({timeout: 30000});
      await popup.locator('.approval-actions button.is-primary').click({timeout: 30000});
    }
    stage = 'first_records';
    await page.waitForFunction(() => Number.isFinite(window.appTimings?.firstRecords), null, {timeout: 45000});
    const data = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const firstRecords = window.appTimings.firstRecords;
      const stages = {ttfb: nav.responseStart - nav.requestStart, first_records: firstRecords};
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime;
      if (fcp !== undefined) stages.fcp = fcp;
      if (window.appTimings.lcp !== null) stages.lcp = window.appTimings.lcp;
      const marks = Object.fromEntries(['requested', 'approved', 'ready'].map(name => [name,
        performance.getEntriesByName(`mdbase:open:${name}`, 'mark')[0]?.startTime]));
      if (marks.requested !== undefined) {
        stages.open_first_records = firstRecords - marks.requested;
        if (marks.approved !== undefined) stages.open_approved = marks.approved - marks.requested;
        if (marks.ready !== undefined) stages.open_ready = marks.ready - marks.requested;
        const query = performance.getEntriesByName('mdbase:query:first-result', 'mark').find(entry => entry.startTime >= marks.requested);
        if (query) stages.first_query = query.startTime - marks.requested;
      }
      return {stages};
    });
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const metrics = await session.send('Performance.getMetrics');
    await session.detach();
    const heap = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
    if (build === 'unavailable') return failed('revision', 'revision_missing', build);
    if (data.stages.fcp === undefined || data.stages.lcp === undefined || !Number.isFinite(heap)) return failed('measurement', 'metrics_missing', build);
    return {...data, revision: build, heap_bytes: heap};
  } catch {
    // Never serialize browser exceptions: their messages contain URLs and IDs.
    if (!cold && !page.isClosed() && await page.getByRole('button', {name: 'Sign in', exact: true}).isVisible()) return failed('auth', 'auth_expired', build);
    return failed(stage, page.isClosed() ? 'browser_closed' : 'timeout', build);
  }
}

async function cleanup(context, installationIds) {
  const overview = await context.request.get('https://connect.mdbase.dev/v1/me?native_storage=omit');
  if (!overview.ok()) throw Error('cleanup_unavailable');
  const body = await overview.json();
  const owned = [...new Set((body.installation_access ?? []).filter(row => installationIds.has(row.installation_id)).map(row => row.connector_id))];
  for (const id of owned) {
    const response = await context.request.delete(`https://connect.mdbase.dev/v1/account/installations/${encodeURIComponent(id)}`, {headers: {Origin: 'https://connect.mdbase.dev'}});
    if (!response.ok()) throw Error('cleanup_failed');
  }
  const check = await context.request.get('https://connect.mdbase.dev/v1/me?native_storage=omit');
  if (!check.ok() || (await check.json()).installation_access?.some(row => installationIds.has(row.installation_id))) throw Error('cleanup_failed');
}

try {
  const auth = await browser.newContext({storageState: portalState});
  const preflight = await auth.request.get('https://connect.mdbase.dev/v1/me?native_storage=omit');
  const authError = preflight.status() === 401 ? 'auth_expired' : preflight.ok() ? null : 'auth_unavailable';
  if (!authError) await auth.storageState({path: config.portal_state});
  if (!authError) {
    const pending = (await readFile(config.ledger_file, 'utf8').catch(error => {if (error.code === 'ENOENT') return ''; throw error;})).trim().split('\n').filter(Boolean);
    await cleanup(auth, new Set(pending));
    await writeFile(config.ledger_file, '', {mode: 0o600});
  }
  await auth.close();
  for (const app of Object.keys(apps)) for (const size of sizes) {
    const samples = {cold: [], warm: []};
    for (let index = 0; index < samplesPerCell; index++) {
      if (authError) {
        for (const mode of ['cold', 'warm']) samples[mode].push(failed('auth', authError));
        continue;
      }
      const context = await browser.newContext({storageState: portalState, viewport: {width: 1440, height: 900}, locale: 'en-US'});
      const installationIds = new Set();
      context.on('request', request => {
        if (request.url() === 'https://connect.mdbase.dev/v1/pairing-requests' && request.method() === 'POST') {
          const id = request.postDataJSON()?.installation?.installation_id;
          if (id && !installationIds.has(id)) {
            installationIds.add(id);
            appendFileSync(config.ledger_file, id + '\n', {mode: 0o600});
          }
        }
      });
      try {
        const page = await context.newPage();
        await instrument(page, apps[app].selector);
        const cold = await visit(page, app, config.collections[size], true, config.collection_names[size]);
        samples.cold.push(cold);
        // Same context, second navigation: HTTP cache, IDB, storage and service worker retained.
        samples.warm.push(cold.error ? failed(cold.error.stage, cold.error.code, cold.revision) : await visit(page, app, config.collections[size], false, config.collection_names[size]));
        await cleanup(context, installationIds);
        await writeFile(config.ledger_file, '', {mode: 0o600});
      } finally {await context.close();}
      // A failed sample is a finding, never retried or hidden by a passing median.
      if (samples.cold.at(-1).error || samples.warm.at(-1).error) break;
    }
    for (const mode of ['cold', 'warm']) {
      const timing = result(`${app}.${size}.${mode}`, samples[mode], new Date().toISOString());
      const heaps = samples[mode].map(sample => sample.heap_bytes).filter(Number.isFinite);
      report.push({timing, samples: samples[mode].length, heap_bytes_median: heaps.length === samplesPerCell ? median(heaps) : null});
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
      const response = await fetch('https://ops-ingest.mdbase.dev/v1/timings', {
        method: 'POST', headers: {Authorization: `Bearer ${ingestToken}`, 'Content-Type': 'application/json'}, body: JSON.stringify(timing), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw Error(`ingest_http_${response.status}`);
      console.log(JSON.stringify(timing));
    }
  }
} finally {await browser.close();}
