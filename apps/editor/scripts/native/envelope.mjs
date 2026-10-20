import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2];
const hash=async path=>createHash('sha256').update(await readFile(join(root,path))).digest('hex');
await writeFile(join(root,'envelope.json'),JSON.stringify({
  repository:process.env.GITHUB_REPOSITORY,run:process.env.GITHUB_RUN_ID,attempt:process.env.GITHUB_RUN_ATTEMPT,event:process.env.GITHUB_EVENT_NAME,ref:process.env.GITHUB_REF,
  source:process.env.SOURCE_SHA,tree:execFileSync('git',['rev-parse','HEAD^{tree}'],{encoding:'utf8'}).trim(),target:process.env.TARGET,
  inventorySha256:await hash('inventory.json'),planSha256:await hash('plan.json'),
},null,2));
