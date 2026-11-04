#!/usr/bin/env node
// Exits 0 when the diff touches the client contract axis. Services report the
// commit their image was built from, so such a commit needs images of its own
// or client publication could never prove production contains it.
import { contractSensitive, git } from "./lib/continuous-client-release.mjs";

const [base, head] = process.argv.slice(2);
const paths = git("diff", "--no-renames", "--name-only", "-z", base, head).split("\0").filter(Boolean);
process.exit(paths.some(contractSensitive) ? 0 : 1);
