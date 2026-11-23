// UNPRIVILEGED ONLY: all original members before build/package execution.
import { execFileSync } from 'node:child_process';
import { cp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { compareInstalled } from './originals.mjs';
import { publicationInventory, serializeInventory } from './publisher.mjs';
import { SELF_HOSTED, planned, selfHostedInventory } from './self-hosted.mjs';
const output=resolve(process.argv[2]);
const plan=JSON.parse(await readFile(join(output,'plan.json'),'utf8'));
await compareInstalled(process.cwd(),plan.sdkTrust.archives);
delete process.env.GITHUB_TOKEN;
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
// Production only, and only for a source that opts in: the separate self-hosted
// Editor from the same frozen install. Its origin is baked in at build time. The
// managed build above receives MDBASE_EDITOR_DIRECT_ORIGIN only when the
// workflow sets it, to show its "Connect to your own server" link.
if(plan.target==='production' && planned(plan.sha,process.cwd())) {
 const env=Object.fromEntries(Object.entries(process.env).filter(([name])=>!/^(VITE_|MDBASE_)/.test(name)));
 execFileSync('pnpm',['--filter','mdbase-editor','build:direct'],{stdio:'inherit',env:{...env,
  MDBASE_EDITOR_DIRECT_ORIGIN:SELF_HOSTED.origin,MDBASE_EDITOR_BUILD_ID:plan.sha}});
 await cp('apps/editor/dist-direct',join(output,'self-hosted/publish'),{recursive:true,errorOnExist:true,force:false});
 await writeFile(join(output,'self-hosted/inventory.json'),serializeInventory(await selfHostedInventory(join(output,'self-hosted/publish'),plan.sha,{root:process.cwd()})));
}
