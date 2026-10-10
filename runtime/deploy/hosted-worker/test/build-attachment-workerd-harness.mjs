import {build} from "esbuild";import {mkdirSync,writeFileSync,copyFileSync} from "node:fs";import {join} from "node:path";
if(!process.env.HARNESS_DIR||!process.env.ATTACHMENT_FIXTURE)throw Error("explicit owned harness/fixture paths required");
const out=process.env.HARNESS_DIR;mkdirSync(out,{mode:0o700});mkdirSync(join(out,"sqlite"),{mode:0o700});
await build({entryPoints:[new URL("./attachment-workerd-harness.ts",import.meta.url).pathname],bundle:true,format:"esm",platform:"neutral",outfile:join(out,"worker.js"),plugins:[{name:"wasm-module",setup(b){b.onResolve({filter:/hosted\.wasm$/},()=>({path:"hosted.wasm",external:true}));}}]});
copyFileSync(new URL("../hosted.wasm",import.meta.url),join(out,"hosted.wasm"));
writeFileSync(join(out,"config.capnp"),`using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
 (name="main", worker=(compatibilityDate="2026-10-01", modules=[(name="worker.js",esModule=embed "worker.js"),(name="hosted.wasm",wasm=embed "hosted.wasm")],bindings=[(name="FIXTURES",service="fixtures"),(name="COLLECTIONS",durableObjectNamespace=(className="AttachmentFixture"))],durableObjectNamespaces=[(className="AttachmentFixture",uniqueKey="t9-hermetic-fixture",enableSql=true)],durableObjectStorage=(localDisk="store"))),
 (name="fixtures",disk=(path=${JSON.stringify(process.env.ATTACHMENT_FIXTURE)},writable=false)),
 (name="store",disk=(path=${JSON.stringify(join(out,"sqlite"))},writable=true))
 ], sockets=[(name="http",address="127.0.0.1:19669",http=(),service="main")]);\n`,{mode:0o600});
