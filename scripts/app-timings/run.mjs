#!/usr/bin/env node
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {appendFileSync} from 'node:fs';
import {resolve, dirname} from 'node:path';
import {chromium} from '@playwright/test';
import {apps, sizes, result, median, measuredStages} from './results.mjs';

const configPath = resolve(process.argv[2] ?? '');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const collectOnly = process.argv[3] === '--collect-only';
const warmSamples = config.samples ?? 3;
if (!Number.isInteger(warmSamples) || warmSamples < 3 || warmSamples > 7) throw Error('invalid_sample_count');
for (const size of sizes) if (!/^[0-9a-f-]{36}$/.test(config.collections[size])) throw Error('invalid_collection_config');
const portalState = JSON.parse(await readFile(config.portal_state, 'utf8'));
// Only the control-plane login is reused. Every cold app origin starts empty.
if (portalState.origins?.length || portalState.cookies.some(cookie => cookie.domain !== 'connect.mdbase.dev')) throw Error('invalid_portal_state');
const ingestToken = collectOnly ? null : (await readFile(config.token_file, 'utf8')).trim();
if (!collectOnly && (!ingestToken || /\s/.test(ingestToken))) throw Error('invalid_ingest_token');
const output = resolve(config.output);
await mkdir(dirname(output), {recursive: true, mode: 0o700});
const report = [];
const browser = await chromium.launch({headless: true, args: ['--enable-precise-memory-info']});
const failed = (stage, code, revision = 'unavailable', visited = true) => ({stages: {}, revision, visited, error: {stage, code}});

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
    const sample = {firstRecords: null, lcp: null, setupRequired: false, opening: []};
    const visible = element => {
      const rect = element.getBoundingClientRect(), style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && style.visibility === 'visible' && style.display !== 'none';
    };
    new PerformanceObserver(list => {
      const entries = list.getEntries(); sample.lcp = entries.at(-1).startTime;
    }).observe({type: 'largest-contentful-paint', buffered: true});
    let checking = false;
    const observer = new MutationObserver(() => {
      if (sample.firstRecords !== null || checking) return;
      checking = true;
      requestAnimationFrame(() => requestAnimationFrame(() => {
        checking = false;
        sample.setupRequired = [...document.querySelectorAll('.mdbase-collections-gate[data-phase="needs_setup"]')].some(visible);
        const text = document.querySelector('.mdbase-opening small')?.textContent ?? '';
        const name = text.includes('Preparing secure access') ? 'key_wait' : text.includes('Loading the collection snapshot') ? 'snapshot' : text.includes('Applying collection updates') ? 'apply' : null;
        if (sample.opening.at(-1)?.name !== name) sample.opening.push({name, at: performance.now()});
        if ([...document.querySelectorAll(selector)].some(visible)) {sample.firstRecords = performance.now(); observer.disconnect();}
      }));
    });
    observer.observe(document, {subtree: true, childList: true, attributes: true, characterData: true});
    window.appTimings = sample;
  }, {selector});
}

async function visit(page, app, collection, cold, collectionName, timeout) {
  let build = 'unavailable', stage = 'navigation', error, approvalEpoch;
  try {
    await page.goto(`${apps[app].origin}/?collection=${encodeURIComponent(collection)}`, {waitUntil: 'domcontentloaded', timeout: 45000});
    build = await revision(page);
    stage = 'approval';
    if (cold) {
      // Automate consent with the saved portal login, then time cold records
      // from the approval response. App storage starts empty.
      const signIn = page.getByRole('button', {name: 'Sign in', exact: true});
      await signIn.waitFor({state: 'visible', timeout: 30000});
      const popupPromise = page.waitForEvent('popup');
      await signIn.click();
      const popup = await popupPromise;
      await popup.waitForLoadState('domcontentloaded');
      if (new URL(popup.url()).pathname === '/login') return failed('auth', 'auth_expired', build);
      await popup.getByRole('option', {name: collectionName, exact: true}).click({timeout: 30000});
      const [approved] = await Promise.all([
        popup.waitForResponse(response => response.request().method() === 'POST' && /^https:\/\/connect\.mdbase\.dev\/v1\/pairing-requests\/[^/]+\/approve$/.test(response.url()), {timeout: 30000}),
        popup.locator('.approval-actions button.is-primary').click({timeout: 30000}),
      ]);
      if (!approved.ok()) return failed(approved.status() === 401 ? 'auth' : 'approval', approved.status() === 401 ? 'auth_expired' : `http_${approved.status()}`, build);
      const timing = approved.request().timing();
      approvalEpoch = timing.startTime + timing.responseStart;
      await page.bringToFront();
    }
    stage = 'first_records';
    await page.waitForFunction(() => Number.isFinite(window.appTimings?.firstRecords) || window.appTimings?.setupRequired, null, {timeout});
    if (await page.evaluate(() => window.appTimings.setupRequired)) error = {stage: 'setup', code: 'setup_required'};
  } catch {
    // Never serialize browser exceptions: their messages contain URLs and IDs.
    error = {stage, code: page.isClosed() ? 'browser_closed' : 'timeout'};
  }
  try {
    const observation = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const marks = Object.fromEntries(['requested', 'approved', 'ready'].map(name => [name,
        performance.getEntriesByName(`mdbase:open:${name}`, 'mark')[0]?.startTime]));
      const query = performance.getEntriesByName('mdbase:query:first-result', 'mark').find(entry => entry.startTime >= marks.requested);
      return {
        ...window.appTimings, timeOrigin: performance.timeOrigin, endedAt: performance.now(),
        ttfb: nav.responseStart - nav.requestStart,
        fcp: performance.getEntriesByName('first-contentful-paint')[0]?.startTime,
        marks, firstQuery: query?.startTime,
      };
    });
    const stages = measuredStages(observation, approvalEpoch);
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const metrics = await session.send('Performance.getMetrics');
    await session.detach();
    const heap = metrics.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value;
    if (build === 'unavailable') error ??= {stage: 'revision', code: 'revision_missing'};
    if (stages.fcp === undefined || stages.lcp === undefined || !Number.isFinite(heap)) error ??= {stage: 'measurement', code: 'metrics_missing'};
    return {stages, revision: build, heap_bytes: heap, ...(error ? {error} : {})};
  } catch {
    return failed('measurement', 'browser_unavailable', build);
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
  let authError = preflight.status() === 401 ? 'auth_expired' : preflight.ok() ? null : 'auth_unavailable';
  if (!authError) await auth.storageState({path: config.portal_state});
  if (!authError) {
    const pending = (await readFile(config.ledger_file, 'utf8').catch(error => {if (error.code === 'ENOENT') return ''; throw error;})).trim().split('\n').filter(Boolean);
    await cleanup(auth, new Set(pending));
    await writeFile(config.ledger_file, '', {mode: 0o600});
  }
  await auth.close();
  for (const app of Object.keys(apps)) for (const size of sizes) {
    const samples = {cold: [], warm: []};
    const checkedAt = {};
    if (authError) {
      samples.cold.push(failed('auth', authError, 'unavailable', false));
      for (let index = 0; index < warmSamples; index++) samples.warm.push(failed('auth', authError, 'unavailable', false));
      checkedAt.cold = checkedAt.warm = new Date().toISOString();
    } else {
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
        const cold = await visit(page, app, config.collections[size], true, config.collection_names[size], size === '10k' ? 600000 : 180000);
        samples.cold.push(cold);
        checkedAt.cold = new Date().toISOString();
        if (cold.error?.stage === 'auth') authError = cold.error.code;
        // Warm visits use the fully opened cold context, never a partial cache.
        for (let index = 0; index < warmSamples; index++) {
          samples.warm.push(cold.error ? failed(authError ? 'auth' : 'first_records', authError ?? 'cold_incomplete', cold.revision, false)
            : await visit(page, app, config.collections[size], false, config.collection_names[size], 45000));
        }
        checkedAt.warm = new Date().toISOString();
      } finally {
        try {
          // Retain the journal if auth expired; authenticated recovery revokes it.
          if (!authError) {
            await cleanup(context, installationIds);
            await writeFile(config.ledger_file, '', {mode: 0o600});
          }
        } finally {await context.close();}
      }
    }
    for (const mode of ['cold', 'warm']) {
      const timing = result(`${app}.${size}.${mode}`, samples[mode], checkedAt[mode]);
      const heaps = samples[mode].map(sample => sample.heap_bytes).filter(Number.isFinite);
      report.push({timing, samples: samples[mode].filter(sample => sample.visited !== false).length, heap_bytes_median: heaps.length ? median(heaps) : null});
      await writeFile(output, JSON.stringify(report, null, 2) + '\n', {mode: 0o600});
      if (!collectOnly) {
        const response = await fetch('https://ops-ingest.mdbase.dev/v1/timings', {
          method: 'POST', headers: {Authorization: `Bearer ${ingestToken}`, 'Content-Type': 'application/json'}, body: JSON.stringify(timing), signal: AbortSignal.timeout(15000),
        });
        if (!response.ok) throw Error(`ingest_http_${response.status}`);
      }
      console.log(JSON.stringify(timing));
    }
  }
} finally {await browser.close();}
