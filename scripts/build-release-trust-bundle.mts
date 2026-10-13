#!/usr/bin/env node
// Run only after authenticating image-release-bundle.json with the pinned workflow.
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { encodeNextTrustPayload } from '../services/server/src/features/next/trust-payload.js';
import { validateReleaseBundle } from './lib/release-components.mjs';
import { buildTrustBundle } from './lib/release-trust-bundle.mjs';
const root = path.resolve(import.meta.dirname, '..');
const input = process.argv[2], output = process.argv[3], environment = process.argv[4];
if (!input || !output || process.argv.length !== 5 || (environment !== 'lab' && environment !== 'staging')) throw new Error('Expected authenticated image bundle, new output directory and fixed lab|staging environment');
// No caller-selected path, origin, root or fallback. Absent staging asset refuses.
const assetPath = `next-trust/${environment}.json`;
const file = path.join(root, 'config', assetPath);
const info = await lstat(file);
if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid fixed environment asset');
const bytes = await readFile(file);
const asset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
if (asset.environment !== environment) throw new Error('Fixed asset environment mismatch');
if (!Buffer.from(encodeNextTrustPayload(asset)).equals(bytes)) throw new Error('Noncanonical environment asset');
const imageBundleBytes = await readFile(input);
if (imageBundleBytes.length > 65536) throw new Error('Image bundle size');
const release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(imageBundleBytes));
const contract = JSON.parse(await readFile(path.join(root, 'config/release-components.json'), 'utf8'));
const failures = validateReleaseBundle(contract, release);
if (failures.length) throw new Error(failures.join('\n'));
if (release.commit !== process.env.SOURCE_COMMIT || asset.issued_at > Date.now()) throw new Error('Release source/time binding');
const manifest = buildTrustBundle({ imageBundleBytes, assetBytes: bytes,
  publication: { workflow:'publish-images.yml', runId:Number(process.env.GITHUB_RUN_ID),
    runAttempt:Number(process.env.GITHUB_RUN_ATTEMPT), publisherCommit:process.env.GITHUB_SHA },
  qualification: { workflow:'server-ci.yml', runId:Number(process.env.PUBLISHER_QUALIFICATION_RUN_ID),
    runAttempt:Number(process.env.PUBLISHER_QUALIFICATION_RUN_ATTEMPT) } });
await mkdir(output);
await mkdir(path.join(output, 'next-trust'));
await writeFile(path.join(output, assetPath), bytes, { flag:'wx' });
await writeFile(path.join(output, 'image-release-bundle.json'), imageBundleBytes, { flag:'wx' });
await writeFile(path.join(output, 'release-trust-bundle.json'), JSON.stringify(manifest, null, 2)+'\n', { flag:'wx' });
console.log('Fixed environment trust asset and release-linked manifest built; authentication is supplied by the protected signing job.');
