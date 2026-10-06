#!/usr/bin/env node
// The caller MUST authenticate the manifest (pinned Sigstore identity + GitHub
// source/run/qualification checks) before using its digest. This is not that step.
import { readFile } from 'node:fs/promises';
import { validateNextTrustPayload } from '../services/server/src/features/next/trust-payload.js';
import { validateTrustBundle } from './lib/release-trust-bundle.mjs';
const [manifestPath, assetPath, commit, version, environment, cp, log] = process.argv.slice(2);
if (process.argv.length !== 9 || environment !== 'lab') throw new Error('Expected authenticated manifest, asset and independent approved LAB release/origin context');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
validateTrustBundle(manifest);
const entry = manifest.trustAssets[0];
if (manifest.commit !== commit || manifest.version !== version || entry.environment !== environment || entry.controlPlaneOrigin !== cp || entry.logOrigin !== log) throw new Error('Independent trust context mismatch');
const bytes = await readFile(assetPath);
if (bytes.length !== entry.length) throw new Error('Authenticated length mismatch');
validateNextTrustPayload(bytes, {
  sha256: entry.sha256, environment, controlPlaneOrigin: cp, logOrigin: log, now: Date.now(),
  source: { repository: 'mdbase-dev/mdbase-connect', commit, version },
});
console.log('Authenticated-context NEXT trust payload validation passed.');
