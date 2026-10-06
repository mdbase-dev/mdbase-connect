// Authenticated extension of an existing image release; no new signing anchor.
import { createHash } from 'node:crypto';
const REPOSITORY = 'mdbase-dev/mdbase-connect';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).sort().join(',') === [...keys].sort().join(',');
const positive = n => Number.isSafeInteger(n) && n > 0;
const commit = s => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
const digest = s => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);
const origin = s => { try { const u = new URL(s); return u.protocol === 'https:' && u.origin === s && !u.username && !u.password; } catch { return false; } };
function need(ok, message) { if (!ok) throw new Error(message); }

/** Caller authenticates the original image bundle BEFORE invoking this builder. */
export function buildTrustBundle({ imageBundleBytes, assetBytes, publication, qualification }) {
  const asset = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(assetBytes));
  const release = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(imageBundleBytes));
  need(release.schemaVersion === 1 && release.repository === REPOSITORY && commit(release.commit), 'image release identity');
  need(release.publication.workflow === 'publish-images.yml' && positive(release.publication.runId) && positive(release.publication.runAttempt), 'image publication');
  // Crypto/canonical payload validation belongs to the reference encoder, invoked
  // by the fixed publisher CLI. Never treat the calculated hash as authentication.
  need(asset.environment === 'lab', 'only the approved LAB publisher is enabled');
  need(assetBytes.length > 0 && assetBytes.length <= 65536, 'asset size');
  need(origin(asset.control_plane_origin) && origin(asset.log_origin), 'asset origins');
  need(exact(asset.source, ['repository', 'commit', 'version']) && asset.source.repository === release.repository && asset.source.commit === release.commit && asset.source.version === release.version, 'asset release binding');
  const manifest = {
    schemaVersion: 1, kind: 'mdbase-release-trust-bundle', repository: release.repository,
    commit: release.commit, version: release.version,
    imageBundle: { path: 'image-release-bundle.json', length: imageBundleBytes.length, sha256: sha(imageBundleBytes),
      publicationRunId: release.publication.runId, publicationRunAttempt: release.publication.runAttempt },
    publication, qualification,
    trustAssets: [{ path: 'next-trust/lab.json', length: assetBytes.length, sha256: sha(assetBytes),
      environment: asset.environment, controlPlaneOrigin: asset.control_plane_origin, logOrigin: asset.log_origin, source: asset.source }],
  };
  validateTrustBundle(manifest);
  return manifest;
}

/** Structure only. Signature, GitHub identity and expected context remain external. */
export function validateTrustBundle(m) {
  need(exact(m, ['schemaVersion','kind','repository','commit','version','imageBundle','publication','qualification','trustAssets']), 'manifest fields');
  need(m.schemaVersion === 1 && m.kind === 'mdbase-release-trust-bundle' && m.repository === REPOSITORY && commit(m.commit) && typeof m.version === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+-[0-9A-Za-z.-]+$/.test(m.version), 'manifest identity');
  need(exact(m.imageBundle, ['path','length','sha256','publicationRunId','publicationRunAttempt']) && m.imageBundle.path === 'image-release-bundle.json' && positive(m.imageBundle.length) && m.imageBundle.length <= 65536 && digest(m.imageBundle.sha256) && positive(m.imageBundle.publicationRunId) && positive(m.imageBundle.publicationRunAttempt), 'image bundle binding');
  need(exact(m.publication, ['workflow','runId','runAttempt','publisherCommit']) && m.publication.workflow === 'publish-images.yml' && positive(m.publication.runId) && positive(m.publication.runAttempt) && commit(m.publication.publisherCommit), 'trust publication');
  need(exact(m.qualification, ['workflow','runId','runAttempt']) && m.qualification.workflow === 'server-ci.yml' && positive(m.qualification.runId) && positive(m.qualification.runAttempt), 'publisher qualification');
  need(Array.isArray(m.trustAssets) && m.trustAssets.length === 1, 'exact approved asset set');
  const a = m.trustAssets[0];
  need(exact(a, ['path','length','sha256','environment','controlPlaneOrigin','logOrigin','source']) && a.path === 'next-trust/lab.json' && a.environment === 'lab' && positive(a.length) && a.length <= 65536 && digest(a.sha256) && origin(a.controlPlaneOrigin) && origin(a.logOrigin), 'asset binding');
  need(exact(a.source, ['repository','commit','version']) && a.source.repository === m.repository && a.source.commit === m.commit && a.source.version === m.version, 'asset source');
}
