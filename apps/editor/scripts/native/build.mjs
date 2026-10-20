// UNPRIVILEGED ONLY: all original members before build/package execution.
import { execFileSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { loadOriginals, protectedHashes } from './originals.mjs';
import { publicationInventory, serializeInventory } from './publisher.mjs';
const output=resolve(process.argv[2]);
const plan=JSON.parse(await readFile(join(output,'plan.json'),'utf8'));
const originals=await loadOriginals({target:plan.target,repoRoot:process.cwd(),hashes:protectedHashes(),installed:true});
if(JSON.stringify(originals)!==JSON.stringify(plan.sdkTrust))throw Error('Installed original intake differs from guarded source');
const run=args=>execFileSync('pnpm',args,{stdio:'inherit',env:{...process.env,
  MDBASE_ENV:plan.target,VITE_MDBASE_ENV:plan.target,MDBASE_EDITOR_ORIGIN:plan.origin,
  MDBASE_EDITOR_BASE_PATH:'/',MDBASE_CONNECT_URL:plan.sdkTrust.release.cpOrigin,
  MDBASE_EDITOR_BUILD_ID:plan.sha,VITE_MDBASE_EDITOR_DEMO:'0'}});
run(['rebuild','--pending']);
run(['build:packages']);
run(['--filter','mdbase-editor','build']);
run(['--filter','mdbase-editor','check:bundle']);
run(['--filter','mdbase-editor','check:csp']);
await cp('apps/editor/dist',join(output,'publish'),{recursive:true,errorOnExist:true,force:false});
await writeFile(join(output,'inventory.json'),serializeInventory(await publicationInventory(join(output,'publish'),plan)));
