#!/usr/bin/env node

import { resolve } from "node:path";

import {
  generateHostedFixture,
  HOSTED_FIXTURE_TIERS
} from "./lib/hosted-execution-fixture.mjs";

const options = parseArguments(process.argv.slice(2));
const manifest = await generateHostedFixture(options);
process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);

function parseArguments(arguments_) {
  const options = {
    records: undefined,
    output: undefined,
    format: "ndjson",
    seed: "hosted-execution-v1"
  };
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--records") {
      options.records = Number(value);
      index += 1;
    } else if (argument === "--output") {
      options.output = resolve(value);
      index += 1;
    } else if (argument === "--format") {
      options.format = value;
      index += 1;
    } else if (argument === "--seed") {
      options.seed = value;
      index += 1;
    } else if (argument === "--help") {
      process.stdout.write(
        `Usage: generate-hosted-execution-fixture --records <${HOSTED_FIXTURE_TIERS.join("|")}> --output <directory> [--format ndjson|directory] [--seed value]\n`
      );
      process.exit(0);
    } else {
      throw new Error(`unknown or incomplete argument: ${argument}`);
    }
  }
  if (!options.records || !options.output) {
    throw new Error("--records and --output are required");
  }
  return options;
}
