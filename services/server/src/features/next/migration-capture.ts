// Data-only inventory projection. It cannot authorize source reads or effects.
export function captureProjection<B>(name: string, current: {
  binding: B; frozenAt: string | null; inventory: [string, string[]][];
}, refuse: () => never) {
  // Bound the complete inventory BEFORE the caller reads individual views.
  if (!current.inventory.length || current.inventory.length > 850
      || current.inventory.reduce((n, [, ids]) => n + ids.length, 0) > 1000) return refuse();
  return <V extends {
    account_id: string; cohort: string | null; hosted_collections: string[]; terminal_excluded: boolean;
  }>(observations: readonly { view: V | null; record: {
    suspended: boolean; terminal_excluded_at: Date | null;
  } | undefined }[], observedAt: string) => {
    if (observations.length !== current.inventory.length) refuse();
    const members = current.inventory.map(([account, hosted], index) => {
      const { view, record } = observations[index]!;
      if (!view || !record || view.account_id !== account || view.cohort !== name
          || view.hosted_collections.join() !== hosted.join()
          || view.terminal_excluded !== (record.terminal_excluded_at !== null)) return refuse();
      // Complete membership is retained; terminal payload selection is EMPTY.
      return { view, suspended: record.suspended,
        terminal_excluded_at: record.terminal_excluded_at?.toISOString() ?? null,
        export_collections: view.terminal_excluded ? [] : [...hosted] };
    });
    const result = { schema: "mdbase-migration-capture/1" as const, binding: current.binding,
      frozen_at: current.frozenAt, observed_at: observedAt, members };
    if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024) return refuse();
    return result;
  };
}
