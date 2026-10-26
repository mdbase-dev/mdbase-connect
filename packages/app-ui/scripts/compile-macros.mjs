import { transformAsync } from "@babel/core";
import { readdir, readFile, writeFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

// Run after declaration/type emission. Keep source messages for
// synchronous English in consumers that have not adopted a catalogue yet.
async function compile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) { await compile(path); continue; }
    if (!/\.jsx?$/.test(path)) continue;
    const result = await transformAsync(await readFile(path, "utf8"), {
      filename: path, configFile: false, babelrc: false,
      plugins: [
        ["@lingui/babel-plugin-lingui-macro", { descriptorFields: "message" }],
      ],
    });
    const output = path.replace(/\.jsx$/, ".js");
    await writeFile(output, result.code + "\n");
    if (output !== path) await unlink(path);
  }
}
await compile(resolve(process.argv[2] ?? "dist"));
