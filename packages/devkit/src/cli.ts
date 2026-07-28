#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  formatValidationIssues,
  validateAppManifest,
  validateDataContract
} from "./index.js";

const arguments_ = process.argv.slice(2);
const allowLocal = arguments_.includes("--allow-local");
const [command, source] = arguments_.filter((argument) => argument !== "--allow-local");
if (!source || !["validate-manifest", "validate-contract"].includes(command ?? "")) {
  console.error("Usage: mdbase-connect-dev <validate-manifest|validate-contract> <file.json> [--allow-local]");
  process.exitCode = 2;
} else {
  try {
    const value = JSON.parse(await readFile(resolve(source), "utf8"));
    const result = command === "validate-manifest"
      ? validateAppManifest(value, { allowLocal })
      : validateDataContract(value);
    if (result.valid) {
      console.log(`${source} is valid`);
    } else {
      console.error(formatValidationIssues(result.issues));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
