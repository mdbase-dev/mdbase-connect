// Fresh npm consumers of the normal SDK pack. Neither an installed SDK nor
// cached pacote metadata may hide a relative transitive file dependency bug.
// Requires the normal canonical SDK build first. Local heavy check, not npm test.
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

const sdk=fileURLToPath(new URL("..",import.meta.url));
const root=mkdtempSync(join(sdk,".npm-consumer-"));
const run=(args,cwd)=>execFileSync(process.execPath,[...args],{cwd,stdio:"inherit"});
const npm=(args,cwd)=>execFileSync("npm",args,{cwd,stdio:"inherit"});
try {
  const [{filename}]=JSON.parse(execFileSync("npm",["pack","--json","--ignore-scripts","--pack-destination",root],{cwd:sdk,encoding:"utf8"}));
  const archive=join(root,filename),unpacked=join(root,"unpacked");mkdirSync(unpacked);
  execFileSync("tar",["-xzf",archive,"-C",unpacked]);
  const packed=join(unpacked,"package");
  const manifest=JSON.parse(readFileSync(join(packed,"package.json"),"utf8"));
  assert(manifest.bundleDependencies?.includes("@mdbase-dev/connect-protocol"),"protocol is bundled by normal npm pack");
  const protocolArchive=join(packed,manifest.dependencies["@mdbase-dev/connect-protocol"].replace(/^file:/,""));
  const original=join(root,"original-protocol");mkdirSync(original);execFileSync("tar",["-xzf",protocolArchive,"-C",original,"--strip-components=1"]);
  function equalFiles(a,b) {
    for(const name of readdirSync(a,{withFileTypes:true})) {
      if(name.isDirectory())equalFiles(join(a,name.name),join(b,name.name));
      else assert(readFileSync(join(a,name.name)).equals(readFileSync(join(b,name.name))),`original protocol member ${name.name}`);
    }
  }
  equalFiles(join(original,"dist"),join(packed,"node_modules/@mdbase-dev/connect-protocol/dist"));
  for(const directProtocol of [false,true]) {
    const consumer=join(root,directProtocol?"root-protocol":"sdk-only");mkdirSync(consumer);
    const dependencies={"@mdbase-dev/sdk":"file:"+archive};
    if(directProtocol) {mkdirSync(join(consumer,"vendor"));const name=protocolArchive.split("/").at(-1);copyFileSync(protocolArchive,join(consumer,"vendor",name));dependencies["@mdbase-dev/connect-protocol"]="file:vendor/"+name;}
    writeFileSync(join(consumer,"package.json"),JSON.stringify({name:"npm-sdk-consumer",private:true,type:"module",dependencies}));
    npm(["install","--package-lock-only","--ignore-scripts","--no-audit","--no-fund","--cache",join(consumer,"lock-cache")],consumer);
    assert(!existsSync(join(consumer,"node_modules")),"lock generation must not preinstall SDK metadata");
    const cache=join(consumer,"empty-ci-cache");assert(!existsSync(cache),"ci cache starts empty");
    npm(["ci","--ignore-scripts","--no-audit","--no-fund","--cache",cache],consumer);
    writeFileSync(join(consumer,"intake.ts"),'import {MdbaseConnect} from "@mdbase-dev/sdk";\nimport {createApplicationFixture} from "@mdbase-dev/sdk/testing";\nexport const entry: typeof MdbaseConnect = MdbaseConnect;\nexport const fixture: typeof createApplicationFixture = createApplicationFixture;\n');
    writeFileSync(join(consumer,"tsconfig.json"),JSON.stringify({compilerOptions:{target:"ES2022",module:"NodeNext",moduleResolution:"NodeNext",strict:true,exactOptionalPropertyTypes:true,noUncheckedIndexedAccess:true,skipLibCheck:false,noEmit:true},include:["intake.ts"]}));
    run([join(sdk,"node_modules/typescript/bin/tsc"),"-p","tsconfig.json"],consumer);
    run(["--input-type=module","-e",'import {MdbaseConnect} from "@mdbase-dev/sdk";import {createApplicationFixture} from "@mdbase-dev/sdk/testing";if(typeof MdbaseConnect!=="function"||typeof createApplicationFixture!=="function")throw Error("public imports");'],consumer);
  }
  console.log("npm consumer ok: empty install roots and empty ci caches; original protocol bundle; strict public declarations/imports");
} finally {rmSync(root,{recursive:true,force:true});}
