#!/usr/bin/env node
// Compile PUBLIC per-stack trust inputs; private signing key never leaves stack.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, sign } from 'node:crypto';
import { buildLocalAppTrust } from '../packages/sdk/scripts/build-app-trust.mjs';

export function buildLocalNativeTrust({ stackConfig, verifier, outputDirectory }) {
  const state = JSON.parse(fs.readFileSync(stackConfig, 'utf8'));
  const directory = path.dirname(path.resolve(stackConfig));
  if (state.environment !== 'local' || path.resolve(state.connectEnvFile ?? '') !== path.join(directory, 'job-env.json')
      || (fs.statSync(directory).mode & 0o777) !== 0o700)
    throw Error('protected local stack config required');
  const env = JSON.parse(fs.readFileSync(state.connectEnvFile, 'utf8'));
  const asset = path.join(directory, 'local-trust.json');
  const bytes = fs.readFileSync(asset);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const digest = createHash('sha256').update('mdbase/local-release-trust/1\n').update(bytes).digest();
  const signature = sign(null, digest, fs.readFileSync(path.join(directory, 'local-root.pem'))).toString('hex');
  const stackRoot = env.MDBASE_NEXT_ROOT_PUBLIC_KEY;
  const sourceVersion = 'local';
  // Signature verification checks exact loopback origins, source and independent
  // root before ANY compiler input is written. Never infer root/context from asset.
  const values = { SHA256: sha256, CP_ORIGIN: state.connectOrigin, LOG_ORIGIN: state.logOrigin,
    SOURCE_COMMIT: state.revision, SOURCE_VERSION: sourceVersion, STACK_ROOT: stackRoot, SIGNATURE: signature };
  fs.mkdirSync(outputDirectory, { recursive: true });
  const proofOutput = path.join(directory, 'native-verified-release.ts');
  buildLocalAppTrust({ verifier, asset, output: proofOutput, sha256, environment: 'local',
    cpOrigin: state.connectOrigin, logOrigin: state.logOrigin, sourceCommit: state.revision, sourceVersion, stackRoot, signature });
  fs.chmodSync(proofOutput, 0o600);
  // Every value is verifier-bounded ASCII (local version is a literal).
  const context = '// PUBLIC verified per-stack build inputs; never commit.\n' +
    Object.entries(values).map(([name, value]) => `pub const ${name}: &str = ${JSON.stringify(value)};`).join('\n') + '\n';
  fs.writeFileSync(path.join(outputDirectory, 'local.json'), bytes, { flag: 'wx', mode: 0o600 });
  fs.writeFileSync(path.join(outputDirectory, 'local-context.rs'), context, { flag: 'wx', mode: 0o600 });
  return { environment: 'local', sourceCommit: state.revision, sha256 };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [stackConfig, verifier] = process.argv.slice(2);
    if (!stackConfig || !verifier || process.argv.length !== 4) throw Error('local stack config and verifier required');
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = buildLocalNativeTrust({ stackConfig, verifier, outputDirectory: path.join(root, 'crates/daemon/trust') });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch {
    // Never surface key parsing/input contents through build diagnostics.
    process.stderr.write('Local native trust input generation refused.\n');
    process.exitCode = 1;
  }
}
