import type { JsonObject } from "@mdbase-dev/connect-protocol";
import { MdbaseConnectError } from "./errors.js";
import { connectFailure, connectSuccess, type CollectionQueryProblemCode, type ConnectOutcome } from "./outcomes.js";
import type { QueryAllOptions, QueryInput, QueryResult, ReadManyBatchError, ReadManyEntry, ReadManyOptions, ReadManyResult } from "./operation-types.js";
import { createRequestBudget, requestAbortReason } from "./request-budget.js";

type QueryAll<Frontmatter extends JsonObject> = (
  input: QueryInput,
  options: QueryAllOptions<Frontmatter>
) => Promise<ConnectOutcome<QueryResult<Frontmatter>, CollectionQueryProblemCode>>;

export async function queryReadMany<Frontmatter extends JsonObject>(
  queryAll: QueryAll<Frontmatter>,
  paths: readonly string[],
  options: ReadManyOptions,
  defaultTimeoutMs: number | null
): Promise<ConnectOutcome<ReadManyResult<Frontmatter>, CollectionQueryProblemCode>> {
  const batchSize = boundedInteger(options.batchSize ?? 100, 1_000, "batchSize");
  const concurrency = boundedInteger(options.concurrency ?? 4, 4, "concurrency");
  if (options.coordination?.latestWins) {
    throw new TypeError("readMany batches cannot use latestWins coordination.");
  }
  const inputs = [...paths];
  const unique = [...new Set(inputs)];
  const entries = new Map<string, ReadManyEntry<Frontmatter>>();
  const errors: ReadManyBatchError[] = [];
  const budget = createRequestBudget(options, defaultTimeoutMs);
  let nextBatch = 0;
  const batchCount = Math.ceil(unique.length / batchSize);
  const batchDiagnostics: Array<import("@mdbase-dev/connect-protocol").MdbaseDiagnostic[]> = [];
  const worker = async () => {
    while (!budget.signal.aborted && nextBatch < batchCount) {
      const batch = nextBatch++;
      const selected = unique.slice(batch * batchSize, (batch + 1) * batchSize);
      const outcome = await queryAll({
        where: `file.path in ${JSON.stringify(selected)}`,
        ...(options.types ? { types: options.types } : {}),
        ...(options.includeBody === undefined ? {} : { includeBody: options.includeBody }),
        ...(options.frontmatterMode ? { frontmatterMode: options.frontmatterMode } : {})
      }, {
        pageSize: selected.length,
        signal: budget.signal,
        timeoutMs: null,
        coordination: options.coordination
      });
      if (!outcome.ok) {
        errors.push({ batch, paths: selected, failure: outcome });
        for (const path of selected) entries.set(path, { status: "error", path, batch });
        continue;
      }
      batchDiagnostics[batch] = outcome.diagnostics;
      const records = new Map(outcome.value.results.map(record => [record.path, record]));
      for (const path of selected) {
        const record = records.get(path);
        entries.set(path, record ? { status: "found", path, record } : { status: "missing", path });
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, batchCount) }, worker));
    if (budget.signal.aborted) throw requestAbortReason(budget.signal);
    return connectSuccess({
      results: inputs.map(path => entries.get(path)!),
      errors: errors.sort((a, b) => a.batch - b.batch)
    }, batchDiagnostics.flat());
  } catch (error) {
    if (error instanceof MdbaseConnectError) return connectFailure(error.problem) as ConnectOutcome<ReadManyResult<Frontmatter>, CollectionQueryProblemCode>;
    throw error;
  } finally {
    budget.dispose();
  }
}

function boundedInteger(value: number, max: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError(`${name} must be an integer between 1 and ${max}.`);
  }
  return value;
}
