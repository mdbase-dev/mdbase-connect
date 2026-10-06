#!/usr/bin/env node
// Run only after authenticating image-release-bundle.json with the pinned workflow.
import { readFile, writeFile, mkdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { encodeNextTrustPayload } from '../services/server/src/features/next/trust-payload.js';
import { validateReleaseBundle } from './lib/release-components.mjs';
import { buildTrustBundle } from './lib/release-trust-bundle.mjs';
const root = path.resolve(import.meta.dirname, '..');
const input = process.argv[2], output = process.argv[3];
if (!input || !output || process.argv.length !== 4) throw new Error('Expected authenticated image bundle and new output directory');
const file = path.join(root, 'config/next-trust/lab.json');
const info = await lstat(file);
if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw new Error('Invalid fixed LAB asset');
const bytes = await readFile(file);
const asset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
if (!Buffer.from(encodeNextTrustPayload(asset)).equals(bytes)) throw new Error('Noncanonical LAB asset');
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
await mkdir(path.join(output, 'next-trust'), { recursive: true });
await writeFile(path.join(output, 'next-trust/lab.json'), bytes, { flag:'wx' });
await writeFile(path.join(output, 'image-release-bundle.json'), imageBundleBytes, { flag:'wx' });
await writeFile(path.join(output, 'release-trust-bundle.json'), JSON.stringify(manifest, null, 2)+'\n', { flag:'wx' });
console.log('LAB trust asset and release-linked manifest built; authentication is supplied by the protected signing job.');
