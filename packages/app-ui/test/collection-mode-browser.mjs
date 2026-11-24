// Browser qualification of the real compiled shared control. Boundary responses
// are synthetic; this is UI interruption/intent evidence, not conversion LAB E2E.
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const req = createRequire(new URL('../../../package.json', import.meta.url));
const { chromium } = req('@playwright/test');
// Reuse the existing workspace esbuild dependency; no new production dependency.
const { build } = createRequire(new URL('../../../apps/desktop/package.json', import.meta.url))('esbuild');

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const screenshotDir = fileURLToPath(new URL('../test-results/mode-switch/', import.meta.url));
await mkdir(screenshotDir, { recursive: true });

const [tokensCss, paletteCss, controlsCss] = await Promise.all([
  readFile(new URL('../css/tokens.css', import.meta.url), 'utf8'),
  readFile(new URL('../css/palette.css', import.meta.url), 'utf8'),
  readFile(new URL('../css/controls.css', import.meta.url), 'utf8')
]);
const fixtureStyles = `${tokensCss}\n${paletteCss}\n${controlsCss}\nbody{margin:0;padding:24px;background:var(--color-canvas);color:var(--color-text);font-family:var(--sans);max-width:600px;}`;

const { outputFiles } = await build({
  stdin: {
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { CollectionModeControl } from './dist/CollectionModeControl.js';

      const api = async (path, body) => {
        const r = await fetch(path, {
          method: body ? 'POST' : 'GET',
          headers: { 'content-type': 'application/json' },
          body: body && JSON.stringify(body)
        });
        if (!r.ok) {
          let payload = null;
          try { payload = await r.json(); } catch {}
          const err = new Error(payload?.error?.message ?? 'unconfirmed');
          if (payload?.error?.code) err.details = { code: payload.error.code };
          throw err;
        }
        return r.json();
      };

      const deviceNames = {
        '99999999-9999-4999-8999-999999999999': 'MacBook Pro'
      };

      function App() {
        const [id, setId] = React.useState('one');
        const [refreshes, setRefreshes] = React.useState([]);
        window.fixtureSelect = setId;
        window.fixtureRefreshes = () => refreshes;
        return React.createElement(CollectionModeControl, {
          collectionId: id,
          native: location.pathname === '/native',
          deviceNames,
          load: () => api('/status/' + id),
          change: (target, request) => api('/change', { target, request }),
          cancel: (target, request) => api('/cancel', { target, request }),
          abandon: (request) => api('/abandon', { request }),
          onModeChange: (mode) => setRefreshes((list) => [...list, mode])
        });
      }

      createRoot(document.getElementById('root')).render(React.createElement(App));
    `,
    resolveDir: packageDir,
    loader: 'js'
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  write: false
});

const bundle = outputFiles[0].text;
const browser = await chromium.launch({ headless: true });
const base = (mode = 'cloud_copy', change = null) => ({ current_mode: mode, execution_available: true, change });

try {
  for (const native of [false, true]) {
    let state = base();
    let post = async () => ({ phase: 'waiting_for_device' });
    let abandonPost = async () => ({ phase: 'abandoned' });
    let calls = [];
    const page = await browser.newPage({ viewport: { width: 680, height: 520 } });
    await page.clock.install({ time: new Date('2026-11-24T12:00:00Z') });

    await page.route('https://mode.fixture/**', async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === '/fixture.js') return route.fulfill({ contentType: 'text/javascript', body: bundle });
      if (url.pathname === '/fixture.css') return route.fulfill({ contentType: 'text/css', body: fixtureStyles });
      if (['/native', '/portal'].includes(url.pathname)) {
        return route.fulfill({
          contentType: 'text/html',
          body: '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><div id="root"></div><script src="/fixture.js"></script>'
        });
      }
      if (url.pathname.startsWith('/status/')) {
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(state) });
      }
      if (url.pathname === '/change') {
        const input = route.request().postDataJSON();
        calls.push(input);
        const result = await post(input);
        if (result.status && result.status >= 400) {
          return route.fulfill({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
        }
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      }
      if (url.pathname === '/cancel') {
        state = base();
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ phase: 'cancelled' }) });
      }
      if (url.pathname === '/abandon') {
        const input = route.request().postDataJSON();
        const result = await abandonPost(input);
        return route.fulfill({ contentType: 'application/json', body: JSON.stringify(result) });
      }
      throw Error(`unexpected fixture request: ${url.pathname}`);
    });

    const open = () => page.goto('https://mode.fixture/' + (native ? 'native' : 'portal'));
    const shot = async (name) => {
      await page.mouse.move(1, 1);
      await page.screenshot({ path: `${screenshotDir}${name}`, animations: 'disabled' });
    };

    // Hidden when executor unavailable.
    state = { ...base(), execution_available: false };
    await open();
    await page.waitForTimeout(30);
    assert.equal(await page.getByRole('button').count(), 0);

    // Idle Cloud copy with current-mode summary, switching-to-Private note, and no Refresh status.
    state = base();
    await open();
    await page.getByRole('button', { name: 'Make private', exact: true }).waitFor();
    await page.getByText(/mdbase keeps a copy it can read/).waitFor();
    await page.getByText(/Switching to Private:.*Apps connected to this collection will need to be reconnected afterwards\./).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Refresh status' }).count(), 0, 'Refresh status must not show when idle');
    if (!native) await shot('idle-cloud-copy.png');

    // Declined confirmation (not_confirmed) -> no error, back to idle.
    post = async () => ({ status: 403, body: { error: { code: 'not_confirmed', message: "not confirmed on this computer's screen" } } });
    await page.getByRole('button', { name: 'Make private', exact: true }).click();
    await page.waitForTimeout(50);
    assert.equal(await page.getByRole('alert').count(), 0, 'declined confirmation must not show an alert');
    assert.equal(await page.getByRole('button', { name: 'Make private', exact: true }).count(), 1);

    // keyed_owner_required -> calm explanation, not interrupted-switch alert.
    post = async () => ({ status: 409, body: { error: { code: 'keyed_owner_required', message: 'keyed owner required' } } });
    await page.getByRole('button', { name: 'Make private', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /holds this collection’s key/ }).waitFor();
    assert.equal(await page.getByText(/interrupted switch/).count(), 0);

    // Older-devices blocker with resolved name + short ID fallback, persists across polling & reload.
    const namedId = '99999999-9999-4999-8999-999999999999';
    const unnamedId = '88888888-8888-4888-8888-888888888888';
    post = async (input) => {
      state = base('cloud_copy', { request_id: input.request, source_mode: 'cloud_copy', target_mode: input.target, phase: 'waiting_for_device' });
      return { phase: 'waiting_for_devices', devices: [namedId, unnamedId] };
    };
    await page.getByRole('button', { name: 'Make private', exact: true }).click();
    await page.getByText('MacBook Pro', { exact: true }).waitFor();
    await page.getByText('Device 88888888', { exact: true }).waitFor();
    assert.equal(await page.getByText(namedId).count(), 0, 'raw UUID must not appear');
    assert.equal(await page.getByText(unnamedId).count(), 0, 'raw UUID must not appear');
    assert.equal(await page.getByRole('button', { name: 'Continue on this device' }).count(), native ? 1 : 0);
    assert.equal(await page.getByRole('button', { name: 'Refresh status' }).count(), 0, 'Refresh status must not show without error');
    assert.equal(await page.getByText(/Apps connected to this collection will need to be reconnected afterwards\./).count(), 0, 'idle note must hide while pending');
    if (native) await shot('older-devices-blocker.png');

    // Persists across background poll and page reload!
    await page.clock.fastForward(10_000);
    await page.getByText('MacBook Pro', { exact: true }).waitFor();
    await open();
    await page.getByText('MacBook Pro', { exact: true }).waitFor();
    await page.getByText('Device 88888888', { exact: true }).waitFor();

    // Cancel clears blocker and returns to idle.
    await page.getByRole('button', { name: 'Cancel switch' }).click();
    await page.getByRole('button', { name: 'Make private', exact: true }).waitFor();
    assert.equal(await page.getByText('MacBook Pro').count(), 0);

    // Unknown error preserves request ID, shows interrupted-switch warning, and reveals Refresh status retry.
    calls = [];
    post = async () => ({ status: 503, body: { error: { code: 'unknown', message: 'unconfirmed' } } });
    await page.getByRole('button', { name: 'Make private', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: /An interrupted switch may already have started/ }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Refresh status', exact: true }).count(), 1, 'Refresh status appears after status/unknown error');

    // Retry reaches waiting_for_token_expiry with countdown (~12 minutes) and NO Continue or Refresh button.
    const retryAt = '2026-11-24T12:12:00Z';
    post = async (input) => {
      state = base('cloud_copy', { request_id: input.request, source_mode: 'cloud_copy', target_mode: input.target, phase: 'waiting_for_token_expiry', retry_at: retryAt });
      return { phase: 'waiting_for_token_expiry', retry_at: retryAt };
    };
    await page.getByRole('button', { name: 'Make private', exact: true }).click();
    await page.locator('.mdbase-collection-mode-note time').filter({ hasText: /12 minutes/ }).waitFor();
    assert.equal(calls[0].request, calls[1].request, 'retry must preserve exact request ID');
    assert.equal(await page.getByRole('button', { name: 'Continue on this device' }).count(), 0, 'daemon drives token expiry');
    assert.equal(await page.getByRole('button', { name: 'Refresh status' }).count(), 0);
    // Verify typography scale: status text is not larger than h3/body, and caption is smaller than status text.
    const sizes = await page.evaluate(() => {
      const h3 = parseFloat(getComputedStyle(document.querySelector('.mdbase-collection-mode h3')).fontSize);
      const current = parseFloat(getComputedStyle(document.querySelector('.mdbase-collection-mode-current')).fontSize);
      const status = parseFloat(getComputedStyle(document.querySelector('.mdbase-collection-mode [role="status"]')).fontSize);
      const caption = parseFloat(getComputedStyle(document.querySelector('.mdbase-collection-mode-note')).fontSize);
      return { h3, current, status, caption };
    });
    assert.ok(sizes.status <= sizes.h3 && sizes.status === sizes.current && sizes.caption < sizes.status, `unexpected type scale: ${JSON.stringify(sizes)}`);
    if (!native) await shot('waiting-for-token-expiry.png');

    // Cloud->Private finishing: shows source mode (Cloud copy), clears stale token-expiry time, offers confirmed Stop this switch (abandon).
    state = base('cloud_copy', { request_id: calls[1].request, source_mode: 'cloud_copy', target_mode: 'private', phase: 'finishing' });
    await page.clock.fastForward(10_000);
    await page.getByRole('button', { name: 'Stop this switch', exact: true }).waitFor();
    assert.equal(await page.locator('time').count(), 0, 'token-expiry countdown must clear once finishing');
    assert.equal(await page.locator('.mdbase-collection-mode-current strong').innerText(), 'Cloud copy');
    assert.equal(await page.getByRole('button', { name: 'Continue on this device' }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'Refresh status' }).count(), 0);

    await page.getByRole('button', { name: 'Stop this switch', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Stop this switch to Private?' });
    await dialog.waitFor();
    if (!native) await shot('abandon-confirm-dialog.png');

    abandonPost = async (input) => {
      state = base('private', { request_id: input.request, source_mode: 'cloud_copy', target_mode: 'private', phase: 'abandoned' });
      return { request_id: input.request, phase: 'abandoned' };
    };
    await dialog.getByRole('button', { name: 'Stop this switch', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await page.getByRole('status').filter({ hasText: /The switch to Private was stopped/ }).waitFor();
    assert.equal(await page.getByRole('button').count(), 0, 'abandoned state offers no buttons');
    if (!native) await shot('abandoned-state.png');

    // Idle Private -> screenshot, then Private->Cloud finishing: server flips current_mode to cloud_copy early, but UI keeps showing Private until complete!
    state = base('private');
    await open();
    await page.getByRole('button', { name: 'Turn on Cloud copy', exact: true }).waitFor();
    await page.getByText(/Only your devices can read it\./).waitFor();
    if (!native) await shot('idle-private.png');

    post = async (input) => {
      // Simulate server flipping current_mode early at /prepare before Workers are keyed!
      state = base('cloud_copy', { request_id: input.request, source_mode: 'private', target_mode: 'cloud_copy', phase: 'finishing' });
      return { phase: 'finishing' };
    };
    await page.getByRole('button', { name: 'Turn on Cloud copy', exact: true }).click();
    await page.getByRole('status').filter({ hasText: /Switching to Cloud copy — finishing/ }).waitFor();
    assert.equal(await page.locator('.mdbase-collection-mode-current strong').innerText(), 'Private', 'must display source mode while finishing');
    assert.equal(await page.getByRole('button').count(), 0, 'no buttons during Private->Cloud finishing');
    if (native) await shot('finishing-source-mode.png');

    // Auto-polling detects completion (3s interval) and invokes onModeChange!
    state = base('cloud_copy', null);
    await page.clock.fastForward(3_000);
    await page.getByRole('button', { name: 'Make private', exact: true }).waitFor();
    assert.equal(await page.locator('.mdbase-collection-mode-current strong').innerText(), 'Cloud copy');
    const refreshes = await page.evaluate(() => window.fixtureRefreshes());
    assert.ok(refreshes.includes('cloud_copy'), `expected onModeChange("cloud_copy"), got ${JSON.stringify(refreshes)}`);

    await page.close();
    console.log('PASS:', native ? 'native adapter' : 'portal adapter', 'declined, keyed_owner_required, named/short-id blocker + reload persistence, waiting_for_token_expiry countdown, abandon dialog + abandoned phase, finishing source-mode + auto-poll completion refresh');
  }
} finally {
  await browser.close();
}
