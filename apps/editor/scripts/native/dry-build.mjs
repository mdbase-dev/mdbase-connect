// Credential-free rehearsal only: no dispatch admission, artifact upload or deploy.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOriginals } from './originals.mjs';
import { deploymentFor } from './refs.mjs';
import { prepareInstall } from './install-inputs.mjs';
const [target,sha]=process.argv.slice(2),binding=deploymentFor(target);
if(!/^[a-f0-9]{40}$/.test(sha??''))throw Error('Provide the full rehearsal source SHA');
const root=fileURLToPath(new URL('../../../../',import.meta.url));
process.chdir(root);
const trust=JSON.parse(await readFile('config/release-components.json','utf8')).sdkPublication.environments[target];
const sdkTrust=await loadOriginals({target,repoRoot:root,hashes:{EDITOR_TRUST_ASSET_SHA256:trust.sha256}});
const plan={sha,target,origin:binding.origin,pagesBranch:binding.branch,sdkTrust};
const directory=await mkdtemp(join(tmpdir(),'editor-dry-build-'));
const originalPackage=await readFile('apps/editor/package.json'),originalLock=await readFile('pnpm-lock.yaml');
try {
 await writeFile(join(directory,'plan.json'),JSON.stringify(plan,null,2));
 await prepareInstall(plan,root);
 execFileSync('pnpm',['install','--frozen-lockfile','--ignore-scripts','--ignore-pnpmfile'],{stdio:'inherit'});
 execFileSync(process.execPath,['apps/editor/scripts/native/build.mjs',directory],{stdio:'inherit',env:{...process.env,
  VITE_MDBASE_FEEDBACK_URL:target==='production'?'https://feedback-api.mdbase.dev/v1/feedback':'https://feedback-api-staging.mdbase.dev/v1/feedback',
  VITE_MDBASE_TURNSTILE_SITE_KEY:target==='production'?'0x4AAAAAAEboz_mLT-taI3H-':'0x4AAAAAAEbkvA4d9vQJq2D1'}});
 console.log('Authenticated '+target+' dry build and full publication inventory passed.');
}finally {
 await writeFile('apps/editor/package.json',originalPackage);await writeFile('pnpm-lock.yaml',originalLock);
 await rm('apps/editor/vendor/sdk-staging.tgz',{force:true});await rm(directory,{recursive:true,force:true});
}
