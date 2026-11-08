import assert from 'node:assert/strict';
import { it } from 'node:test';
import { publicBytes, stagingArchive } from './authentication.mjs';
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
it('authenticates only the SDK release API read with the job token',async()=>{
 const seen=[];
 const fetchImpl=async(url,init)=>{seen.push([url,init.headers?.authorization]);return new Response(JSON.stringify({tag_name:'other'}),{status:200});};
 await assert.rejects(stagingArchive({version:'0.1.0-beta.1'},{fetchImpl,token:'t0'}),/exact SDK prerelease required/);
 assert.deepEqual(seen,[['https://api.github.com/repos/mdbase-dev/mdbase-connect/releases/tags/sdk-v0.1.0-beta.1','Bearer t0']]);
 seen.length=0;
 await assert.rejects(stagingArchive({version:'0.1.0-beta.1'},{fetchImpl,token:''}),/exact SDK prerelease required/);
 assert.equal(seen[0][1],undefined);
});
