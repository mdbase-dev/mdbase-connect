// Derive the staging install from the authenticated plan, never repack the SDK.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { basename, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { archiveBytes } from './authentication.mjs';
const DEPENDENCY_SECTIONS=new Set(['dependencies','devDependencies','optionalDependencies']);
const STAGING_PATH='apps/editor/vendor/sdk-staging.tgz';
function unquote(value) {
 const trimmed=value.trim();
 if(trimmed.length>=2 && trimmed.startsWith("'") && trimmed.endsWith("'"))return trimmed.slice(1,-1).replaceAll("''","'");
 if(trimmed.length>=2 && trimmed.startsWith('"') && trimmed.endsWith('"'))return JSON.parse(trimmed);
 return trimmed;
}
function safeImporterPath(importer) {
 if(importer==='.')return '.';
 if(!importer || importer.startsWith('/') || importer.endsWith('/'))throw Error('Unsafe importer path in lockfile');
 if(!importer.split('/').every(part=>/^[\w.@~-]+$/.test(part) && part!=='.' && part!=='..'))throw Error('Unsafe importer path in lockfile');
 return importer;
}
async function regularFile(realRoot,relPath) {
 const fullPath=join(realRoot,relPath);
 if(!(await lstat(fullPath)).isFile() || await realpath(fullPath)!==fullPath)throw Error('Unsafe input path: '+relPath);
 return fullPath;
}
export function productionSdkTargets(lock,productionPath) {
 if(!/^apps\/editor\/vendor\/[\w.-]+\.tgz$/.test(productionPath??'') || productionPath===STAGING_PATH)throw Error('Invalid production SDK path');
 const productionName=basename(productionPath),productionFile='file:'+productionPath,entries=[];
 let inImporters=false,importer=null,section=null,dep=null;
 const flush=()=>{
  if(!dep)return;
  const {importer:imp,section:sec,name,specifier,version}=dep;
  dep=null;
  const expectedSpec='file:'+posix.relative(imp,productionPath);
  const resolvesToProduction=typeof specifier==='string' && specifier.startsWith('file:') &&
   !specifier.slice('file:'.length).startsWith('/') &&
   posix.normalize(posix.join(imp,specifier.slice('file:'.length)))===productionPath;
  const isDirectVersion=version===productionFile || version===`@mdbase-dev/sdk@${productionFile}` ||
   version?.startsWith(productionFile+'(') || version?.startsWith(`@mdbase-dev/sdk@${productionFile}(`);
  const mentionsProduction=typeof specifier==='string' && specifier.includes(productionName);
  if(!resolvesToProduction && !isDirectVersion && !mentionsProduction)return;
  if(name!=='@mdbase-dev/sdk')throw Error('Unexpected dependency referencing vendored production SDK');
  if(specifier!==expectedSpec || version!==productionFile)throw Error('Production install lock entry mismatch');
  entries.push({importer:imp,manifest:imp==='.'?'package.json':posix.join(imp,'package.json'),section:sec,name,expectedSpec,
   stagingSpec:'file:'+posix.relative(imp,STAGING_PATH)});
 };
 for(const rawLine of lock.split('\n')) {
  const line=rawLine.endsWith('\r')?rawLine.slice(0,-1):rawLine;
  if(!line.trim() || /^\s*#/.test(line))continue;
  if(/^\S/.test(line)){flush();inImporters=line.trim()==='importers:';importer=null;section=null;continue;}
  if(!inImporters)continue;
  const impMatch=/^  ([^ ][^:]*):(?:\s*\{\s*\})?\s*$/.exec(line);
  if(impMatch){flush();importer=safeImporterPath(unquote(impMatch[1]));section=null;continue;}
  const secMatch=/^    ([^ ][^:]*):/.exec(line);
  if(secMatch){flush();const candidate=unquote(secMatch[1]);section=DEPENDENCY_SECTIONS.has(candidate)?candidate:null;continue;}
  const depMatch=/^      ([^ ][^:]*):\s*$/.exec(line);
  if(depMatch){flush();dep=importer && section?{importer,section,name:unquote(depMatch[1]),specifier:undefined,version:undefined}:null;continue;}
  const propMatch=/^        (specifier|version):\s*(.+?)\s*$/.exec(line);
  if(propMatch && dep)dep[propMatch[1]]=unquote(propMatch[2]);
 }
 flush();
 if(!entries.some(e=>e.importer==='apps/editor' && e.section==='dependencies' && e.name==='@mdbase-dev/sdk'))
  throw Error('Production install pin changed');
 return entries;
}
export async function prepareInstall(plan,root=process.cwd(),fetchImpl=fetch) {
 if(plan.target==='production')return;
 if(plan.target!=='staging')throw Error('Unknown install target');
 const archive=plan.sdkTrust.archives.sdk;
 const bytes=await archiveBytes(archive.path,fetchImpl);
 if(createHash('sha256').update(bytes).digest('hex')!==archive.sha256)throw Error('Staging install archive mismatch');
 const realRoot=await realpath(root);
 const lockPath=await regularFile(realRoot,'pnpm-lock.yaml');
 const lock=await readFile(lockPath,'utf8');
 if(createHash('sha256').update(lock).digest('hex')!==plan.sdkTrust.lockSha256)throw Error('Source lock changed');
 const productionPath=plan.sdkTrust.production.path;
 const targets=productionSdkTargets(lock,productionPath);
 const productionName=basename(productionPath);
 const stagingFile='file:'+STAGING_PATH;
 const alias='@mdbase-dev/sdk-staging@'+stagingFile;
 // pnpm's file alias must name the actual archive package, including UI peers.
 // Keep the application import name @mdbase-dev/sdk, not the production identity.
 // Other workspace packages may resolve the byte-identical registry SDK with the same
 // integrity, so change only the vendored entry's own resolution, never the SRI globally.
 const productionFile='file:'+productionPath;
 const resolution=(sri,file)=>`\n  '@mdbase-dev/sdk@${file}':\n    resolution: {integrity: ${sri}, tarball: ${file}}\n`;
 const vendored=resolution(plan.sdkTrust.production.sri,productionFile);
 if(lock.split(vendored).length!==2)throw Error('Vendored SDK lock entry not found exactly once');
 if(lock.includes('sdk-staging.tgz'))throw Error('Source lock already contains staging SDK');
 const byManifest=new Map();
 for(const target of targets) {
  const list=byManifest.get(target.manifest)??[];
  list.push(target);
  byManifest.set(target.manifest,list);
 }
 const rewrites=[];
 for(const [manifest,manifestTargets] of byManifest) {
  const manifestPath=await regularFile(realRoot,manifest);
  const pkg=JSON.parse(await readFile(manifestPath,'utf8'));
  for(const target of manifestTargets) {
   if(pkg[target.section]?.[target.name]!==target.expectedSpec)throw Error('Production install pin changed: '+manifest);
   pkg[target.section][target.name]=target.stagingSpec;
  }
  rewrites.push([manifestPath,JSON.stringify(pkg,null,2)+'\n']);
 }
 const vendorDir=join(realRoot,'apps/editor/vendor');
 if(!(await lstat(vendorDir)).isDirectory() || await realpath(vendorDir)!==vendorDir)throw Error('Unsafe staging archive directory');
 const stagingArchivePath=join(vendorDir,'sdk-staging.tgz');
 try {
  if(!(await lstat(stagingArchivePath)).isFile())throw Error('Unsafe staging archive target');
 }catch(error){if(error?.code!=='ENOENT')throw error;}
 const staged=lock.replace(vendored,()=>resolution(archive.sri,productionFile))
  .replaceAll(productionName,'sdk-staging.tgz')
  .replaceAll('@mdbase-dev/sdk@'+stagingFile,alias)
  .replaceAll('version: '+stagingFile,"version: '"+alias+"'")
  .replaceAll("'@mdbase-dev/sdk': "+stagingFile,"'@mdbase-dev/sdk': '"+alias+"'");
 await writeFile(stagingArchivePath,bytes);
 for(const [manifestPath,content] of rewrites)await writeFile(manifestPath,content);
 await writeFile(lockPath,staged);
}
if(process.argv[1]===fileURLToPath(import.meta.url))await prepareInstall(JSON.parse(await readFile(process.argv[2],'utf8')));
