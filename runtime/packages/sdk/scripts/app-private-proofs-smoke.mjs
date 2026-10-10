#!/usr/bin/env node
/** Public conformance fixture: actual SDK/native WASM/WebCrypto + actual CP
 * digest functions. Memory IO/registration receipt fixture, NOT live CP,
 * private bootstrap, policy/keyed/provider/platform durability qualification. */
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createPublicKey, verify } from "node:crypto";
import { build } from "esbuild";
const [artifact,connect]=process.argv.slice(2);if(!artifact||!connect)throw Error("usage: app-private-proofs-smoke.mjs app-runtime.wasm owned-connect-worktree");
const dir=resolve("target/private-proofs-smoke");await mkdir(dir,{recursive:true});
const output=resolve(dir,"fixture.mjs");
await build({stdin:{contents:`export {AppWasmRuntime,AppWebNoiseCustody} from ${JSON.stringify(resolve("packages/sdk/src/app-host/index.ts"))}; export {privateCreateDigest,privateDeviceEnrolDigest,privateApprovalRequestDigest} from ${JSON.stringify(resolve(connect,"services/server/src/features/next/private-collections.ts"))};`,resolveDir:process.cwd(),loader:"ts"},outfile:output,bundle:true,platform:"node",format:"esm",target:"node24",logLevel:"silent"});
const {AppWasmRuntime,AppWebNoiseCustody,privateCreateDigest,privateDeviceEnrolDigest,privateApprovalRequestDigest}=await import(pathToFileURL(output));
const bytes=await readFile(artifact),signal=new AbortController().signal;
const pin={connectorId:"66666666-6666-6666-6666-666666666666",deviceId:"44444444-4444-4444-4444-444444444444",installationId:"88888888-8888-8888-8888-888888888888",isCurrent:()=>true},collection="22222222-2222-2222-2222-222222222222";
const challenge=Buffer.alloc(32,17),input={connector:pin.connectorId,device:pin.deviceId,collection};
const publicKey=p=>createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),Buffer.from(p)]),format:"der",type:"spki"});
async function owner(opened={mode:"fresh"}) {
 const runtime=await AppWasmRuntime.createDevice(bytes),signSecretKey=Buffer.alloc(32,1),kemSecretKey=Buffer.alloc(32,2);
 const custody=runtime.openDeviceConsuming({pin,signSecretKey,kemSecretKey,opened});assert(signSecretKey.every(v=>v===0));assert(kemSecretKey.every(v=>v===0));
 if(opened.mode==="fresh")runtime.signCpEnrol(Buffer.alloc(32,7));
 // Explicit public fixture host receipt, not actual authenticated registration.
 runtime.acknowledgeDeviceRegistration({...pin,...custody});return {runtime,custody};
}
const create=await owner();create.runtime.preparePrivateCollection({...pin,collection,purpose:"create",approvalMode:"password-ak1"},{mode:"fresh"});
const signature=create.runtime.signPrivateCreate(challenge);assert(verify(null,privateCreateDigest({...input,challenge}),publicKey(create.custody.signPublicKey),signature));assert(challenge.every(v=>v===17));
assert(!verify(null,privateDeviceEnrolDigest({...input,challenge,sasCommit:Buffer.alloc(32,11)}),publicKey(create.custody.signPublicKey),signature));create.runtime.retireLog();await create.runtime.close();
const first=await owner(),kek=await crypto.subtle.generateKey({name:"AES-GCM",length:256},false,["encrypt","decrypt"]),data=new Map();
const store={read:async id=>data.get(id)??null,compareAndSet:async(id,expected,value)=>{const actual=data.get(id)??null;if(actual===null?expected!==null:expected===null||!Buffer.from(actual).equals(Buffer.from(expected)))return false;data.set(id,new Uint8Array(value));return true;}};
const vault=new AppWebNoiseCustody(pin,kek,store);await vault.pending(first.custody.envelope,{signal});await vault.registered({...pin,...first.custody},{signal});
first.runtime.preparePrivateCollection({...pin,collection,purpose:"enrol",approvalMode:"password-ak1"},{mode:"fresh"});const marker=first.runtime.privateEnrolMarker();await vault.privateEnrolPending(marker,{signal});
const proof=first.runtime.signPrivateDeviceEnrol(challenge);assert(verify(null,privateDeviceEnrolDigest({...input,challenge,sasCommit:marker.sasCommitment}),publicKey(first.custody.signPublicKey),proof.signature));assert(!verify(null,privateApprovalRequestDigest({...input,challenge,sasCommit:marker.sasCommitment}),publicKey(first.custody.signPublicKey),proof.signature));
first.runtime.retireLog();await first.runtime.close();
const restored=await new AppWebNoiseCustody(pin,kek,store).restore({signal});assert(restored?.receipt&&restored.privateEnrolMarker);assert.deepEqual(restored.privateEnrolMarker.sasCommitment,marker.sasCommitment);
const reopened=await owner({mode:"existing",envelope:restored.envelope});assert.deepEqual(reopened.custody.noisePublicKey,first.custody.noisePublicKey);
reopened.runtime.preparePrivateCollection({...pin,collection,purpose:"enrol",approvalMode:"password-ak1"},{mode:"existing",marker:restored.privateEnrolMarker});
const nonce=Buffer.alloc(32,18),retry=reopened.runtime.signPrivateDeviceEnrol(nonce);assert(nonce.every(v=>v===18));assert.deepEqual(retry.sasCommitment,marker.sasCommitment);assert(verify(null,privateDeviceEnrolDigest({...input,challenge:nonce,sasCommit:marker.sasCommitment}),publicKey(reopened.custody.signPublicKey),retry.signature));
reopened.runtime.retireLog();await reopened.runtime.close();
await vault.privateEnrolAcknowledged(marker,{signal});const acknowledged=await vault.restore({signal});assert.equal(acknowledged.privateEnrolMarker.acknowledged,true);
const known=await owner({mode:"existing",envelope:acknowledged.envelope});known.runtime.preparePrivateCollection({...pin,collection,purpose:"enrol",approvalMode:"password-ak1"},{mode:"existing",marker:acknowledged.privateEnrolMarker});assert.throws(()=>known.runtime.signPrivateDeviceEnrol(Buffer.alloc(32,19)));await known.runtime.close();
console.log(JSON.stringify({actualSdk:true,actualAppWasm:true,actualWebCrypto:true,actualCpDigestFunctions:true,fixedPrivateCreate:true,nativeFreshCommit:true,publicMarkerProtected:true,sameCommitReopen:true,sameNoiseIdentity:true,freshNonceProof:true,purposeSeparated:true,acknowledgedNoProof:true,registrationQualified:false,cpReceiverQualified:false,privateBootstrapQualified:false,platformPersistenceQualified:false,providerActivationQualified:false}));
