import { createHash } from "node:crypto";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const HOSTED_FIXTURE_TIERS = Object.freeze([100, 10_000, 100_000, 1_000_000]);

const RESOURCE_DOCUMENTS = Object.freeze([
  {
    path: "mdbase.yaml",
    document: `spec_version: "0.3.0"
name: "Hosted execution synthetic fixture"
settings:
  types_folder: "_types"
  validation: "error"
  timezone: "Australia/Melbourne"
  exclude: ["_types", ".mdbase"]
`
  },
  {
    path: "_types/task.md",
    document: `---
kind: mdbase.type
name: task
version: 1
match:
  path_glob: ["tasks/*.md"]
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, id, title, status]
    additionalProperties: true
    properties:
      type: { const: task }
      id: { type: string }
      title: { type: string }
      status: { enum: [open, in-progress, done, cancelled] }
      priority: { enum: [low, normal, high, urgent] }
---

# Task
`
  },
  {
    path: "_types/literature.md",
    document: `---
kind: mdbase.type
name: literature
version: 1
match:
  path_glob: ["literature/*.md"]
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, id, title, year]
    additionalProperties: true
    properties:
      type: { const: literature }
      id: { type: string }
      title: { type: string }
      year: { type: integer }
---

# Literature
`
  },
  {
    path: "_types/note.md",
    document: `---
kind: mdbase.type
name: note
version: 1
match:
  path_glob: ["notes/*.md"]
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, id, title]
    additionalProperties: true
    properties:
      type: { const: note }
      id: { type: string }
      title: { type: string }
---

# Note
`
  },
  {
    path: "_types/pickle-request.md",
    document: `---
kind: mdbase.type
name: pickle-request
version: 1
match:
  path_glob: ["requests/*.md"]
schema:
  dialect: json-schema-2020-12
  value:
    type: object
    required: [type, id, title, request_state]
    additionalProperties: true
    properties:
      type: { const: pickle-request }
      id: { type: string }
      title: { type: string }
      request_state: { enum: [open, answered, cancelled] }
---

# Request
`
  }
]);

export function fixtureResources() {
  return RESOURCE_DOCUMENTS.map((resource) => ({ ...resource }));
}

export function fixtureRecord(index, seed = "hosted-execution-v1") {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new Error("fixture index must be a non-negative safe integer");
  }
  const id = stableUuid(`${seed}:record:${index}`);
  const selector = index % 10;
  if (selector < 5) return taskRecord(index, id, seed);
  if (selector < 7) return literatureRecord(index, id, seed);
  if (selector < 9) return editorRecord(index, id, seed);
  return pickleRecord(index, id, seed);
}

export async function generateHostedFixture({
  records,
  output,
  format = "ndjson",
  seed = "hosted-execution-v1"
}) {
  if (!HOSTED_FIXTURE_TIERS.includes(records)) {
    throw new Error(`records must be one of: ${HOSTED_FIXTURE_TIERS.join(", ")}`);
  }
  if (!output) throw new Error("output is required");
  if (!new Set(["ndjson", "directory"]).has(format)) {
    throw new Error("format must be ndjson or directory");
  }
  await ensureEmptyDirectory(output);

  const shapes = { tasknotes: 0, literature: 0, editor: 0, pickle: 0 };
  const sizes = [];
  const recordsPath = join(output, "records.ndjson");
  let ndjson = "";
  for (let index = 0; index < records; index += 1) {
    const record = fixtureRecord(index, seed);
    shapes[record.shape] += 1;
    sizes.push(Buffer.byteLength(record.document));
    if (format === "directory") {
      const destination = join(output, record.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, record.document, { flag: "wx" });
    } else {
      ndjson += `${JSON.stringify(record)}\n`;
      if (ndjson.length >= 4 * 1024 * 1024) {
        await appendExclusive(recordsPath, ndjson);
        ndjson = "";
      }
    }
  }
  if (format === "ndjson" && ndjson.length > 0) {
    await appendExclusive(recordsPath, ndjson);
  }

  const resources = fixtureResources();
  if (format === "directory") {
    for (const resource of resources) {
      const destination = join(output, resource.path);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, resource.document, { flag: "wx" });
    }
  } else {
    await writeFile(
      join(output, "resources.ndjson"),
      `${resources.map((resource) => JSON.stringify(resource)).join("\n")}\n`,
      { flag: "wx" }
    );
  }

  sizes.sort((left, right) => left - right);
  const manifest = {
    schemaVersion: 1,
    fixture: "hosted-execution-v1",
    seed,
    synthetic: true,
    records,
    format,
    shapes,
    documentBytes: {
      total: sizes.reduce((sum, value) => sum + value, 0),
      minimum: sizes[0],
      p50: percentile(sizes, 0.5),
      p95: percentile(sizes, 0.95),
      p99: percentile(sizes, 0.99),
      maximum: sizes.at(-1)
    },
    resources: resources.map(({ path, document }) => ({
      path,
      bytes: Buffer.byteLength(document)
    })),
    privacy: "Deterministic synthetic content only; never derived from production data."
  };
  await writeFile(
    join(output, "fixture-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  return manifest;
}

function taskRecord(index, id, seed) {
  const status = ["open", "in-progress", "done", "cancelled"][index % 4];
  const priority = ["low", "normal", "high", "urgent"][index % 4];
  const body = sizedBody(index, seed, 500, 2_000, "task progress and implementation notes");
  return {
    record_id: id,
    shape: "tasknotes",
    path: `tasks/task-${padded(index)}.md`,
    document: `---
type: task
id: ${id}
title: Synthetic task ${index}
status: ${status}
priority: ${priority}
tags: [synthetic, hosted, batch-${index % 37}]
due: 2027-${String((index % 12) + 1).padStart(2, "0")}-${String((index % 27) + 1).padStart(2, "0")}
---

# Synthetic task ${index}

${body}
`
  };
}

function literatureRecord(index, id, seed) {
  const body = sizedBody(index, seed, 1_500, 5_000, "literature annotation evidence and synthesis");
  return {
    record_id: id,
    shape: "literature",
    path: `literature/@fixture-${padded(index)}.md`,
    document: `---
type: literature
id: ${id}
citekey: fixture${index}
title: Synthetic literature source ${index}
authors: [Author ${index % 101}, Researcher ${(index + 17) % 101}]
year: ${1990 + (index % 37)}
tags: [synthetic, literature, topic-${index % 43}]
rating: ${1 + (index % 5)}
---

# Synthetic literature source ${index}

${body}
`
  };
}

function editorRecord(index, id, seed) {
  const previous = Math.max(0, index - 1);
  const body = sizedBody(index, seed, 700, 3_500, "editor note with linked context and prose");
  return {
    record_id: id,
    shape: "editor",
    path: `notes/note-${padded(index)}.md`,
    document: `---
type: note
id: ${id}
title: Synthetic editor note ${index}
aliases: [Note ${index}, Fixture ${index}]
tags: [synthetic, editor, area-${index % 29}]
related: ["[[notes/note-${padded(previous)}.md]]"]
---

# Synthetic editor note ${index}

Related context: [[notes/note-${padded(previous)}.md]].

${body}
`
  };
}

function pickleRecord(index, id, seed) {
  const state = ["open", "answered", "cancelled"][index % 3];
  const body = sizedBody(index, seed, 350, 1_400, "approval request context and decision evidence");
  return {
    record_id: id,
    shape: "pickle",
    path: `requests/request-${padded(index)}.md`,
    document: `---
type: pickle-request
id: ${id}
title: Synthetic approval request ${index}
request_state: ${state}
requested_by: fixture-agent-${index % 13}
tags: [synthetic, approval, queue-${index % 11}]
---

# Synthetic approval request ${index}

${body}
`
  };
}

function sizedBody(index, seed, minimum, ordinaryMaximum, phrase) {
  const digest = createHash("sha256").update(`${seed}:body:${index}`).digest();
  let target = minimum + (digest.readUInt32BE(0) % (ordinaryMaximum - minimum + 1));
  if (index > 0 && index % 10_007 === 0) target = 512 * 1024;
  else if (index > 0 && index % 997 === 0) target = 64 * 1024;
  const sentence = `${phrase}; deterministic token ${digest.toString("hex").slice(0, 16)}. `;
  return sentence.repeat(Math.ceil(target / sentence.length)).slice(0, target);
}

function stableUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function padded(index) {
  return String(index).padStart(7, "0");
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

async function ensureEmptyDirectory(path) {
  await mkdir(path, { recursive: true });
  const entries = await readdir(path);
  if (entries.length > 0) {
    throw new Error(`output directory is not empty: ${path}`);
  }
}

async function appendExclusive(path, contents) {
  const { open } = await import("node:fs/promises");
  const handle = await open(path, "a");
  try {
    await handle.write(contents);
  } finally {
    await handle.close();
  }
}
