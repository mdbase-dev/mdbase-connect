// Packs the built SDK and builds a minimal, default-configured Vite consumer of
// the public `MdbaseConnect` entry. Asserts that the consumer emits the SDK
// Worker plus the pinned native assets byte-exactly, with no unresolved or
// unused promiser Worker reference. Requires `npm run build` with the packaged
// application inputs first. Local check (heavy.sh), not part of `npm test`.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdirSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {build} from "vite";

const sdk=fileURLToPath(new URL("..",import.meta.url));
const pins=JSON.parse(readFileSync(join(sdk,"src/application/asset-pins.json"),"utf8"));
const officialSqlite=readFileSync(join(sdk,"dist/native/sqlite3.js"));
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
// Inside the SDK package so the packed SDK resolves its installed dependencies.
const root=join(sdk,".vite-consumer");
rmSync(root,{recursive:true,force:true});
try {
  const installed=join(root,"node_modules/@mdbase-dev/sdk");
  mkdirSync(installed,{recursive:true});
  const [{filename}]=JSON.parse(execFileSync("npm",["pack","--json","--ignore-scripts","--pack-destination",root],{cwd:sdk,encoding:"utf8"}));
  execFileSync("tar",["-xzf",join(root,filename),"-C",installed,"--strip-components=1"]);
  writeFileSync(join(root,"package.json"),JSON.stringify({name:"vite-consumer",private:true,type:"module"}));
  writeFileSync(join(root,"index.html"),`<!doctype html><script type="module" src="./main.js"></script>`);
  writeFileSync(join(root,"main.js"),`import {MdbaseConnect} from "@mdbase-dev/sdk";\nglobalThis.connect=MdbaseConnect;\n`);
  await build({root,configFile:false,logLevel:"warn",build:{outDir:"out",emptyOutDir:true}});
  const assets=join(root,"out/assets"),names=readdirSync(assets),read=name=>readFileSync(join(assets,name));
  const one=(pattern,label)=>{const found=names.filter(name=>pattern.test(name));assert.equal(found.length,1,`${label}: ${names.join(", ")}`);return found[0];};
  const runtime=one(/^runtime-lab-.*\.wasm$/,"runtime wasm"),sqlite=one(/^sqlite3-.*\.wasm$/,"sqlite wasm"),initializer=one(/^sqlite3-.*\.js$/,"sqlite initializer");
  const worker=one(/^worker-.*\.js$/,"SDK Worker");
  assert.equal(sha256(read(runtime)),pins.runtime.sha256);assert.equal(read(runtime).length,pins.runtime.bytes);
  assert.equal(sha256(read(sqlite)),pins.sqlite.sha256);assert.equal(read(sqlite).length,pins.sqlite.bytes);
  assert(read(initializer).equals(officialSqlite),"the official pinned initializer is emitted unprocessed");
  const workerText=read(worker).toString("utf8");
  for(const name of [runtime,sqlite,initializer])assert(workerText.includes(name),`SDK Worker references ${name}`);
  const entry=names.filter(name=>/^index-.*\.js$/.test(name)).map(name=>read(name).toString("utf8")).join("\n");
  assert(entry.includes(worker),"UI entry constructs the emitted SDK Worker");
  for(const name of names.filter(name=>name.endsWith(".js")&&name!==initializer))assert(!read(name).includes("sqlite3-worker1"),`${name} has no promiser Worker`);
  console.log(`vite consumer ok: ${[worker,runtime,sqlite,initializer].join(" ")}`);
} finally {
  rmSync(root,{recursive:true,force:true});
}
