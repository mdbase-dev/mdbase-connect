import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { it } from 'node:test';
import { archiveBytes, publicBytes, stagingArchive } from './authentication.mjs';
const repository='mdbase-dev/mdbase-connect';
const pin={version:'0.1.0-beta.1',sourceCommit:'a'.repeat(40),publication:{ref:'refs/heads/main'}};
const fixture=()=>{
 const bytes=Buffer.from('staging'),proof=Buffer.from('{}'),tag='sdk-v'+pin.version;
 const assets=[['sdk-staging.tgz',bytes],['sdk-staging.tgz.sigstore.json',proof]].map(([name,content],index)=>({
  id:100+index,name,digest:'sha256:'+createHash('sha256').update(content).digest('hex'),
  browser_download_url:`https://github.com/${repository}/releases/download/${tag}/${name}`
 }));
 return {bytes,proof,release:{tag_name:tag,prerelease:true,draft:false,assets},metadata:`https://api.github.com/repos/${repository}/releases/tags/${tag}`};
};
const series=(...steps)=>{
 const calls={count:0};
 return [calls,async()=>{
  const step=steps[Math.min(calls.count++,steps.length-1)];
  if(step instanceof Error)throw step;
  return new Response(step===200?'bytes':null,{status:step});
 }];
};
it('retries transient public reads and returns the bytes',async()=>{
 const [calls,fetchImpl]=series(503,new Error('socket hang up'),200);
 assert.equal((await publicBytes('https://x.test/a',fetchImpl,[0,0])).toString(),'bytes');
 assert.equal(calls.count,3);
});
it('gives up after its bounded retries and names the status',async()=>{
 const [calls,fetchImpl]=series(403);
 await assert.rejects(publicBytes('https://x.test/a',fetchImpl,[0,0]),/public artifact unavailable \(403\)/);
 assert.equal(calls.count,3);
});
it('does not retry a definite refusal',async()=>{
 const [calls,fetchImpl]=series(404,200);
 await assert.rejects(publicBytes('https://x.test/a',fetchImpl,[0,0]),/public artifact unavailable \(404\)/);
 assert.equal(calls.count,1);
});
it('uses the multi-minute default retry schedule and a 30-second timeout per attempt',async context=>{
 const delays=[],timeouts=[];
 context.mock.method(globalThis,'setTimeout',(callback,delay)=>{delays.push(delay);queueMicrotask(callback);});
 context.mock.method(AbortSignal,'timeout',timeout=>{timeouts.push(timeout);return new AbortController().signal;});
 const [calls,fetchImpl]=series(504,504,new Error('timeout'),503,200);
 assert.equal((await publicBytes('https://x.test/a',fetchImpl)).toString(),'bytes');
 assert.equal(calls.count,5);
 assert.deepEqual(delays,[5000,20000,60000,120000]);
 assert.deepEqual(timeouts,Array(5).fill(30000));
});
it('keeps the no-response refusal format after exhausted network retries',async()=>{
 const [calls,fetchImpl]=series(new Error('socket hang up'));
 await assert.rejects(publicBytes('https://x.test/a',fetchImpl,[0,0,0,0]),/^Error: SDK authentication refusal: public artifact unavailable \(no response\)$/);
 assert.equal(calls.count,5);
});
it('authenticates the SDK release API read without trusting mismatched metadata',async()=>{
 const seen=[];
 const fetchImpl=async(url,init)=>{seen.push([url,init.headers?.authorization]);return new Response(JSON.stringify({tag_name:'other'}),{status:200});};
 await assert.rejects(stagingArchive({version:'0.1.0-beta.1'},{fetchImpl,token:'t0'}),/exact SDK prerelease required/);
 assert.deepEqual(seen,[['https://api.github.com/repos/mdbase-dev/mdbase-connect/releases/tags/sdk-v0.1.0-beta.1','Bearer t0']]);
 seen.length=0;
 await assert.rejects(stagingArchive({version:'0.1.0-beta.1'},{fetchImpl,token:''}),/exact SDK prerelease required/);
 assert.equal(seen[0][1],undefined);
});
for(const token of ['t0',''])it(`downloads and verifies both staging assets ${token?'with authentication':'anonymously'}`,async()=>{
 const data=fixture(),seen=[],commands=[];
 const fetchImpl=async(url,init)=>{
  seen.push([url,init.headers]);
  if(url===data.metadata)return Response.json(data.release);
  const asset=data.release.assets.find(asset=>url===(token?`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`:asset.browser_download_url));
  assert.ok(asset,'only the exact asset endpoint may be requested');
  return new Response(asset.id===100?data.bytes:data.proof);
 };
 const result=await stagingArchive(pin,{fetchImpl,token,run:(...args)=>{commands.push(args);}});
 assert.deepEqual(result.bytes,data.bytes);
 assert.equal(result.path,data.release.assets[0].browser_download_url);
 assert.equal(result.authentication.sha256,data.release.assets[0].digest.slice(7));
 assert.deepEqual(seen,[[data.metadata,token?{authorization:'Bearer t0'}:{}],...data.release.assets.map(asset=>[
  token?`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`:asset.browser_download_url,
  token?{accept:'application/octet-stream',authorization:'Bearer t0'}:{}
 ])]);
 assert.equal(commands.length,1);
 const [command,args,options]=commands[0];
 assert.equal(command,'gh');
 assert.deepEqual(args,['attestation','verify',args[2],'--bundle',args[4],'--repo',repository,
  '--signer-workflow',`${repository}/.github/workflows/publish-sdk-npm.yml`,'--source-ref',pin.publication.ref,'--source-digest',pin.sourceCommit]);
 assert.deepEqual(options,{stdio:['ignore','pipe','pipe']});
 await assert.rejects(readFile(args[2]),{code:'ENOENT'});
});
for(const token of ['t0',''])for(const corruptId of [100,101])it(`refuses a digest mismatch for asset ${corruptId} ${token?'with authentication':'anonymously'}`,async()=>{
 const data=fixture();let verified=false;
 const fetchImpl=async url=>{
  if(url===data.metadata)return Response.json(data.release);
  const asset=data.release.assets.find(asset=>url===(token?`https://api.github.com/repos/${repository}/releases/assets/${asset.id}`:asset.browser_download_url));
  assert.ok(asset);
  return new Response(asset.id===corruptId?'wrong bytes':asset.id===100?data.bytes:data.proof);
 };
 await assert.rejects(stagingArchive(pin,{fetchImpl,token,run:()=>{verified=true;}}),/^Error: SDK authentication refusal: staging release archive\/bundle digest mismatch$/);
 assert.equal(verified,false);
});
for(const [name,change,message] of [
 ['wrong name',asset=>{asset.name='other.tgz';},'release asset digest required'],
 ['wrong URL',asset=>{asset.browser_download_url='https://other.test/archive';},'release asset URL mismatch'],
 ['wrong digest',asset=>{asset.digest='sha512:invalid';},'release asset digest required'],
 ['invalid ID',asset=>{asset.id='../other';},'release asset URL mismatch']
])it(`refuses ${name} before downloading an authenticated asset`,async()=>{
 const data=fixture();change(data.release.assets[0]);
 const seen=[];
 await assert.rejects(stagingArchive(pin,{token:'t0',fetchImpl:async url=>{seen.push(url);return Response.json(data.release);},run:()=>assert.fail('must not verify')}),
  error=>error.message==='SDK authentication refusal: '+message);
 assert.deepEqual(seen,[data.metadata]);
});
for(const token of ['t0',''])it(`re-downloads a staging archive ${token?'via its authenticated asset ID':'via its anonymous URL'}`,async()=>{
 const data=fixture(),seen=[];
 const fetchImpl=async(url,init)=>{
  seen.push([url,init.headers]);
  return url===data.metadata?Response.json(data.release):new Response(data.bytes);
 };
 assert.deepEqual(await archiveBytes(data.release.assets[0].browser_download_url,fetchImpl,token),data.bytes);
 assert.deepEqual(seen,token?[[data.metadata,{authorization:'Bearer t0'}],
  [`https://api.github.com/repos/${repository}/releases/assets/100`,{accept:'application/octet-stream',authorization:'Bearer t0'}]]:
  [[data.release.assets[0].browser_download_url,{}]]);
});
it('never sends a job token to registry or unrelated archive hosts',async()=>{
 for(const url of ['https://registry.npmjs.org/@mdbase-dev/ui/-/ui-1.0.0.tgz','https://other.test/archive']) {
  const seen=[];
  await archiveBytes(url,async(request,init)=>{seen.push([request,init.headers]);return new Response('bytes');},'t0');
  assert.deepEqual(seen,[[url,{}]]);
 }
});
it('does not silently fall back to anonymous downloads when authenticated access is refused',async()=>{
 const data=fixture(),seen=[];
 await assert.rejects(stagingArchive(pin,{token:'t0',fetchImpl:async url=>{
  seen.push(url);return url===data.metadata?Response.json(data.release):new Response(null,{status:401});
 },run:()=>assert.fail('must not verify')}),/^Error: SDK authentication refusal: public artifact unavailable \(401\)$/);
 assert.deepEqual(seen,[data.metadata,`https://api.github.com/repos/${repository}/releases/assets/100`]);
});
