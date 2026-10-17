import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {buildLocalNativeTrust} from './build-local-native-trust.mjs';

const parent = path.resolve('.artifacts/native-trust-builder-tests');
for (const refusal of ['managed-environment', 'unprotected-directory', 'external-credentials']) {
  test(`refuses ${refusal} before reading private keys or writing compiler inputs`, () => {
    fs.mkdirSync(parent, {recursive: true, mode: 0o700});
    const directory = fs.mkdtempSync(path.join(parent, 'stack-'));
    try {
      fs.chmodSync(directory, refusal === 'unprotected-directory' ? 0o755 : 0o700);
      const stackConfig = path.join(directory, 'local-stack.json');
      const outputDirectory = path.join(directory, 'compiler');
      fs.writeFileSync(stackConfig, JSON.stringify({environment: refusal === 'managed-environment' ? 'lab' : 'local',
        connectEnvFile: path.join(directory, refusal === 'external-credentials' ? 'wrong.json' : 'job-env.json')}), {mode: 0o600});
      // No private keys, credentials, trust verifier or asset exist. Guarding
      // must finish before trying to read any of them, not merely fail later.
      assert.throws(() => buildLocalNativeTrust({stackConfig, outputDirectory, verifier: 'never-executed'}), /protected local stack config required/);
      assert.equal(fs.existsSync(outputDirectory), false);
    } finally {
      fs.rmSync(directory, {recursive: true});
    }
  });
}
