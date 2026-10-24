// Throwaway keys generated in memory; inherited fd, never a private key file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'../..');
const cli=path.join(root,'services/server/src/features/next/cp-cert-cli.ts');
const loader=path.join(root,'services/server/node_modules/tsx/dist/loader.mjs');
function command(args,pem) {
 return new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--import',loader,cli,...args],{stdio:['ignore','pipe','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  child.stdio[3].on('error',()=>{});child.stdio[3].end(pem??'');
  child.on('error',reject);child.on('close',code=>code===0?resolve(stdout.trim()):reject(new Error(stderr)));
 });
}
test('structured certificate and revocation signing accept an inherited root pipe',async()=>{
 const {privateKey,publicKey}=generateKeyPairSync('ed25519');
 const pem=privateKey.export({format:'pem',type:'pkcs8'}).toString();
 const rootPk=publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 const policy=generateKeyPairSync('ed25519').publicKey.export({format:'der',type:'spki'}).subarray(-32).toString('hex');
 const from='1792233300000',until='1823769300000';
 const signed=await command(['sign-cert','/dev/fd/3',policy,from,until],pem);
 assert.equal(signed.includes(pem),false);assert.ok(signed.startsWith('CERTIFY a control-plane policy key'));
 const signature=/^signature ([0-9a-f]{128})$/m.exec(signed)[1];
 const cert=JSON.parse(await command(['cert',policy,from,until,rootPk,signature]));
 assert.equal(cert.policy_public_key,policy);assert.equal(cert.not_before,Number(from));
 const id='b'.repeat(32),revocation=await command(['sign-revocation','/dev/fd/3',id,from],pem);
 assert.ok(revocation.startsWith('REVOKE a control-plane policy key'));assert.equal(revocation.includes(pem),false);
 const digestText=await command(['revocation-digest',id,from]);
 const digest=Buffer.from(/^digest ([0-9a-f]{64})$/m.exec(digestText)[1],'hex');
 const revSig=Buffer.from(/^signature ([0-9a-f]{128})$/m.exec(revocation)[1],'hex');
 assert.equal(verify(null,digest,publicKey,revSig),true);assert.deepEqual(revSig,sign(null,digest,privateKey));
});
