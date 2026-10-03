import { MdbaseConnectError, MdbaseQueryObserver, type ObserveOptions, type QueryPage, type CollectionChange } from "@mdbase-dev/connect";
import { connectFailure, connectProblem, connectSuccess, type MdbaseCollectionClient } from "@mdbase-dev/connect/advanced";
import type { CollectionGateway, NoteFrontmatter, NoteSummary, NoteIndexRequest, NoteContentRequest, NoteIndexResult } from "./model";

/** Demo provider adapter only; production uses connection.observe directly. */
export function observeDemo(source: CollectionGateway & {
  list(options?: NoteIndexRequest): Promise<NoteIndexResult>;
  hydrateContent(options?: NoteContentRequest): Promise<NoteIndexResult>;
  watch(onChange: (change?: CollectionChange) => void, signal: AbortSignal, onStatus?: (status: import("@mdbase-dev/connect").WatchStatus) => void): Promise<void>;
}, options: ObserveOptions = {}) {
  type Client = MdbaseCollectionClient<NoteFrontmatter>;
  const client: Pick<Client, "queryPages" | "queryAll" | "readMany" | "changes" | "watch"> = {
    changes: async () => connectSuccess({ cursor: 0, reset: false, hasMore: false, events: [] }),
    queryPages: (async function* (input: { includeBody?: boolean }, request: { signal?: AbortSignal } = {}) {
      const queue: QueryPage<NoteFrontmatter>[] = [];
      let wake = () => {}, settled = false, completeSeen = false, error: unknown, loaded = 0, page = 0;
      const accept = (notes: NoteSummary[], complete: boolean, total?: number) => {
        queue.push({ results: notes.slice(loaded), offset: loaded, loaded: notes.length, page: page++, complete, meta: { hasMore: !complete, totalCount: total } });
        loaded = notes.length; completeSeen = complete; wake();
      };
      const load = input.includeBody ? source.hydrateContent.bind(source) : source.list.bind(source);
      void load({ signal: request.signal, onProgress: progress => accept(progress.notes, progress.complete, progress.total) }).then(result => {
        if (!completeSeen) accept(result.notes, true);
      }).catch(value => { error = value; }).finally(() => { settled = true; wake(); });
      while (!settled || queue.length) {
        if (queue.length) yield connectSuccess(queue.shift()!);
        else await new Promise<void>(resolve => { wake = resolve; });
      }
      if (error) throw error;
    }) as Client["queryPages"],
    queryAll: (async (input: { where?: string }) => {
      // Only the editor's all-record query is used by this demo provider.
      const paths = JSON.parse(input.where!.match(/file.path in (\[.*\])/)![1]) as string[];
      const results: NoteSummary[] = [];
      for (const path of paths) {
        try { results.push(await source.read(path)); }
        catch (error) { if (!(error instanceof Error) || error.message !== "This note no longer exists.") throw error; }
      }
      return connectSuccess({ results });
    }) as Client["queryAll"],
    readMany: async paths => {
      const results = await Promise.all(paths.map(async path => ({ status: "found" as const, path, record: await source.read(path) })));
      return connectSuccess({ results, errors: [] });
    },
    watch: async function* (request = {}) {
      const queue: Array<ReturnType<typeof connectSuccess<CollectionChange>> | ReturnType<typeof connectFailure>> = [];
      let wake = () => {}, settled = false;
      void source.watch(change => {
        if (change) queue.push(connectSuccess(change));
        wake();
      }, request.signal!, status => {
        request.onStatus?.(status);
        if (status.state === "reset_required") { queue.push(connectFailure(status.problem)); wake(); }
      }).catch(error => {
        queue.push(connectFailure(error instanceof MdbaseConnectError ? error.problem : connectProblem("operation_failed", String(error))));
      }).finally(() => { settled = true; wake(); });
      while (!request.signal?.aborted && (!settled || queue.length)) {
        if (queue.length) yield queue.shift()!;
        else await new Promise<void>(resolve => { wake = resolve; });
      }
    } as Client["watch"]
  };
  return new MdbaseQueryObserver(client, { frontmatterMode: "both" }, options);
}
