// BUILD ONLY, following tsc. Docker/server managed builds never call this step.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const output = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/local-build.js');
const source = fs.readFileSync(output, 'utf8');
const managed = 'export const LOCAL_REHEARSAL_BUILD = false;';
if (source.split(managed).length !== 2) throw Error('expected fresh managed tsc output for local build');
fs.writeFileSync(output, source.replace(managed, 'export const LOCAL_REHEARSAL_BUILD = true;'), { mode: 0o644 });
