const syncModuleUrl = new URL("../../packages/sync/dist/index.js", import.meta.url);

export async function createStressSystem({ collectionId }) {
  const { MemoryAuthority } = await import(syncModuleUrl);
  let authority = new MemoryAuthority({ id: collectionId, snapshotPageSize: 17 });

  return {
    collectionId,
    async createReplica(name, mode = "read_write") {
      const id = authority.registerReplica({ name, mode, allowedTypes: [] });
      return { id, name, mode };
    },
    transportFor(replica) {
      return authority.transport(replica.id);
    },
    async compact(sequence = authority.serialize().head) {
      authority.compactThrough(sequence);
      return sequence;
    },
    async restart() {
      const serialized = authority.serialize();
      authority = MemoryAuthority.restore(serialized, { snapshotPageSize: 17 });
    },
    async revoke(replica) {
      authority.revokeReplica(replica.id);
    },
    async close() {}
  };
}
