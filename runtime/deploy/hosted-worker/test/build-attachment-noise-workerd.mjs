import {build} from "esbuild";
import {mkdirSync,writeFileSync,copyFileSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {createPrivateKey,createPublicKey} from "node:crypto";
import {decode} from "../../../packages/sdk/src/cbor.ts";
const out=process.env.HARNESS_DIR, fixtures=process.env.ATTACHMENT_FIXTURE;
if(!out||!fixtures)throw Error("explicit owned harness/fixture paths required");
mkdirSync(out,{mode:0o700});mkdirSync(join(out,"sqlite"),{mode:0o700});
const f=decode(new Uint8Array(readFileSync(join(fixtures,"fixture.cbor"))));const c=decode(f.get(0));
const hex=b=>Buffer.from(b).toString("hex");
const uuid=b=>hex(b).replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/,"$1-$2-$3-$4-$5");
const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(c.get(5))]),format:"der",type:"pkcs8"});
const signPk=hex(createPublicKey(privateKey).export({format:"der",type:"spki"}).subarray(-32));
const config={device:uuid(c.get(2)),replica:uuid(c.get(1)),sign_sk:hex(c.get(5)),kem_sk:hex(c.get(6)),noise_sk:"66".repeat(32),roots:c.get(3).map(hex),signers:c.get(4).map(uuid),collections:[uuid(c.get(0))]};
await build({entryPoints:[new URL("./attachment-noise-workerd.ts",import.meta.url).pathname],bundle:true,format:"esm",platform:"neutral",outfile:join(out,"worker.js"),external:["cloudflare:workers"],plugins:[{name:"wasm-module",setup(b){b.onResolve({filter:/hosted\.wasm$/},()=>({path:"hosted.wasm",external:true}));}}]});
copyFileSync(new URL("../hosted.wasm",import.meta.url),join(out,"hosted.wasm"));
await build({entryPoints:[new URL("./attachment-noise-client.mjs",import.meta.url).pathname],bundle:true,format:"esm",platform:"node",outfile:join(out,"client.mjs")});
writeFileSync(join(out,"config.capnp"),`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
 (name="main", worker=(compatibilityDate="2026-10-01", globalOutbound=(name="main",entrypoint="FixtureLog"), modules=[(name="worker.js",esModule=embed "worker.js"),(name="hosted.wasm",wasm=embed "hosted.wasm")], bindings=[(name="FIXTURES",service="fixtures"),(name="LOG",service=(name="main",entrypoint="FixtureLog")),(name="FIXTURE_SIGN_PK",text=${JSON.stringify(signPk)}),(name="LAB",text="1"),(name="LAB_LOG_TOKEN",text="synthetic-local-only"),(name="LAB_HOSTED_CONFIG",text=${JSON.stringify(JSON.stringify(config))}),(name="COLLECTIONS",durableObjectNamespace=(className="NoiseHosted"))],durableObjectNamespaces=[(className="NoiseHosted",uniqueKey="t9-local-noise-qualification",enableSql=true)],durableObjectStorage=(localDisk="store"))),
 (name="fixtures",disk=(path=${JSON.stringify(resolve(fixtures))},writable=false)),
 (name="store",disk=(path=${JSON.stringify(join(resolve(out),"sqlite"))},writable=true))
 ], sockets=[(name="http",address="127.0.0.1:19679",http=(),service="main")]);\n`,{mode:0o600});
writeFileSync(join(out,"client-plan.json"),JSON.stringify({collection:uuid(c.get(0)),device:uuid(c.get(2)),grant:uuid(f.get(4)),file:hex(f.get(3)),bytes:f.get(6),sha256:hex(f.get(2))}),{mode:0o600});
