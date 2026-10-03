import { MAX_READ_MANY_PATHS, type JsonObject, type MdbaseDiagnostic, type ReadManyDocumentsResult, type RecordDocument } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError, connectError, connectProblem } from "./errors.js";
import { COLLECTION_QUERY_PROBLEM_CODES, captureConnectOutcome, connectFailure, connectSuccess, type CollectionQueryProblemCode, type ConnectFailure, type ConnectOutcome } from "./outcomes.js";
import type { ConnectRequestOptions, QueryAllOptions, QueryInput, QueryResult, ReadManyBatchError, ReadManyEntry, ReadManyOptions, ReadManyRecord, ReadManyResult } from "./operation-types.js";
import { requestOptionsWithinBudget, withRequestBudget } from "./request-budget.js";

type QueryAll<Frontmatter extends JsonObject> = (
  input: QueryInput,
  options: QueryAllOptions<Frontmatter>
) => Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;
type ReadDocuments<Frontmatter extends JsonObject> = (
  paths: string[], includeBody: boolean, options: ConnectRequestOptions
) => Promise<ConnectOutcome<ReadManyDocumentsResult<Frontmatter>, CollectionQueryProblemCode>>;

export async function readMany<Frontmatter extends JsonObject>(
  queryAll: QueryAll<Frontmatter>,
  readDocuments: ReadDocuments<Frontmatter>,
  supports: ((id: string, options: ConnectRequestOptions) => Promise<ConnectOutcome<boolean>>) | undefined,
  paths: readonly string[],
  options: ReadManyOptions,
  defaultTimeoutMs: number | null
): Promise<ConnectOutcome<ReadManyResult<Frontmatter>, CollectionQueryProblemCode>> {
  if (options.revisions !== undefined && typeof options.revisions !== "boolean") throw new TypeError("revisions must be boolean.");
  const requestedBatchSize = boundedInteger(options.batchSize ?? (options.revisions === false ? 1_000 : 100), 1_000, "batchSize");
  const concurrency = boundedInteger(options.concurrency ?? 4, 4, "concurrency");
  if (options.coordination?.latestWins) throw new TypeError("readMany batches cannot use latestWins coordination.");
  if (options.includeBody !== undefined && typeof options.includeBody !== "boolean") throw new TypeError("includeBody must be boolean.");
  if (options.frontmatterMode !== undefined && !["effective", "persisted", "both"].includes(options.frontmatterMode)) throw new TypeError("Invalid frontmatterMode.");
  const inputs = [...paths];
  try {
    return await withRequestBudget(options, defaultTimeoutMs, async budget => {
      if (!inputs.length) return connectSuccess({ results: [], errors: [] });
      const requestOptions = requestOptionsWithinBudget({ ...options, timeoutMs: null, coordination: { ...options.coordination, coalesce: false } }, budget);
      const unique = [...new Set(inputs)];
      const entries = new Map<string, ReadManyEntry<Frontmatter>>();
      const errors: ReadManyBatchError[] = [];
      const batchDiagnostics: MdbaseDiagnostic[][] = [];
      let nextBatch = 0;
      let nextPath = 0;
      const failBatch = (batch: number, selected: string[], failure: ConnectFailure<CollectionQueryProblemCode>) => {
        errors.push({ batch, paths: selected, failure });
        for (const path of selected) entries.set(path, { status: "error", path, batch });
      };
      const worker = async () => {
        while (!budget.signal.aborted && nextPath < unique.length) {
          // Recheck cached lifetime evidence at each admission: queued work must
          // not borrow a retired route's support after reconnect/reauthorization.
          const support = options.revisions === false ? undefined : await supports?.("read-many-documents-v1", requestOptions);
          if (support && !support.ok) {
            nextPath = unique.length;
            throw new MdbaseConnectError(support.problem);
          }
          if (budget.signal.aborted || nextPath >= unique.length) return;
          let documents = support?.value === true;
          // Writer, Reader, TaskNotes, editor and standalone legacy providers
          // retain typed path queries until B1's minimum-authority, consumer-pin
          // adoption, N-1/rollback and connection-cache windows close. No probing.
          const batchSize = documents ? Math.min(requestedBatchSize, MAX_READ_MANY_PATHS) : requestedBatchSize;
          const batch = nextBatch++;
          const selected = unique.slice(nextPath, nextPath + batchSize);
          nextPath += selected.length;
          const criteria = { where: `file.path in ${JSON.stringify(selected)}`, ...(options.types ? { types: options.types } : {}) };
          try {
            let targets = selected;
            let diagnostics: MdbaseDiagnostic[] = [];
            if (documents && options.types !== undefined) {
              // Only the authority evaluates type membership. This selection
              // is discovery, not a snapshot pinned across the subsequent read.
              const selection = await queryAll({ ...criteria, select: ["file.path"], includeBody: false }, { ...requestOptions, pageSize: selected.length });
              if (!selection.ok) { failBatch(batch, selected, selection); continue; }
              const matches = new Set(selection.value.results.map(record => record.path));
              targets = selected.filter(path => matches.has(path));
              diagnostics = selection.diagnostics;
              // Selection can change the route. Reuse the real legacy query
              // only on fresh unsupported evidence, never on selection errors.
              const current = await supports!("read-many-documents-v1", requestOptions);
              if (!current.ok) throw new MdbaseConnectError(current.problem);
              documents = current.value;
            }
            if (!documents) {
              const outcome = await queryAll({
                ...criteria,
                ...(options.includeBody === undefined ? {} : { includeBody: options.includeBody }),
                ...(options.frontmatterMode ? { frontmatterMode: options.frontmatterMode } : {})
              }, { ...requestOptions, pageSize: selected.length });
              if (!outcome.ok) { failBatch(batch, selected, outcome); continue; }
              batchDiagnostics[batch] = outcome.diagnostics;
              const records = new Map(outcome.value.results.map(record => [record.path, record]));
              for (const path of selected) {
                const record = records.get(path);
                entries.set(path, record ? { status: "found", path, record } : { status: "missing", path });
              }
              continue;
            }
            if (budget.signal.aborted) return;
            const outcome = targets.length
              ? await readDocuments(targets, options.includeBody ?? false, requestOptions)
              : connectSuccess<ReadManyDocumentsResult<Frontmatter>>({ items: [] });
            if (!outcome.ok) { failBatch(batch, selected, outcome); continue; }
            // Parse the entire batch before installing any result: malformed or
            // incoherently bound data never becomes successful partial/missing data.
            const parsed = documentEntries(outcome.value, targets, batch, options);
            for (const path of selected) entries.set(path, parsed.entries.get(path) ?? { status: "missing", path });
            batchDiagnostics[batch] = [...diagnostics, ...outcome.diagnostics];
            if (parsed.errors.length) errors.push({
              batch, paths: parsed.errors.map(error => error.path!),
              failure: connectFailure(connectProblem("operation_invalid", "Some batch records could not be read.", { details: { diagnostics: parsed.errors } }))
            });
          } catch (error) {
            if (!(error instanceof MdbaseConnectError)) throw error;
            const failure = await captureConnectOutcome<never, CollectionQueryProblemCode>(async () => { throw error; }, COLLECTION_QUERY_PROBLEM_CODES);
            failBatch(batch, selected, failure as ConnectFailure<CollectionQueryProblemCode>);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, worker));
      return connectSuccess({ results: inputs.map(path => entries.get(path)!), errors: errors.sort((a, b) => a.batch - b.batch) }, batchDiagnostics.flat());
    });
  } catch (error) {
    if (error instanceof MdbaseConnectError) return captureConnectOutcome<never, CollectionQueryProblemCode>(async () => { throw error; }, COLLECTION_QUERY_PROBLEM_CODES);
    throw error;
  }
}

function documentEntries<Frontmatter extends JsonObject>(value: ReadManyDocumentsResult<Frontmatter>, paths: string[], batch: number, options: ReadManyOptions) {
  if (!value || !Array.isArray(value.items) || value.items.length !== paths.length) invalidResponse();
  const entries = new Map<string, ReadManyEntry<Frontmatter>>();
  const errors: MdbaseDiagnostic[] = [];
  value.items.forEach((item, index) => {
    if (!item || item.path !== paths[index]) invalidResponse();
    switch (item.status) {
      case "found": entries.set(item.path, { status: "found", path: item.path, record: documentRecord(item.record, item.path, options) }); break;
      case "missing": entries.set(item.path, { status: "missing", path: item.path }); break;
      case "error":
        if (!item.error || typeof item.error.code !== "string" || typeof item.error.message !== "string") invalidResponse();
        entries.set(item.path, { status: "error", path: item.path, batch });
        errors.push({ severity: "error", code: item.error.code, message: item.error.message, path: item.path });
        break;
      default: invalidResponse();
    }
  });
  return { entries, errors };
}

function documentRecord<Frontmatter extends JsonObject>(record: RecordDocument<Frontmatter>, path: string, options: ReadManyOptions): ReadManyRecord<Frontmatter> {
  if (!record || record.path !== path || typeof record.revision !== "string" || !record.revision
      || !Array.isArray(record.types) || record.types.some(type => typeof type !== "string")
      || !object(record.frontmatter) || !object(record.effective_frontmatter) || !object(record.file)
      || ((options.includeBody ?? false) && typeof record.body !== "string") || record.contract !== undefined) invalidResponse();
  const mode = options.frontmatterMode ?? "effective";
  return {
    path: record.path, revision: record.revision, types: record.types, file: record.file,
    ...(mode !== "effective" ? { frontmatter: record.frontmatter } : {}),
    ...(mode !== "persisted" ? { effectiveFrontmatter: record.effective_frontmatter } : {}),
    ...(options.includeBody ? { body: record.body } : {})
  };
}
function object(value: unknown): boolean { return !!value && typeof value === "object" && !Array.isArray(value); }
function invalidResponse(): never { throw connectError("invalid_operation_response", "The authority returned an invalid or incoherently bound document batch."); }
function boundedInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) throw new TypeError(`${name} must be an integer between 1 and ${max}.`);
  return value;
}
