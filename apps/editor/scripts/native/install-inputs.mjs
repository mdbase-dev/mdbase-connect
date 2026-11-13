// Derive the staging install from the authenticated plan, never repack the SDK.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveBytes } from './authentication.mjs';
export async function prepareInstall(plan,root=process.cwd(),fetchImpl=fetch) {
 if(plan.target==='production')return;
 if(plan.target!=='staging')throw Error('Unknown install target');
 const archive=plan.sdkTrust.archives.sdk;
 const bytes=await archiveBytes(archive.path,fetchImpl);
 if(createHash('sha256').update(bytes).digest('hex')!==archive.sha256)throw Error('Staging install archive mismatch');
 const path='apps/editor/vendor/sdk-staging.tgz';
 await writeFile(join(root,path),bytes);
 const manifestPath=join(root,'apps/editor/package.json');
 const pkg=JSON.parse(await readFile(manifestPath,'utf8'));
 if(pkg.dependencies['@mdbase-dev/sdk']!=='file:vendor/'+basename(plan.sdkTrust.production.path))throw Error('Production install pin changed');
 pkg.dependencies['@mdbase-dev/sdk']='file:vendor/sdk-staging.tgz';
 await writeFile(manifestPath,JSON.stringify(pkg,null,2)+'\n');
 const lockPath=join(root,'pnpm-lock.yaml');
 const lock=await readFile(lockPath,'utf8');
 if(createHash('sha256').update(lock).digest('hex')!==plan.sdkTrust.lockSha256)throw Error('Source lock changed');
 const stagingPath='file:apps/editor/vendor/sdk-staging.tgz';
 const alias='@mdbase-dev/sdk-staging@'+stagingPath;
 // pnpm's file alias must name the actual archive package, including UI peers.
 // Keep the application import name @mdbase-dev/sdk, not the production identity.
 // Other workspace packages may resolve the byte-identical registry SDK with the same
 // integrity, so change only the vendored entry's own resolution, never the SRI globally.
 const productionFile='file:apps/editor/vendor/'+basename(plan.sdkTrust.production.path);
 const resolution=(sri,file)=>`\n  '@mdbase-dev/sdk@${file}':\n    resolution: {integrity: ${sri}, tarball: ${file}}\n`;
 const vendored=resolution(plan.sdkTrust.production.sri,productionFile);
 if(lock.split(vendored).length!==2)throw Error('Vendored SDK lock entry not found exactly once');
 const staged=lock.replace(vendored,()=>resolution(archive.sri,productionFile))
  .replaceAll(basename(plan.sdkTrust.production.path),'sdk-staging.tgz')
  .replaceAll('@mdbase-dev/sdk@'+stagingPath,alias)
  .replaceAll('version: '+stagingPath,"version: '"+alias+"'")
  .replaceAll("'@mdbase-dev/sdk': "+stagingPath,"'@mdbase-dev/sdk': '"+alias+"'");
 await writeFile(lockPath,staged);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await prepareInstall(JSON.parse(await readFile(process.argv[2],'utf8')));
