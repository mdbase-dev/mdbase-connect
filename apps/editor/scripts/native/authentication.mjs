// Authenticate data before installing or executing any application dependencies.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provenSource } from '../../../../scripts/continuous-sdk-release.mjs';
const repository='mdbase-dev/mdbase-connect';
const workflow='publish-sdk-npm.yml';
const need=(ok,message)=>{if(!ok)throw Error('SDK authentication refusal: '+message);};
import { publicBytes } from '../../../../scripts/lib/github-release-download.mjs';
export { publicBytes };
function releaseAsset(release,tag,name) {
 const matches=release.assets?.filter(asset=>asset.name===name)??[];
 need(matches.length===1 && /^sha256:[a-f0-9]{64}$/.test(matches[0].digest??''),'release asset digest required');
 need(matches[0].browser_download_url===`https://github.com/${repository}/releases/download/${tag}/${name}`,'release asset URL mismatch');
 return matches[0];
}
async function assetBytes(asset,fetchImpl,token) {
 if(!token)return publicBytes(asset.browser_download_url,fetchImpl);
 need(Number.isSafeInteger(asset.id) && asset.id>0,'release asset URL mismatch');
 return publicBytes(`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`,fetchImpl,undefined,
  {accept:'application/octet-stream',authorization:`Bearer ${token}`});
}
export async function archiveBytes(url,fetchImpl=fetch,token=process.env.GITHUB_TOKEN) {
 const prefix=`https://github.com/${repository}/releases/download/`;
 if(!token || !url.startsWith(prefix))return publicBytes(url,fetchImpl);
 const match=/^(sdk-v[\w.-]+)\/(sdk-staging\.tgz(?:\.sigstore\.json)?)$/.exec(url.slice(prefix.length));
 need(match,'release asset URL mismatch');
 const [,tag,name]=match;
 const release=JSON.parse(await publicBytes(`https://api.github.com/repos/${repository}/releases/tags/${tag}`,fetchImpl,undefined,
  {authorization:`Bearer ${token}`}));
 need(release.tag_name===tag && release.prerelease===true && release.draft===false,'exact SDK prerelease required');
 return assetBytes(releaseAsset(release,tag,name),fetchImpl,token);
}
export async function authenticateProduction(pin,bytes,{fetchImpl=fetch,prove=provenSource}={}) {
 const url=`https://registry.npmjs.org/@mdbase-dev/sdk/${pin.version}`;
 const entry=JSON.parse(await publicBytes(url,fetchImpl));
 const sri='sha512-'+createHash('sha512').update(bytes).digest('base64');
 need(entry.name==='@mdbase-dev/sdk' && entry.version===pin.version && entry.dist?.integrity===sri && pin.sri===sri,'exact npm version/archive integrity mismatch');
 const source=await prove('@mdbase-dev/sdk',{version:pin.version,entry,workflow});
 need(source.commit===pin.sourceCommit && source.identity===`https://github.com/${repository}/.github/workflows/${workflow}@${pin.publication.ref}`,'npm provenance source mismatch');
 return {kind:'npm-provenance',version:pin.version,source:source.commit};
}
export async function stagingArchive(pin,{fetchImpl=fetch,run=execFileSync,token=process.env.GITHUB_TOKEN}={}) {
 const tag=`sdk-v${pin.version}`;
 // The job token only lifts anonymous API/download limits; release metadata,
 // digests and attestations are still judged below, so it grants no trust.
 const api=token?{authorization:`Bearer ${token}`}:{};
 const release=JSON.parse(await publicBytes(`https://api.github.com/repos/${repository}/releases/tags/${tag}`,fetchImpl,undefined,api));
 need(release.tag_name===tag && release.prerelease===true && release.draft===false,'exact SDK prerelease required');
 const archive=releaseAsset(release,tag,'sdk-staging.tgz'),bundle=releaseAsset(release,tag,'sdk-staging.tgz.sigstore.json');
 const download=async a=>{
  const bytes=await assetBytes(a,fetchImpl,token);
  need('sha256:'+createHash('sha256').update(bytes).digest('hex')===a.digest,'staging release archive/bundle digest mismatch');
  return bytes;
 };
 const bytes=await download(archive),proof=await download(bundle);
 const directory=await mkdtemp(join(tmpdir(),'editor-sdk-auth-'));
 try {
  const path=join(directory,'sdk-staging.tgz'),bundlePath=path+'.sigstore.json';
  await writeFile(path,bytes);await writeFile(bundlePath,proof);
  run('gh',['attestation','verify',path,'--bundle',bundlePath,'--repo',repository,
   '--signer-workflow',`${repository}/.github/workflows/${workflow}`,
   '--source-ref',pin.publication.ref,'--source-digest',pin.sourceCommit],{stdio:['ignore','pipe','pipe']});
 } catch(error) {
  const reason=error.code==='ENOENT'?'gh executable unavailable':'verification failed';
  throw Error('SDK authentication refusal: staging attestation '+reason);
 }
 finally {await rm(directory,{recursive:true,force:true});}
 return {bytes,path:archive.browser_download_url,authentication:{kind:'github-attestation',version:pin.version,source:pin.sourceCommit,sha256:archive.digest.slice(7)}};
}
