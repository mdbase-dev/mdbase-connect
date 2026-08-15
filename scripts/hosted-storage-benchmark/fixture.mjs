import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";

const MIX = Object.freeze([
  ["tasknotes-task", 35],
  ["reader-source", 15],
  ["reader-annotation", 10],
  ["editor-note", 10],
  ["pickle-request", 10],
  ["pickle-response", 5],
  ["workout-exercise", 5],
  ["workout-plan", 3],
  ["workout-quick-log", 4],
  ["workout-session", 3]
]);

export const DEFAULT_SEED = "hosted-storage-model-v1";
export const ONE_GIB = 1_073_741_824;

export async function generateBenchmarkFixture({
  output,
  records,
  minimumCanonicalBytes,
  seed = DEFAULT_SEED,
  workloadContractPath,
  fixtureContractPath,
  sourceRevision = "unknown",
  sourceDirty = true,
  sourceDirtyPaths = []
}) {
  if (!output) throw new Error("output is required");
  if ((records === undefined) === (minimumCanonicalBytes === undefined)) {
    throw new Error("exactly one of records or minimumCanonicalBytes is required");
  }
  if (records !== undefined && (!Number.isSafeInteger(records) || records <= 0)) {
    throw new Error("records must be a positive safe integer");
  }
  if (minimumCanonicalBytes !== undefined
      && (!Number.isSafeInteger(minimumCanonicalBytes) || minimumCanonicalBytes <= 0)) {
    throw new Error("minimumCanonicalBytes must be a positive safe integer");
  }
  await ensureEmptyDirectory(output);
  const workloadContract = JSON.parse(await readFile(workloadContractPath, "utf8"));
  const fixtureContractText = await readFile(fixtureContractPath, "utf8");
  const fixtureContract = JSON.parse(fixtureContractText);
  assertFixtureContract(fixtureContract);
  const workloadContractText = await readFile(workloadContractPath, "utf8");
  const accumulators = new Map();
  for (const workload of workloadContract.queryWorkloads) {
    accumulators.set(workload.id, []);
    for (const scan of workload.providerScans ?? []) {
      accumulators.set(`${workload.id}:${scan.id}`, []);
    }
  }
  const shapeCounts = Object.fromEntries(MIX.map(([shape]) => [shape, 0]));
  const distributionCounts = {
    malformedOpaque: 0,
    unknownFrontmatter: 0,
    commonBodyNeedle: 0,
    selectiveBodyNeedle: 0,
    task: { status: {}, archived: 0, due: 0, overdue: 0, scheduled: 0, projects: 0, tags: 0, contexts: 0, dependencies: 0, recurrence: 0, customProperties: 0, attachments: 0 },
    reader: { status: {}, format: {}, kind: {}, annotationType: {}, tagsPerRecord: {}, annotationsPerSource: {} },
    pickle: { state: {}, responseType: {}, responseRecordType: {}, responsesPerRequest: {} },
    relationships: 0
  };
  const shapeBytes = Object.fromEntries(MIX.map(([shape]) => [shape, { records: 0, bytes: 0 }]));
  const sizes = [];
  const projectionSizes = [];
  const digest = createHash("sha256");
  const recordsPath = join(output, "records.ndjson");
  const handle = await open(recordsPath, "wx");
  let outputBuffer = "";
  let canonicalBytes = 0;
  let index = 0;
  try {
    while (records === undefined ? canonicalBytes < minimumCanonicalBytes : index < records) {
      const record = fixtureRecord(index, seed);
      const projectionBytes = Buffer.byteLength(JSON.stringify(record.projection));
      if (projectionBytes > fixtureContract.maximumProjectionEnvelopeBytes) {
        throw new Error(`projection envelope exceeds ${fixtureContract.maximumProjectionEnvelopeBytes} bytes at record ${index}`);
      }
      projectionSizes.push(projectionBytes);
      const documentBytes = Buffer.byteLength(record.document);
      canonicalBytes += documentBytes;
      sizes.push(documentBytes);
      shapeCounts[record.shape] += 1;
      shapeBytes[record.shape].records += 1;
      shapeBytes[record.shape].bytes += documentBytes;
      if (record.malformed) distributionCounts.malformedOpaque += 1;
      if (record.unknownFrontmatter) distributionCounts.unknownFrontmatter += 1;
      if (record.body.includes("common-body-needle")) distributionCounts.commonBodyNeedle += 1;
      if (record.body.includes("selective-body-needle")) {
        distributionCounts.selectiveBodyNeedle += 1;
      }
      accountDistribution(distributionCounts, record);
      const serialized = `${JSON.stringify({
        record_id: record.recordId,
        shape: record.shape,
        path: record.path,
        document: record.document,
        file_mtime: record.projection.file.mtime
      })}\n`;
      digest.update(serialized);
      outputBuffer += serialized;
      if (outputBuffer.length >= 4 * 1024 * 1024) {
        await handle.write(outputBuffer);
        outputBuffer = "";
      }
      for (const workload of workloadContract.queryWorkloads) {
        if (matches(workload.candidateIr, record)) {
          accumulators.get(workload.id).push(resultFact(workload, record));
        }
        for (const scan of workload.providerScans ?? []) {
          if (matches(scan.candidateIr, record)) {
            accumulators.get(`${workload.id}:${scan.id}`).push(resultFact(workload, record));
          }
        }
      }
      index += 1;
    }
  } finally {
    if (outputBuffer.length > 0) await handle.write(outputBuffer);
    await handle.close();
  }

  const resources = fixtureResources(1);
  const resourcesSerialized = `${resources.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await writeFile(join(output, "resources.ndjson"), resourcesSerialized, { flag: "wx" });
  const rebuiltResources = fixtureResources(2);
  const rebuiltResourcesSerialized = `${rebuiltResources.map((value) => JSON.stringify(value)).join("\n")}\n`;
  await writeFile(join(output, "resources-v2.ndjson"), rebuiltResourcesSerialized, { flag: "wx" });
  sizes.sort((left, right) => left - right);
  projectionSizes.sort((left, right) => left - right);
  finalizeDistributionCounts(distributionCounts, index);
  const expected = expectedResults(workloadContract.queryWorkloads, accumulators);
  const expectedText = `${JSON.stringify(expected, null, 2)}\n`;
  await writeFile(join(output, "expected-results.json"), expectedText, { flag: "wx" });
  const manifest = {
    schemaVersion: 1,
    fixture: "hosted-storage-model-v1",
    seed,
    synthetic: true,
    records: index,
    termination: records === undefined
      ? { minimumCanonicalBytes, overshootBytes: canonicalBytes - minimumCanonicalBytes }
      : { exactRecords: records },
    shapes: shapeCounts,
    shapeBytes,
    distributions: distributionCounts,
    documentBytes: {
      total: canonicalBytes,
      minimum: sizes[0],
      p50: percentile(sizes, 0.50),
      p95: percentile(sizes, 0.95),
      p99: percentile(sizes, 0.99),
      maximum: sizes.at(-1)
    },
    projectionEnvelopeBytes: {
      maximumAllowed: fixtureContract.maximumProjectionEnvelopeBytes,
      minimum: projectionSizes[0],
      p50: percentile(projectionSizes, 0.50),
      p95: percentile(projectionSizes, 0.95),
      p99: percentile(projectionSizes, 0.99),
      maximum: projectionSizes.at(-1)
    },
    resources: {
      count: resources.length,
      bytes: Buffer.byteLength(resourcesSerialized),
      catalogRevision: `sha256:${createHash("sha256").update(resourcesSerialized).digest("hex")}`,
      rebuildBytes: Buffer.byteLength(rebuiltResourcesSerialized),
      rebuildCatalogRevision: `sha256:${createHash("sha256").update(rebuiltResourcesSerialized).digest("hex")}`
    },
    recordsSha256: digest.digest("hex"),
    expectedResultsSha256: createHash("sha256").update(expectedText).digest("hex"),
    fixtureContractSha256: createHash("sha256").update(fixtureContractText).digest("hex"),
    workloadContractSha256: createHash("sha256").update(workloadContractText).digest("hex"),
    generator: "scripts/hosted-storage-benchmark/fixture.mjs",
    generatorSha256: createHash("sha256")
      .update(await readFile(import.meta.filename))
      .digest("hex"),
    sourceRevision,
    sourceDirty,
    sourceDirtyPaths,
    privacy: "Deterministic synthetic content only; never derived from production data."
  };
  await writeFile(
    join(output, "fixture-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { flag: "wx" }
  );
  return manifest;
}

export async function refreshExpectedResults({
  fixtureDirectory,
  workloadContractPath,
  sourceRevision,
  sourceDirty = false,
  sourceDirtyPaths = []
}) {
  const workloadContractText = await readFile(workloadContractPath, "utf8");
  const workloadContract = JSON.parse(workloadContractText);
  const manifestPath = join(fixtureDirectory, "fixture-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const accumulators = new Map();
  for (const workload of workloadContract.queryWorkloads) {
    accumulators.set(workload.id, []);
    for (const scan of workload.providerScans ?? []) {
      accumulators.set(`${workload.id}:${scan.id}`, []);
    }
  }
  for (let index = 0; index < manifest.records; index += 1) {
    const record = fixtureRecord(index, manifest.seed);
    for (const workload of workloadContract.queryWorkloads) {
      if (matches(workload.candidateIr, record)) {
        accumulators.get(workload.id).push(resultFact(workload, record));
      }
      for (const scan of workload.providerScans ?? []) {
        if (matches(scan.candidateIr, record)) {
          accumulators.get(`${workload.id}:${scan.id}`).push(resultFact(workload, record));
        }
      }
    }
  }
  const expectedText = `${JSON.stringify(
    expectedResults(workloadContract.queryWorkloads, accumulators),
    null,
    2
  )}\n`;
  await writeFile(join(fixtureDirectory, "expected-results.json"), expectedText);
  manifest.expectedResultsSha256 = createHash("sha256").update(expectedText).digest("hex");
  manifest.workloadContractSha256 = createHash("sha256")
    .update(workloadContractText)
    .digest("hex");
  manifest.generatorSha256 = createHash("sha256")
    .update(await readFile(import.meta.filename))
    .digest("hex");
  manifest.sourceRevision = sourceRevision;
  manifest.sourceDirty = sourceDirty;
  manifest.sourceDirtyPaths = sourceDirtyPaths;
  delete manifest.oracle;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

export function fixtureRecord(index, seed = DEFAULT_SEED) {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid fixture index");
  const { shape, ordinal } = shapeAt(index);
  const recordId = stableUuid(`${seed}:record:${index}`);
  const path = recordPath(shape, ordinal, seed);
  const frontmatter = recordFrontmatter(shape, ordinal, index, seed);
  const malformed = index % 101 === 0;
  const unknownFrontmatter = !malformed && index % 10 === 0;
  if (unknownFrontmatter) frontmatter.benchmark_unknown = `unknown-${index % 17}`;
  const body = recordBody(shape, ordinal, index, seed);
  const document = malformed
    ? `---\ntitle: [unterminated\n---\n${body}`
    : `---\n${Object.entries(frontmatter)
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join("\n")}\n---\n${body}`;
  const types = malformed ? opaqueTypes(shape, ordinal) : [shapeType(shape, ordinal)];
  const persisted = malformed ? {} : frontmatter;
  const effective = malformed
    ? {}
    : { benchmark_generation: 1, archived: false, ...frontmatter };
  const relationships = malformed ? [] : recordRelationships(shape, frontmatter);
  const name = basename(path);
  const extension = extname(name).slice(1);
  const projection = {
    schema_version: "hosted-benchmark-projection-v1",
    path,
    types,
    file: {
      path,
      name,
      basename: name.slice(0, name.length - (extension ? extension.length + 1 : 0)),
      extension,
      size: Buffer.byteLength(document),
      mtime: deterministicTime(index)
    },
    persisted_frontmatter: persisted,
    effective_frontmatter: effective,
    relationships,
    diagnostics: malformed
      ? [{ code: "frontmatter_parse_failed", severity: "error" }]
      : []
  };
  const revision = `sha256:${createHash("sha256").update(document).digest("hex")}`;
  const canonicalBody = malformed ? document : body;
  return { index, recordId, shape, path, document, body, canonicalBody, revision, projection, malformed, unknownFrontmatter };
}

export function fixtureResources(version = 1) {
  const definitions = [
    { name: "task", pathGlob: "tasks/*.md", required: ["type", "id", "title", "status"] },
    { name: "reader-source", pathGlob: "sources/**/*.md", required: ["type", "id", "title", "kind", "saved_at"], fieldsPresent: ["id", "title", "kind"], links: { "documents[].file": { target_type: "any", validate_exists: true }, "relations[].target": { target_type: "reader-source", validate_exists: false } } },
    { name: "reader-annotation", pathGlob: "annotations/**/*.md", required: ["type", "id", "source", "annotation_type", "created_at"], fieldsPresent: ["id", "source", "annotation_type"], links: { source: { target_type: "reader-source", validate_exists: true } } },
    { name: "note", pathGlob: "notes/*.md", required: ["type", "id", "title"] },
    { name: "pickle_request", required: ["type", "id", "kind", "response_type", "created_at"] },
    { name: "pickle_response_approval", required: ["type", "id", "request", "decision", "responded_at"], links: { request: { target_type: "pickle_request", validate_exists: true } } },
    { name: "pickle_response_ack", required: ["type", "id", "request", "message", "responded_at"], links: { request: { target_type: "pickle_request", validate_exists: true } } },
    { name: "exercise", pathGlob: "workouts/exercises/*.md", required: ["type", "id"] },
    { name: "workout-plan", pathGlob: "workouts/plans/*.md", required: ["type", "id"] },
    { name: "quick-log", pathGlob: "workouts/quick-logs/*.md", required: ["type", "id"] },
    { name: "workout-session", pathGlob: "workouts/sessions/*.md", required: ["type", "id"] }
  ].map(({ name, pathGlob, required, fieldsPresent, links }) => {
    const match = pathGlob
      ? { path_glob: pathGlob, ...(fieldsPresent ? { fields_present: fieldsPresent } : {}) }
      : undefined;
    const collection = {
      read_defaults: { benchmark_generation: version, archived: false },
      ...(links ? { links } : {})
    };
    const schema = {
      type: "object",
      additionalProperties: true,
      required,
      properties: { type: { const: name } }
    };
    return {
      path: `_types/${name}.md`,
      kind: "type",
      document: `---\nkind: mdbase.type\nname: ${name}\nversion: ${version}\n${match ? `match: ${JSON.stringify(match)}\n` : ""}collection: ${JSON.stringify(collection)}\nschema:\n  dialect: json-schema-2020-12\n  value: ${JSON.stringify(schema)}\n---\n`
    };
  });
  return [{
    path: "mdbase.yaml",
    kind: "configuration",
    document: "spec_version: \"0.3.0\"\nname: Hosted storage model benchmark\nsettings:\n  types_folder: _types\n  default_validation: warn\n  timezone: Australia/Melbourne\n"
  }, ...definitions];
}

function shapeAt(index) {
  const position = index % 100;
  const cycle = Math.floor(index / 100);
  let start = 0;
  for (const [shape, count] of MIX) {
    if (position < start + count) return { shape, ordinal: cycle * count + position - start };
    start += count;
  }
  throw new Error("invalid fixture mix");
}

function recordPath(shape, ordinal, seed = DEFAULT_SEED) {
  const value = String(ordinal).padStart(7, "0");
  const id = stableUuid(`${seed}:${shape}:${ordinal}`);
  return ({
    "tasknotes-task": `tasks/task-${value}.md`,
    "reader-source": `sources/source-${value}.md`,
    "reader-annotation": `annotations/annotation-${value}.md`,
    "editor-note": `notes/note-${value}.md`,
    "pickle-request": `requests/${id}-request-${value}.md`,
    "pickle-response": `responses/${id}-response-${value}.md`,
    "workout-exercise": `workouts/exercises/exercise-${value}.md`,
    "workout-plan": `workouts/plans/plan-${value}.md`,
    "workout-quick-log": `workouts/quick-logs/log-${value}.md`,
    "workout-session": `workouts/sessions/session-${value}.md`
  })[shape];
}

function shapeType(shape, ordinal = 0) {
  return ({
    "tasknotes-task": "task",
    "reader-source": "reader-source",
    "reader-annotation": "reader-annotation",
    "editor-note": "note",
    "pickle-request": "pickle_request",
    "pickle-response": ordinal % 10 >= 8 ? "pickle_response_ack" : "pickle_response_approval",
    "workout-exercise": "exercise",
    "workout-plan": "workout-plan",
    "workout-quick-log": "quick-log",
    "workout-session": "workout-session"
  })[shape];
}

function opaqueTypes(shape, ordinal) {
  return ["reader-source", "reader-annotation", "pickle-request", "pickle-response"].includes(shape)
    ? []
    : [shapeType(shape, ordinal)];
}

function recordFrontmatter(shape, ordinal, index, seed) {
  const id = stableUuid(`${seed}:${shape}:${ordinal}`);
  const common = { id, title: `${shape} ${ordinal}` };
  if (shape === "tasknotes-task") {
    const statuses = ["open", "done", "in-progress", "cancelled", "waiting"];
    return {
      ...common,
      type: "task",
      status: weighted(statuses, [40, 25, 15, 10, 10], ordinal),
      priority: weighted(["low", "normal", "high", "urgent"], [15, 60, 20, 5], ordinal),
      archived: ordinal % 100 < 10,
      due: ordinal % 100 < 25
        ? (ordinal % 100 < 10 ? `2026-01-${String((ordinal % 28) + 1).padStart(2, "0")}` : `2027-01-${String((ordinal % 28) + 1).padStart(2, "0")}`)
        : null,
      scheduled: ordinal % 100 >= 25 && ordinal % 100 < 50
        ? `2027-02-${String((ordinal % 28) + 1).padStart(2, "0")}`
        : null,
      projects: ordinal % 100 < 15 ? [`project-${ordinal % 23}`] : [],
      tags: ordinal % 100 < 25 ? ["hosted", `tag-${ordinal % 31}`] : [],
      contexts: ordinal % 100 < 15 ? [`context-${ordinal % 17}`] : [],
      blockedBy: ordinal % 100 < 5 && ordinal > 0 ? [`task-${String(ordinal - 1).padStart(7, "0")}`] : [],
      recurrence: ordinal % 100 < 10 ? "FREQ=WEEKLY" : null,
      customProperties: ordinal % 100 < 10 ? { score: ordinal % 101 } : {},
      attachments: ordinal % 100 < 5 ? [{ file: `attachments/task-${ordinal}.txt` }] : []
    };
  }
  if (shape === "reader-source") {
    const media = weighted(["application/pdf", "application/epub+zip", "text/html", "text/markdown"], [40, 20, 20, 20], ordinal);
    return {
      ...common,
      id: readerSourceId(ordinal),
      type: "reader-source",
      kind: weighted(["article", "book", "web", "note"], [40, 20, 20, 20], ordinal),
      authors: [`Author ${ordinal % 101}`, `Researcher ${(ordinal + 17) % 101}`],
      published: 1990 + (ordinal % 37),
      tags: readerTags(ordinal),
      reading: { status: weighted(["inbox", "queued", "reading", "finished", "archived", "abandoned"], [25, 10, 20, 20, 15, 10], ordinal) },
      documents: media === "text/markdown" ? [] : [{
        file_id: stableUuid(`${seed}:file:${ordinal}`),
        file: `files/source-${String(ordinal).padStart(7, "0")}.${mediaExtension(media)}`,
        revision: `sha256:${createHash("sha256").update(`${seed}:file:${ordinal}:contents`).digest("hex")}`,
        media_type: media,
        role: "primary"
      }],
      saved_at: deterministicTime(index)
    };
  }
  if (shape === "reader-annotation") {
    const source = annotationSourceOrdinal(ordinal);
    return { ...common, id: `ann_${String(ordinal).padStart(7, "0")}`, type: "reader-annotation", source: `[[${readerSourceId(source)}]]`, annotation_type: weighted(["highlight", "note", "bookmark"], [60, 30, 10], ordinal), created_at: deterministicTime(index), selector: { quote: `quotation ${ordinal}` } };
  }
  if (shape === "editor-note") {
    return { ...common, type: "note", status: ordinal % 3 === 0 ? "open" : "draft", aliases: [`Note ${ordinal}`], tags: ["editor", `area-${ordinal % 29}`], related: ordinal > 0 ? [`notes/note-${String(ordinal - 1).padStart(7, "0")}.md`] : [] };
  }
  if (shape === "pickle-request") {
    return { ...common, type: "pickle_request", status: ordinal % 20 === 18 ? "cancelled" : "pending", kind: weighted(["approval", "choice", "input", "notice", "message"], [50, 15, 10, 10, 15], ordinal), priority: weighted(["low", "normal", "high", "urgent"], [15, 60, 20, 5], ordinal), response_type: ordinal % 20 === 19 ? "pickle_response_ack" : "pickle_response_approval", created_at: deterministicTime(index), requested_by: `fixture-agent-${ordinal % 13}` };
  }
  if (shape === "pickle-response") {
    const requestOrdinal = pickleResponseRequestOrdinal(ordinal);
    const requestPath = recordPath("pickle-request", requestOrdinal, seed).replace(/\.md$/, "");
    const type = shapeType(shape, ordinal);
    return { ...common, type, request: `[[${requestPath}]]`, ...(type === "pickle_response_ack" ? { message: `Acknowledged ${ordinal}` } : { decision: ["approve", "reject", "revise"][ordinal % 3] }), responded_at: deterministicTime(index), responder: `reviewer-${ordinal % 11}` };
  }
  if (shape === "workout-exercise") return { ...common, type: "exercise", muscle_group: ["push", "pull", "legs"][ordinal % 3] };
  if (shape === "workout-plan") return { ...common, type: "workout-plan", exercises: [`exercise-${String(ordinal % 100).padStart(7, "0")}`] };
  if (shape === "workout-quick-log") return { ...common, type: "quick-log", logged_at: deterministicTime(index), duration_minutes: 10 + (ordinal % 90) };
  return { ...common, type: "workout-session", status: ordinal % 2 === 0 ? "complete" : "planned", date: dateOnly(index) };
}

function recordRelationships(shape, frontmatter) {
  if (shape === "reader-annotation") return [{ kind: "source", target: normalizeWikiTarget(frontmatter.source) }];
  if (shape === "pickle-response") return [{ kind: "request", target: normalizeWikiTarget(frontmatter.request) }];
  if (shape === "tasknotes-task") return frontmatter.blockedBy.map((target) => ({ kind: "blockedBy", target }));
  if (shape === "editor-note") return frontmatter.related.map((target) => ({ kind: "related", target }));
  return [];
}

function recordBody(shape, ordinal, index, seed) {
  const digest = createHash("sha256").update(`${seed}:body:${index}`).digest();
  let target = 384 + (digest.readUInt32BE(0) % (8192 - 384 + 1));
  if (index > 0 && index % 10_007 === 0) target = 524_288;
  else if (index > 0 && index % 997 === 0) target = 65_536;
  const needles = `${index % 5 === 0 ? " common-body-needle" : ""}${index % 9_973 === 0 ? " selective-body-needle" : ""}`;
  const sentence = `${shape} synthetic body ${ordinal}; token ${digest.toString("hex").slice(0, 16)}.${needles} `;
  return `${sentence.repeat(Math.ceil(target / sentence.length)).slice(0, Math.max(0, target - 1))}\n`;
}

function readerTags(ordinal) {
  const position = ordinal % 100;
  if (position < 25) return [];
  const count = position < 65 ? 1 : position < 90 ? 3 : 8;
  return Array.from(
    { length: count },
    (_, index) => index === 0 ? "literature" : `topic-${(ordinal + index) % 43}`
  );
}

function mediaExtension(mediaType) {
  return ({
    "application/pdf": "pdf",
    "application/epub+zip": "epub",
    "text/html": "html"
  })[mediaType] ?? "md";
}

function annotationSourceOrdinal(ordinal) {
  const cycle = Math.floor(ordinal / 10);
  return cycle * 15 + [8, 9, 10, 11, 12, 13, 13, 14, 14, 14][ordinal % 10];
}

function readerSourceId(ordinal) {
  return `src_${String(ordinal).padStart(7, "0")}`;
}

function pickleResponseRequestOrdinal(ordinal) {
  const cycle = Math.floor(ordinal / 10);
  return cycle * 20 + [10, 11, 12, 13, 14, 15, 16, 17, 19, 19][ordinal % 10];
}

function normalizeWikiTarget(value) {
  const unwrapped = value.replace(/^\[\[/, "").replace(/\]\]$/, "").split("|")[0];
  return unwrapped;
}

function matches(expression, record) {
  if (expression.all) return expression.all.every((item) => matches(item, record));
  if (expression.any) return expression.any.some((item) => matches(item, record));
  if (expression.not) return !matches(expression.not, record);
  if (expression.typeIn) return expression.typeIn.some((type) => record.projection.types.includes(type));
  if (expression.fieldEq) return deepEqual(field(record, expression.fieldEq[0]), expression.fieldEq[1]);
  if (expression.fieldIn) return expression.fieldIn[1].some((value) => deepEqual(field(record, expression.fieldIn[0]), value));
  if (expression.fieldContains) {
    const value = field(record, expression.fieldContains[0]);
    return Array.isArray(value) && value.some((item) => deepEqual(item, expression.fieldContains[1]));
  }
  if (expression.fieldContainsText) return String(field(record, expression.fieldContainsText[0]) ?? "").toLowerCase().includes(expression.fieldContainsText[1].toLowerCase());
  if (expression.fieldLt) {
    const value = field(record, expression.fieldLt[0]);
    return value !== null && value !== undefined && value < expression.fieldLt[1];
  }
  if (expression.relationshipTargetEq) return record.projection.relationships.some(({ target }) => target === expression.relationshipTargetEq);
  if (expression.bodyContains) return record.canonicalBody.toLowerCase().includes(expression.bodyContains.toLowerCase());
  throw new Error(`unknown candidate expression: ${JSON.stringify(expression)}`);
}

function resultFact(workload, record) {
  const response = workload.responseFields.map((path) => [path, responseField(record, path)]);
  const responseWithoutBody = response.filter(([path]) => path !== "body" && path !== "document");
  return {
    recordId: record.recordId,
    path: record.path,
    sort: (workload.order ?? []).map(({ field }) => responseField(record, field)),
    responseDigest: createHash("sha256").update(canonicalJson(response)).digest("hex"),
    responseDigestWithoutBody: createHash("sha256").update(canonicalJson(responseWithoutBody)).digest("hex"),
    clientResidual: workload.clientResidual ? matches(workload.clientResidual, record) : undefined,
    residualMatch: workload.canonicalResidual && typeof workload.canonicalResidual === "object"
      ? matches(workload.canonicalResidual, record)
      : true,
    group: workload.group?.map(({ field }) => responseField(record, field)),
    types: record.projection.types,
    status: record.projection.effective_frontmatter.status,
    relationships: record.projection.relationships,
    sourceIdentity: record.projection.effective_frontmatter.id
  };
}

function expectedResults(workloads, accumulators) {
  const results = {};
  for (const workload of workloads) {
    const candidateFacts = accumulators.get(workload.id);
    const providerScans = (workload.providerScans ?? [{ id: "candidate", page: workload.page }])
      .map((scan) => {
        const facts = [...(workload.providerScans
          ? accumulators.get(`${workload.id}:${scan.id}`)
          : candidateFacts)];
        facts.sort((left, right) => compareFacts(left, right, scan.order ?? workload.order ?? []));
        const includeBody = scan.includeBody ?? workload.responseFields.includes("body");
        const selected = selectPageDomain(facts, scan.page).map((fact) => includeBody
          ? fact
          : { ...fact, responseDigest: fact.responseDigestWithoutBody });
        return {
          id: scan.id,
          rows: facts.length,
          includeBody,
          pages: pageFactsFor(selected, scan.page),
          orderedRecordIdsDigest: digestValues(selected.map(({ recordId }) => recordId))
        };
      });
    let facts = candidateFacts.filter(({ residualMatch }) => residualMatch);
    const canonicalResidualMatches = facts.length;
    if (workload.clientResidual) facts = facts.filter(({ clientResidual }) => clientResidual);
    const clientResidualMatches = facts.length;
    if (workload.consumerTransform?.kind === "readerContentMergeBySource") {
      const merged = new Map();
      for (const fact of facts) {
        const source = fact.types.includes("reader-source")
          ? fact.sourceIdentity
          : fact.relationships.find(({ kind }) => kind === "source")?.target;
        if (!source) continue;
        const current = merged.get(source) ?? { source, kinds: new Set(), responseDigests: [] };
        current.kinds.add(fact.types.includes("reader-source") ? "source-note" : "annotation");
        current.responseDigests.push(fact.responseDigest);
        merged.set(source, current);
      }
      facts = [...merged.values()].map((value) => ({
        recordId: value.source,
        path: value.source,
        sort: [value.source],
        responseDigest: createHash("sha256").update(canonicalJson({
          source: value.source,
          kinds: [...value.kinds].sort(),
          records: value.responseDigests.sort()
        })).digest("hex")
      }));
    }
    if (workload.consumerTransform?.kind === "picklePendingByResponseMultiplicity") {
      const responseCounts = new Map();
      for (const fact of facts.filter(({ types }) => !types.includes("pickle_request"))) {
        const target = fact.relationships.find(({ kind }) => kind === "request")?.target;
        if (target) responseCounts.set(target, (responseCounts.get(target) ?? 0) + 1);
      }
      facts = facts.filter(({ types, path, status }) =>
        types.includes("pickle_request")
        && status !== "cancelled"
        && (responseCounts.get(path) ?? 0) === 0
      );
    }
    if (workload.consumerTransform?.kind === "pickleAllRequestsWithResponseMultiplicity") {
      const responseCounts = new Map();
      for (const fact of facts.filter(({ types }) => !types.includes("pickle_request"))) {
        const target = fact.relationships.find(({ kind }) => kind === "request")?.target;
        if (target) responseCounts.set(target, (responseCounts.get(target) ?? 0) + 1);
      }
      facts = facts
        .filter(({ types }) => types.includes("pickle_request"))
        .map((fact) => ({
          ...fact,
          responseDigest: createHash("sha256")
            .update(`${fact.responseDigest}:${responseCounts.get(fact.path) ?? 0}`)
            .digest("hex")
        }));
    }
    if (workload.group) {
      const groups = new Map();
      for (const fact of facts) {
        const key = JSON.stringify(fact.group);
        groups.set(key, (groups.get(key) ?? 0) + 1);
      }
      const entries = [...groups].sort(([left], [right]) => left.localeCompare(right));
      results[workload.id] = {
        canonicalOutcome: "success",
        acceptableRunOutcomes: acceptableOutcomes(workload),
        providerScans,
        candidateRows: candidateFacts.length,
        canonicalResidualMatches,
        clientResidualMatches,
        consumerResultCount: facts.length,
        totalMatches: facts.length,
        groups: entries.map(([key, count]) => ({ key: JSON.parse(key), count })),
        completenessDigest: digestValues(entries.map(([key, count]) => `${key}:${count}`))
      };
      continue;
    }
    facts.sort((left, right) => compareFacts(left, right, workload.order ?? []));
    const selected = selectPageDomain(facts, workload.page);
    const pageFacts = pageFactsFor(selected, workload.page);
    results[workload.id] = {
      canonicalOutcome: "success",
      acceptableRunOutcomes: acceptableOutcomes(workload),
      providerScans,
      candidateRows: candidateFacts.length,
      canonicalResidualMatches,
      clientResidualMatches,
      consumerResultCount: facts.length,
      totalMatches: facts.length,
      returned: selected.length,
      pageCount: pageFacts.length,
      pages: pageFacts,
      firstRecordId: selected[0]?.recordId ?? null,
      lastRecordId: selected.at(-1)?.recordId ?? null,
      orderedRecordIdsDigest: digestValues(selected.map(({ recordId }) => recordId)),
      responseFieldsDigest: digestValues(selected.map(({ responseDigest }) => responseDigest))
    };
  }
  return {
    schemaVersion: 2,
    oracle: "independent-js-seed-pending-mdbase-rs-verification",
    workloads: results,
    mutations: mutationOracles()
  };
}

function selectPageDomain(facts, page = {}) {
  const firstLimit = page.limit ?? page.firstLimit ?? facts.length;
  const offset = page.offset ?? 0;
  return page.repeatToCompletion
    ? facts.slice(offset)
    : facts.slice(offset, offset + firstLimit);
}

function pageFactsFor(selected, page = {}) {
  const firstLimit = page.limit ?? page.firstLimit ?? selected.length;
  const subsequentLimit = page.subsequentLimit ?? firstLimit;
  const output = [];
  let start = 0;
  while (start < selected.length) {
    const limit = output.length === 0 ? firstLimit : subsequentLimit;
    const values = selected.slice(start, start + limit);
    output.push({
      page: output.length,
      count: values.length,
      firstRecordId: values[0]?.recordId ?? null,
      lastRecordId: values.at(-1)?.recordId ?? null,
      orderedRecordIdsDigest: digestValues(values.map(({ recordId }) => recordId)),
      responseFieldsDigest: digestValues(values.map(({ responseDigest }) => responseDigest))
    });
    start += limit;
  }
  return output;
}

function mutationOracles() {
  return {
    "point.exact_read": { targetIndex: 1, assertion: "exact document and canonical read envelope" },
    "write.body_only": { targetIndex: 2, append: "\nBenchmark body-only update.\n", semanticPayloadChanged: false, bindingAndFileFactsChanged: true },
    "write.frontmatter": { targetIndex: 3, patch: { status: "done", tags: ["hosted", "benchmark-updated"], projects: ["project-7"] }, semanticPayloadChanged: true },
    "write.path": { targetIndex: 60, destination: "notes/renamed-benchmark-note.md", semanticPayloadChanged: true },
    "write.resource_rebuild": { fromCatalogVersion: 1, toCatalogVersion: 2, defaultPatch: { benchmark_generation: 2 } },
    "write.recovery": { targetIndex: 4, failureStages: ["before_exact_write", "after_exact_write", "after_projection_write", "before_checkpoint", "after_checkpoint"] },
    "authorization.stale_projection": { targetIndex: 5, assertion: "current projection or exact canonical fallback; otherwise fail closed" }
  };
}

function acceptableOutcomes(workload) {
  return [
    ...workload.acceptableRunOutcomes,
    ...workload.acceptableBudgetKinds.map((kind) => `budget:${kind}`),
    ...workload.acceptableErrorCodes.map((code) => `error:${code}`)
  ];
}

function compareFacts(left, right, order) {
  for (let index = 0; index < order.length; index += 1) {
    const direction = order[index].direction === "desc" ? -1 : 1;
    const compared = compareValues(left.sort[index], right.sort[index], order[index].nulls ?? "last");
    if (compared !== 0) return compared * direction;
  }
  return left.recordId.localeCompare(right.recordId);
}

function compareValues(left, right, nulls) {
  if (left === null || left === undefined) return right === null || right === undefined ? 0 : (nulls === "first" ? -1 : 1);
  if (right === null || right === undefined) return nulls === "first" ? 1 : -1;
  if (typeof left === "number" && typeof right === "number") return left - right;
  return String(left).localeCompare(String(right));
}

function responseField(record, path) {
  if (path === "body") return record.canonicalBody;
  if (path === "revision" || path === "document_revision") return record.revision;
  if (path === "document") return record.document;
  if (path === "relationships") return record.projection.relationships;
  if (path.startsWith("groups.") || path.startsWith("meta.")) return null;
  return field(record, path);
}

function field(record, path) {
  return path.split(".").reduce((value, segment) => value?.[segment], record.projection);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function assertFixtureContract(contract) {
  const expected = Object.fromEntries(MIX);
  if (!deepEqual(contract.recordMixPer100, expected)) {
    throw new Error("fixture contract recordMixPer100 does not match the generator mix");
  }
  const expectedDistributions = {
    tasknotes: {
      status: { open: 40, done: 25, "in-progress": 15, cancelled: 10, waiting: 10 },
      archivedPercent: 10,
      duePercent: 25,
      scheduledPercent: 25,
      overduePercent: 10,
      recurringPercent: 10,
      projectsPercent: 15,
      tagsPercent: 25,
      contextsPercent: 15,
      dependenciesPercent: 5,
      customFieldsPercent: 10,
      attachmentsPercent: 5
    },
    reader: {
      readingStatus: { inbox: 25, queued: 10, reading: 20, finished: 20, archived: 15, abandoned: 10 },
      format: { pdf: 40, epub: 20, html: 20, note: 20 },
      kind: { article: 40, book: 20, web: 20, note: 20 },
      annotationType: { highlight: 60, note: 30, bookmark: 10 },
      tagsPerRecord: { 0: 25, 1: 40, 3: 25, 8: 10 },
      annotationsPer15Sources: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 2, 3]
    },
    pickle: {
      requestState: { pending: 50, answered: 40, cancelled: 5, conflict: 5 },
      kind: { approval: 50, choice: 15, input: 10, notice: 10, message: 15 },
      priority: { low: 15, normal: 60, high: 20, urgent: 5 },
      responsesPer20Requests: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 0, 2]
    },
    bodyBytes: {
      ordinaryMinimum: 384,
      ordinaryMaximum: 8192,
      largeEvery: 997,
      largeBytes: 65536,
      veryLargeEvery: 10007,
      veryLargeBytes: 524288,
      commonNeedlePercent: 20,
      selectiveNeedleEvery: 9973
    },
    malformedOpaqueEvery: 101,
    unknownFrontmatterEvery: 10,
    unknownFrontmatterExcludesMalformed: true,
    relationships: {
      taskDependencyTargets: "previous task modulo live task count",
      readerAnnotationTargets: "deterministic source modulo reader-source count",
      pickleResponseTargets: "deterministic request modulo pickle-request count",
      editorLinks: "previous editor note modulo editor-note count"
    }
  };
  if (!deepEqual(contract.distributions, expectedDistributions)) {
    throw new Error("fixture contract distributions do not match the generator rules");
  }
  const expectedTypes = fixtureResources(1).filter(({ kind }) => kind === "type")
    .map(({ path }) => basename(path, ".md"));
  if (!deepEqual(contract.resources.types, expectedTypes)) {
    throw new Error("fixture contract resource types do not match generated resources");
  }
  if (contract.maximumProjectionEnvelopeBytes !== 262_144) {
    throw new Error("fixture projection envelope cap must remain 256 KiB");
  }
}

function accountDistribution(counts, record) {
  counts.relationships += record.projection.relationships.length;
  const frontmatter = record.projection.persisted_frontmatter;
  if (record.shape === "tasknotes-task" && !record.malformed) {
    increment(counts.task.status, frontmatter.status);
    for (const key of ["archived", "due", "scheduled", "projects", "tags", "contexts", "blockedBy", "recurrence", "customProperties", "attachments"]) {
      const value = frontmatter[key];
      const present = Array.isArray(value)
        ? value.length > 0
        : value && typeof value === "object"
          ? Object.keys(value).length > 0
          : Boolean(value);
      if (!present) continue;
      const output = ({ blockedBy: "dependencies" })[key] ?? key;
      counts.task[output] += 1;
    }
    if (frontmatter.due && frontmatter.due < "2026-08-16") counts.task.overdue += 1;
  }
  if (record.shape === "reader-source" && !record.malformed) {
    increment(counts.reader.status, frontmatter.reading.status);
    const mediaType = frontmatter.documents[0]?.media_type ?? "note";
    increment(counts.reader.format, mediaType);
    increment(counts.reader.kind, frontmatter.kind);
    increment(counts.reader.tagsPerRecord, String(frontmatter.tags.length));
    counts.reader._sources ??= [];
    counts.reader._sources.push(record.path);
  }
  if (record.shape === "reader-annotation" && !record.malformed) {
    increment(counts.reader.annotationType, frontmatter.annotation_type);
    counts.reader._annotationTargets ??= {};
    increment(counts.reader._annotationTargets, record.projection.relationships[0]?.target);
  }
  if (record.shape === "pickle-request" && !record.malformed) {
    counts.pickle._requests ??= {};
    counts.pickle._requests[record.path] = frontmatter.status;
    increment(counts.pickle.responseType, frontmatter.response_type);
  }
  if (record.shape === "pickle-response" && !record.malformed) {
    counts.pickle._responseTargets ??= {};
    increment(counts.pickle._responseTargets, record.projection.relationships[0]?.target);
    increment(counts.pickle.responseRecordType, frontmatter.type);
  }
}

function finalizeDistributionCounts(counts) {
  for (const source of counts.reader._sources ?? []) {
    increment(
      counts.reader.annotationsPerSource,
      String(counts.reader._annotationTargets?.[source] ?? 0)
    );
  }
  delete counts.reader._sources;
  delete counts.reader._annotationTargets;
  for (const [request, status] of Object.entries(counts.pickle._requests ?? {})) {
    const responses = counts.pickle._responseTargets?.[request] ?? 0;
    increment(counts.pickle.responsesPerRequest, String(responses));
    increment(
      counts.pickle.state,
      status === "cancelled" ? "cancelled" : responses === 0 ? "pending" : responses === 1 ? "answered" : "conflict"
    );
  }
  delete counts.pickle._requests;
  delete counts.pickle._responseTargets;
}

function increment(target, key) {
  if (key === undefined) return;
  target[key] = (target[key] ?? 0) + 1;
}

function digestValues(values) {
  const hash = createHash("sha256");
  for (const value of values) hash.update(`${value}\n`);
  return `sha256:${hash.digest("hex")}`;
}

function weighted(values, weights, ordinal) {
  const position = ordinal % weights.reduce((sum, value) => sum + value, 0);
  let start = 0;
  for (let index = 0; index < values.length; index += 1) {
    if (position < start + weights[index]) return values[index];
    start += weights[index];
  }
  throw new Error("invalid weighted distribution");
}

function deterministicTime(index) {
  return new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
}

function dateOnly(index) {
  return new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString().slice(0, 10);
}

function stableUuid(value) {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

async function ensureEmptyDirectory(path) {
  await mkdir(path, { recursive: true });
  if ((await readdir(path)).length > 0) throw new Error(`output directory is not empty: ${path}`);
}
