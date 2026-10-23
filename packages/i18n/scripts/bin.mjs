#!/usr/bin/env node
import { main } from "./cli.mjs";

main(process.argv[2], process.argv.slice(3)).catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
