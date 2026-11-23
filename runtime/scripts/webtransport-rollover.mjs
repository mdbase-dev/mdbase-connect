// Read-only fixture observations. Neither certificate keys nor bearer tokens leave their stores.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

export function enrollment(db, slot, pin, boundary) {
  function query(sql) {
    return JSON.parse(execFileSync('sqlite3', ['-readonly', '-json', db, sql], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000,
    }));
  }
  const leaves = query('SELECT slot, hex(cert) AS der FROM webtransport_leaf ORDER BY slot');
  assert.equal(leaves.length, 32);
  assert(leaves.every((leaf, i) => leaf.slot === slot + i));
  const [previous, next] = leaves.slice(0, 2).map(({ der }) => {
    const cert = new X509Certificate(Buffer.from(der, 'hex'));
    assert(Date.now() < Date.parse(cert.validFrom), 'native TLS test requires leaves outside real wall time');
    assert(Date.parse(cert.validFrom) < boundary && boundary < Date.parse(cert.validTo));
    return cert.fingerprint256.replaceAll(':', '').toLowerCase();
  });
  assert.equal(previous, pin);
  assert.notEqual(previous, next);
  const grant = () => query('SELECT hex(owner), origin, hex(digest), label FROM browser');
  const enrolled = grant();
  assert.equal(enrolled.length, 1);
  return { next, checkGrant() { assert.deepEqual(grant(), enrolled); } };
}

export async function sealedGrant(page, app) {
  return page.evaluate(async name => {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('mdbase-direct:' + name);
      req.onupgradeneeded = () => req.transaction.abort();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const saved = await new Promise((resolve, reject) => {
        const req = db.transaction('grant').objectStore('grant').get('browser');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      if (!saved.receipt || !saved.iv.byteLength || !saved.ciphertext.byteLength) throw Error('Missing sealed grant');
      const bytes = await new Blob([saved.server, saved.receipt, saved.iv, saved.ciphertext]).arrayBuffer();
      return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
    } finally { db.close(); }
  }, app);
}

// Probe the same native replica endpoint with one pin and no application data.
// A wrong pin must fail at TLS. Run a positive control from the same permitted page.
export async function acceptsOnly(page, endpoint, pin) {
  return page.evaluate(async ({ endpoint, pin }) => {
    const value = Uint8Array.from(pin.match(/../g), byte => parseInt(byte, 16));
    const transport = new WebTransport(endpoint + '/_mdbase/replica', {
      serverCertificateHashes: [{ algorithm: 'sha-256', value }],
    });
    transport.closed.catch(() => {});
    let timeout;
    try {
      return await Promise.race([
        transport.ready.then(() => true, () => false),
        new Promise((_, reject) => { timeout = setTimeout(() => reject(Error('pin probe timeout')), 10000); }),
      ]);
    } finally {
      clearTimeout(timeout);
      transport.close();
    }
  }, { endpoint, pin });
}
