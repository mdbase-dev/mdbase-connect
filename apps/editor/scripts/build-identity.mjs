// Per-build identity for every HTML document the Editor ships.
//
// Cloudflare caches HTML responses (`public, max-age=0, must-revalidate`) and
// revalidates them against Pages. When a document's bytes are unchanged between
// builds, revalidation succeeds and the edge keeps serving the cached response
// with the previous build's headers, so a `_headers` change (for example the
// CSP) never reaches that document at that edge. Stamping the build identity
// into every document changes its bytes on every source commit, so revalidation
// always fetches the new response and its headers.
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const NAME='mdbase-build';
/** The identity is the 12-character source commit already used in entry asset names. */
export function buildIdentity(id) {
 const value=String(id??'local').slice(0,12).replace(/[^a-zA-Z0-9_-]/gu,'-');
 if(!value)throw Error('Empty Editor build identity');
 return value;
}
export const buildIdentityTag=id=>`<meta name="${NAME}" content="${buildIdentity(id)}">`;
const anyTag=new RegExp(`<meta name="${NAME}"`,'u');

async function htmlFiles(directory,path='') {
 const files=[];
 for(const entry of await readdir(join(directory,path),{withFileTypes:true})) {
  const relative=path?`${path}/${entry.name}`:entry.name;
  if(entry.isDirectory())files.push(...await htmlFiles(directory,relative));
  else if(entry.isFile() && relative.endsWith('.html'))files.push(relative);
 }
 return files.sort();
}
/** Insert the identity into every built HTML document. Source never carries one. */
export async function stampBuildIdentity(directory,id) {
 const tag=buildIdentityTag(id),stamped=[];
 for(const path of await htmlFiles(resolve(directory))) {
  const file=join(directory,path),html=await readFile(file,'utf8');
  if(anyTag.test(html))throw Error(`Editor HTML already carries a build identity: ${path}`);
  if(!html.includes('</head>'))throw Error(`Editor HTML needs a head element: ${path}`);
  await writeFile(file,html.replace('</head>',`${tag}\n</head>`));
  stamped.push(path);
 }
 if(!stamped.includes('index.html'))throw Error('Editor build identity found no index.html');
 return stamped;
}
/** Every HTML document in the publication inventory must carry exactly this build's identity. */
export async function assertBuildIdentity(directory,inventory,id) {
 const tag=buildIdentityTag(id);
 for(const {path} of inventory.filter(a=>a.path.endsWith('.html'))) {
  const html=await readFile(join(directory,path),'utf8');
  if(html.split(tag).length!==2 || html.match(new RegExp(anyTag.source,'gu')).length!==1)
   throw Error(`Editor HTML lacks this build's identity: ${path}`);
 }
}
/** Vite plugin. `writeBundle` runs after the public directory is copied and
 * finishes before any `closeBundle` hook, such as the offline shell's precache
 * manifest, which therefore hashes the stamped documents. */
export function buildIdentityPlugin(id) {
 let directory;
 return {
  name:'mdbase-editor-build-identity',
  apply:'build',
  configResolved(config) {directory=resolve(config.root,config.build.outDir);},
  async writeBundle() {await stampBuildIdentity(directory,id);},
 };
}
