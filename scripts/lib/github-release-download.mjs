// Shared bounded artifact reads; preserve the Editor intake's refusal contract.
const need=(ok,message)=>{if(!ok)throw Error('SDK authentication refusal: '+message);};
const retryable=status=>status===403||status===408||status===429||status>=500;
// Authentication judges the bytes, so repeating a public read cannot weaken it.
export async function publicBytes(url,fetchImpl=fetch,delays=[5000,20000,60000,120000],headers={}) {
 for(const delay of [...delays,null]) {
  let status='no response';
  try {
   const response=await fetchImpl(url,{headers,redirect:'follow',signal:AbortSignal.timeout(30000)});
   if(response.ok)return Buffer.from(await response.arrayBuffer());
   status=response.status;
   need(retryable(status),`public artifact unavailable (${status})`);
  } catch(error) {
   if(String(error.message).startsWith('SDK authentication refusal'))throw error;
  }
  need(delay!==null,`public artifact unavailable (${status})`);
  await new Promise(resolve=>setTimeout(resolve,delay));
 }
}
