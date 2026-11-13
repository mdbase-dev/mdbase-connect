import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filesystemBackupStore, readNativeBackupStage, readPrivateBackupFile } from "./native-backup-filesystem.js";
import { verifyNativeArchive } from "./native-backup-verifier.js";

async function stage(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(process.cwd(),".native-backup-test-"));
  try {await run(root);} finally {await rm(root,{recursive:true,force:true});}
}
describe("private filesystem backup sink", () => {
  it("creates exact durable bytes exclusively and bounds reads", () => stage(async root => {
    const sink = await filesystemBackupStore(root), bytes = Buffer.of(1,2,3);
    await sink.putIfAbsent("cut/pages/0000000001.cbor",bytes);
    expect(await sink.read("cut/pages/0000000001.cbor",3)).toEqual(bytes);
    await expect(sink.read("cut/pages/0000000001.cbor",2)).rejects.toThrow("private_file");
    await expect(sink.putIfAbsent("cut/pages/0000000001.cbor",Buffer.of(4))).rejects.toThrow();
    for (const path of ["../trust.cbor","/etc/passwd","cut/pages/1.cbor","trust.cbor"]) await expect(sink.putIfAbsent(path,bytes)).rejects.toThrow("key");
    expect(await readFile(join(root,"cut/pages/0000000001.cbor"))).toEqual(bytes);
  }));
  it("refuses non-private directories, symlink parents/files and hardlinks", () => stage(async root => {
    await chmod(root,0o755); await expect(filesystemBackupStore(root)).rejects.toThrow("private_directory"); await chmod(root,0o700);
    const other = join(root,"other"); await mkdir(other,{mode:0o700});
    await symlink(other,join(root,"cut")); const sink = await filesystemBackupStore(root);
    await expect(sink.putIfAbsent("cut/header.cbor",Buffer.of(1))).rejects.toThrow("private_directory");
    await writeFile(join(root,"original"),Buffer.of(1),{mode:0o600});
    await symlink(join(root,"original"),join(root,"completion.cbor")); await expect(sink.read("completion.cbor",1)).rejects.toThrow();
    await link(join(root,"original"),join(root,"capture-context.cbor")); await expect(sink.read("capture-context.cbor",1)).rejects.toThrow("private_file");
  }));
  it("reads exact existing capture layout and refuses incomplete/unexpected stages", () => stage(async root => {
    const sink = await filesystemBackupStore(root);
    for (const name of ["completion.cbor","capture-context.cbor","cut/header.cbor","cut/finish.cbor","cut/pages/0000000001.cbor"]) await sink.putIfAbsent(name,Buffer.of(1));
    await mkdir(join(root,"cut/objects"),{mode:0o700});
    expect((await readNativeBackupStage(root)).size).toBe(5);
    await writeFile(join(root,".completion.pending"),Buffer.of(1),{mode:0o600});
    await expect(readNativeBackupStage(root)).rejects.toThrow("extra");
  }));
});
describe("native verifier process composition (synthetic test executable, NOT crypto qualification)", () => {
  it("passes frozen independent trust and exact cut layout; always cleans staging", () => stage(async root => {
    const executable = join(root,"synthetic-verifier.cjs"), stageRoot = join(root,"stages"); await mkdir(stageRoot,{mode:0o700});
    await writeFile(executable,`#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const a = process.argv.slice(2);
if (a.length !== 6 || a[0] !== '--cut-dir' || a[2] !== '--completion' || a[4] !== '--trust') process.exit(2);
if (fs.readFileSync(a[5])[0] !== 42 || fs.readFileSync(path.join(a[1],'header.cbor'))[0] !== 1 || fs.readFileSync(a[3])[0] !== 2) process.exit(1);
process.stdout.write('{"verified":true,"current_authority_verified":false}\\n');
`,{mode:0o700});
    const files = new Map([["cut/header.cbor",Buffer.of(1)],["completion.cbor",Buffer.of(2)]]);
    await verifyNativeArchive(files,{executable,stageRoot,trust:Buffer.of(42)});
    expect(await readdir(stageRoot)).toEqual([]);
    await expect(verifyNativeArchive(files,{executable,stageRoot,trust:Buffer.of(43)})).rejects.toThrow("verification_failed");
    expect(await readdir(stageRoot)).toEqual([]);
    await expect(readPrivateBackupFile(join(root,"missing"),1)).rejects.toThrow();
  }));
  it("rejects authority claims, stderr and wrong executable success shape", () => stage(async root => {
    const executable = join(root,"synthetic-verifier");
    for (const script of ["echo '{\"verified\":true,\"current_authority_verified\":true}'", "echo warning >&2; echo '{\"verified\":true,\"current_authority_verified\":false}'", "echo '{}'", "exit 1"]) {
      await writeFile(executable,`#!/bin/sh\n${script}\n`,{mode:0o700});
      await expect(verifyNativeArchive(new Map(),{executable,stageRoot:root,trust:Buffer.of(1)})).rejects.toThrow("verification_failed");
      expect((await readdir(root)).filter(name => name.startsWith("native-backup-"))).toEqual([]);
    }
    await expect(verifyNativeArchive(new Map([["../trust.cbor",Buffer.of(1)]]),{executable,stageRoot:root,trust:Buffer.of(1)})).rejects.toThrow("configuration");
  }));
});
