// Install ONLY the dedicated official deploy-tool lock. Never app/workspace code.
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function installTool(base, { run=execFileSync }={}) {
 const tool=await mkdtemp(join(resolve(base),'editor-tool-'));
 const home=join(tool,'home');await mkdir(home);
 const user=join(tool,'empty-user.npmrc'),global=join(tool,'empty-global.npmrc');
 // npm rejects loading the same path twice (including /dev/null). Distinct files.
 await writeFile(user,'');await writeFile(global,'');
 const source=fileURLToPath(new URL('../../../../tools/editor-native-publisher/',import.meta.url));
 for(const path of ['package.json','package-lock.json'])await cp(join(source,path),join(tool,path));
 const lock=JSON.parse(await readFile(join(tool,'package-lock.json'),'utf8'));
 if(lock.packages[''].dependencies.wrangler!=='4.114.0' || lock.packages['node_modules/wrangler'].version!=='4.114.0' ||
   Object.entries(lock.packages).some(([path,value])=>path && (!/^sha512-/.test(value.integrity??'') || !value.resolved?.startsWith('https://registry.npmjs.org/'))))throw Error('Unreviewed minimal tool lock');
 run('npm',['ci','--ignore-scripts','--no-audit','--no-fund','--workspaces=false','--userconfig',user,'--globalconfig',global],{
  cwd:tool,stdio:'inherit',env:{PATH:process.env.PATH,HOME:home,TMPDIR:resolve(base),NPM_CONFIG_CACHE:join(tool,'cache'),NPM_CONFIG_UPDATE_NOTIFIER:'false'},
 });
 if(JSON.parse(await readFile(join(tool,'node_modules/wrangler/package.json'),'utf8')).version!=='4.114.0')throw Error('Wrong installed Wrangler');
 return join(tool,'node_modules/wrangler/bin/wrangler.js');
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
 const path=await installTool(process.env.RUNNER_TEMP);
 await writeFile(process.argv[2],path+'\n');
}
