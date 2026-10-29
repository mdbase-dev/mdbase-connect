#!/usr/bin/env node
// Explicit BUILD-only, isolated SDK overlay. Never modifies managed src/dist.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, sign} from 'node:crypto';
import {buildLocalAppTrust} from './build-app-trust.mjs';
import {readPackagedSqlite} from './build-application-assets.mjs';
const sdkDirectory = fileURLToPath(new URL('..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const refuse = () => new Error('local SDK application build refused');

export function buildLocalApplication({stackConfig, verifier, runtimeFile, outputDirectory}) {
  let stage;
  try {
    const stackDirectory = path.dirname(path.resolve(stackConfig));
    const state = JSON.parse(fs.readFileSync(stackConfig, 'utf8'));
    const output = path.resolve(outputDirectory);
    // The signer and credentials never leave this trusted private stack. The
    // output is a separate public-only package, not an in-place/runtime override.
    if (state.environment !== 'local' || (fs.statSync(stackDirectory).mode & 0o777) !== 0o700
        || path.resolve(state.connectEnvFile ?? '') !== path.join(stackDirectory, 'job-env.json')
        || output.startsWith('/tmp/') || output === '/tmp' || fs.existsSync(output)
        || output === sdkDirectory || sdkDirectory.startsWith(output + path.sep)
        || output.startsWith(sdkDirectory + path.sep)) throw refuse();
    const env = JSON.parse(fs.readFileSync(state.connectEnvFile, 'utf8'));
    const asset = path.join(stackDirectory, 'local-trust.json');
    const bytes = fs.readFileSync(asset);
    const signature = sign(null, createHash('sha256').update('mdbase/local-release-trust/1\n').update(bytes).digest(),
      fs.readFileSync(path.join(stackDirectory, 'local-root.pem'))).toString('hex');
    stage = fs.mkdtempSync(path.join(stackDirectory, 'sdk-build-proof-'));
    const proof = path.join(stage, 'packaged-trust.ts');
    const verified = buildLocalAppTrust({verifier, asset, output: proof, sha256: hash(bytes), environment: 'local',
      cpOrigin: state.connectOrigin, logOrigin: state.logOrigin, sourceCommit: state.revision, sourceVersion: 'local',
      stackRoot: env.MDBASE_NEXT_ROOT_PUBLIC_KEY, signature});
    // Qualification is from the actual locally compiled runtime bytes, not LAB
    // bytes or a source stub. SQLite retains the existing locked-package pins.
    const runtime = fs.readFileSync(runtimeFile);
    if (runtime.length < 8 || runtime.length > 16 * 1024 * 1024 || !runtime.subarray(0, 8).equals(Buffer.from([0,97,115,109,1,0,0,0]))) throw refuse();
    const sqlite = readPackagedSqlite(sdkDirectory);
    const pins = JSON.parse(fs.readFileSync(path.join(sdkDirectory, 'src/application/asset-pins.json'), 'utf8'));
    pins.runtime = {sha256: hash(runtime), bytes: runtime.length, maxBytes: runtime.length};
    // Authenticate before creating any compiler inputs. All copies are public
    // source/package/dependency material; no stack config/env/key files are copied.
    fs.mkdirSync(path.dirname(output), {recursive: true, mode: 0o700});
    fs.mkdirSync(output, {mode: 0o700});
    for (const name of ['src', 'vendor', 'scripts', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json'])
      fs.cpSync(path.join(sdkDirectory, name), path.join(output, name), {recursive: true});
    fs.symlinkSync(path.join(sdkDirectory, 'node_modules'), path.join(output, 'node_modules'), 'dir');
    const flagPath = path.join(output, 'src/local-build.ts');
    const source = fs.readFileSync(flagPath, 'utf8');
    const literal = 'export const LOCAL_APPLICATION_BUILD: boolean = false;';
    if (source.split(literal).length !== 2) throw refuse();
    fs.writeFileSync(flagPath, source.replace(literal, 'export const LOCAL_APPLICATION_BUILD: boolean = true;'));
    fs.copyFileSync(proof, path.join(output, 'src/application/packaged-trust.ts'));
    fs.writeFileSync(path.join(output, 'src/application/asset-pins.json'), JSON.stringify(pins, null, 2) + '\n');
    const assetPath = path.join(output, 'src/application/packaged-assets.ts');
    const selector = fs.readFileSync(assetPath, 'utf8');
    const anchor = 'new URL("../native/runtime.wasm",import.meta.url)';
    if (selector.split(anchor).length !== 2) throw refuse();
    fs.writeFileSync(assetPath, selector.replace(anchor, 'new URL("../native/runtime-local.wasm",import.meta.url)'));
    const native = path.join(output, 'src/native');
    fs.mkdirSync(native, {recursive: true});
    fs.writeFileSync(path.join(native, 'runtime-local.wasm'), runtime);
    fs.writeFileSync(path.join(native, 'sqlite3.wasm'), sqlite.wasm);
    fs.writeFileSync(path.join(native, 'sqlite3.js'), sqlite.initializer);
    const provenance = {schema: 'mdbn-sdk/application-assets/1', environment: 'local', trust: {environment: verified.environment, assetSha256: verified.assetSha256},
      runtime: {...pins.runtime, qualification: 'actual local compiled raw WASM; integrity-pinned, not separately signed'},
      sqlite: pins.sqlite};
    // Only public metadata, and avoid recording private stack paths in package.
    fs.writeFileSync(path.join(native, 'provenance.local.json'), JSON.stringify(provenance, null, 2) + '\n');
    // The local packaging step cannot select the fixed LAB input/context. It
    // rechecks the generated byte pins before copying these already verified inputs.
    fs.writeFileSync(path.join(output, 'scripts/package-local-assets.mjs'), `import fs from 'node:fs';\nimport {createHash} from 'node:crypto';\nconst pins = JSON.parse(fs.readFileSync(new URL('../src/application/asset-pins.json', import.meta.url)));\nconst root = new URL('../dist/native/', import.meta.url); fs.mkdirSync(root, {recursive:true});\nfor (const [name,pin] of [['runtime-local.wasm',pins.runtime],['sqlite3.wasm',pins.sqlite],['sqlite3.js',pins.sqlite.initializer]]) {\n const bytes=fs.readFileSync(new URL('../src/native/'+name,import.meta.url));\n if(bytes.length!==pin.bytes || createHash('sha256').update(bytes).digest('hex')!==pin.sha256) throw Error('local SDK byte qualification refused');\n fs.writeFileSync(new URL(name,root),bytes);\n}\nfs.copyFileSync(new URL('../src/native/provenance.local.json',import.meta.url),new URL('provenance.local.json',root));\n`);
    const pkgPath = path.join(output, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkg.scripts.build = 'tsc -p tsconfig.build.json && node scripts/package-local-assets.mjs && node scripts/build-browser.mjs';
    fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    return {environment: 'local', assetSha256: verified.assetSha256, runtimeSha256: pins.runtime.sha256, output};
  } catch { throw refuse(); }
  finally { if (stage) fs.rmSync(stage, {recursive: true}); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [stackConfig, verifier, runtimeFile, outputDirectory] = process.argv.slice(2);
    if (!stackConfig || !verifier || !runtimeFile || !outputDirectory || process.argv.length !== 6) throw refuse();
    console.log(JSON.stringify(buildLocalApplication({stackConfig, verifier, runtimeFile, outputDirectory})));
  } catch { console.error('Local SDK application build refused.'); process.exitCode = 1; }
}
