import { describe, expect, it, vi } from "vitest";
import { HOST_DESCRIPTOR_STALE_MS, HOST_HEARTBEAT_MS, leaseName, parseHostDescriptor, tryAcquireFolderLease, tryAcquireLease } from "../src/index/lease.js";

// Minimal LockManager with ifAvailable semantics.
class FakeLocks {
  held = new Set<string>();
  async request(name: string, opts: { ifAvailable?: boolean }, cb: (l: { name: string } | null) => Promise<void> | undefined) {
    if (this.held.has(name)) return cb(null);
    this.held.add(name);
    try {
      return await cb({ name });
    } finally {
      this.held.delete(name);
    }
  }
}

describe("collection lease (Web Lock)", () => {
  it("one holder per collection; released on release()", async () => {
    const locks = new FakeLocks() as unknown as LockManager;
    const id = "0F8E3C3A-7D2B-4C55-9D7E-0B6F3D2A1C11";
    const a = await tryAcquireLease(id, locks);
    expect(a?.name).toBe(leaseName(id));
    expect(await tryAcquireLease(id.toLowerCase(), locks)).toBeNull();
    expect(await tryAcquireLease("11111111-7d2b-4c55-9d7e-0b6f3d2a1c11", locks)).not.toBeNull();
    a!.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(await tryAcquireLease(id, locks)).not.toBeNull();
  });
});

describe("folder lease (Web Lock + folder host descriptor)", () => {
  const ID = "0f8e3c3a-7d2b-4c55-9d7e-0b6f3d2a1c11";
  class MemIo {
    text: string | null = null;
    async read() {
      return this.text;
    }
    async write(t: string) {
      this.text = t;
    }
    async remove() {
      this.text = null;
    }
  }
  const timers = () => {
    const fns: (() => void)[] = [];
    return {
      setInterval: (f: () => void) => (fns.push(f), fns.length - 1),
      clearInterval: (h: unknown) => (fns[h as number] = () => {}),
      tick: async () => {
        for (const f of fns) f();
        await new Promise((r) => setTimeout(r, 0));
      },
    };
  };
  const daemonDesc = (t: number, pid = 4242) => JSON.stringify({ host: "daemon", pid, since_ms: t, heartbeat_ms: t });

  it("publishes an obsidian descriptor the daemon reads, heartbeats it, removes it on release", async () => {
    const io = new MemIo();
    let now = 1_000_000;
    const t = timers();
    const r = await tryAcquireFolderLease(ID, io, { locks: new FakeLocks() as unknown as LockManager, now: () => now, instance: "obsidian-a", ...t });
    expect("lease" in r).toBe(true);
    const d = parseHostDescriptor(io.text);
    expect(d).toMatchObject({ kind: "present", d: { host: "obsidian", device: "obsidian-a", heartbeat_ms: 1_000_000 } });
    now += HOST_HEARTBEAT_MS;
    await t.tick();
    expect(parseHostDescriptor(io.text)).toMatchObject({ kind: "present", d: { heartbeat_ms: 1_015_000 } });
    if ("lease" in r) r.lease.release();
    await new Promise((r) => setTimeout(r, 0));
    expect(io.text).toBeNull();
  });

  it("refuses while the daemon is live; takes over a dead host's descriptor", async () => {
    const now = 5_000_000;
    const locks = new FakeLocks() as unknown as LockManager;
    const io = new MemIo();
    io.text = daemonDesc(now - 1_000);
    expect(await tryAcquireFolderLease(ID, io, { locks, now: () => now })).toEqual({ refused: "hosted_by_daemon" });
    // A pid check, where available, decides for the OS-lock hosts.
    io.text = daemonDesc(now - HOST_DESCRIPTOR_STALE_MS - 1);
    expect(await tryAcquireFolderLease(ID, io, { locks, now: () => now, pidAlive: () => true })).toEqual({ refused: "hosted_by_daemon" });
    // The library does not heartbeat: live unless its process is known dead.
    io.text = JSON.stringify({ host: "library", pid: 7, since_ms: 1, heartbeat_ms: 1 });
    expect(await tryAcquireFolderLease(ID, io, { locks, now: () => now })).toEqual({ refused: "hosted_elsewhere" });
    // Another Obsidian (another profile) that is fresh holds it too.
    io.text = JSON.stringify({ host: "obsidian", device: "obsidian-b", since_ms: now, heartbeat_ms: now });
    expect(await tryAcquireFolderLease(ID, io, { locks, now: () => now })).toEqual({ refused: "hosted_elsewhere" });
    // Fail closed on a descriptor that cannot be read.
    io.text = "{nope";
    expect(await tryAcquireFolderLease(ID, io, { locks, now: () => now })).toEqual({ refused: "descriptor_unreadable" });
    // A dead daemon's descriptor (stale, no pid check) is taken over.
    io.text = daemonDesc(now - HOST_DESCRIPTOR_STALE_MS - 1);
    const r = await tryAcquireFolderLease(ID, io, { locks, now: () => now, instance: "obsidian-a", ...timers() });
    expect("lease" in r).toBe(true);
    expect(parseHostDescriptor(io.text)).toMatchObject({ kind: "present", d: { host: "obsidian" } });
  });

  it("releases the Web Lock if initial publication or timer setup throws", async () => {
    for (const failure of ["publish", "timer"] as const) {
      const locks = new FakeLocks(), io = new MemIo();
      if (failure === "publish") vi.spyOn(io, "write").mockRejectedValueOnce(new Error("write failed"));
      await expect(tryAcquireFolderLease(ID, io, {
        locks: locks as unknown as LockManager, instance: "owned", now: () => 1000,
        setInterval: () => { throw new Error("timer failed"); },
      })).rejects.toThrow(`${failure === "publish" ? "write" : "timer"} failed`);
      await Promise.resolve();
      expect(locks.held.has(leaseName(ID))).toBe(false);
    }
  });

  it("fails closed on heartbeat write failure, fencing all consumers once", async () => {
    const locks = new FakeLocks(), io = new MemIo(), t = timers();
    const r = await tryAcquireFolderLease(ID, io, { locks: locks as unknown as LockManager, instance: "owned", ...t });
    if (!("lease" in r)) throw Error("refused");
    const writes = vi.spyOn(io, "write").mockRejectedValue(new Error("write failed"));
    const fenced = vi.fn();
    r.lease.onLost(() => { throw Error("broken consumer"); });
    r.lease.onLost(fenced);
    await t.tick();
    expect(fenced).toHaveBeenCalledExactlyOnceWith("descriptor_unreadable");
    expect(locks.held.has(leaseName(ID))).toBe(false);
    await t.tick();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(fenced).toHaveBeenCalledTimes(1);
    const late = vi.fn(); r.lease.onLost(late); r.lease.onLost(late);
    expect(late).toHaveBeenCalledExactlyOnceWith("descriptor_unreadable");
  });

  it.each(["read error", "missing descriptor"])("fails closed on %s without republishing", async failure => {
    const locks = new FakeLocks(), io = new MemIo(), t = timers();
    const r = await tryAcquireFolderLease(ID, io, { locks: locks as unknown as LockManager, instance: "owned", ...t });
    if (!("lease" in r)) throw Error("refused");
    const writes = vi.spyOn(io, "write"), lost = vi.fn(); r.lease.onLost(lost);
    if (failure === "read error") vi.spyOn(io, "read").mockRejectedValue(new Error("read failed"));
    else io.text = null;
    await t.tick();
    expect(lost).toHaveBeenCalledExactlyOnceWith("descriptor_unreadable");
    expect(writes).not.toHaveBeenCalled();
    expect(locks.held.has(leaseName(ID))).toBe(false);
  });

  it("serializes slow heartbeat publication", async () => {
    const io = new MemIo(), t = timers();
    const r = await tryAcquireFolderLease(ID, io, { locks: new FakeLocks() as unknown as LockManager, instance: "owned", ...t });
    if (!("lease" in r)) throw Error("refused");
    let finish!: () => void;
    const writes = vi.spyOn(io, "write").mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await t.tick(); await t.tick();
    expect(writes).toHaveBeenCalledTimes(1);
    finish(); await Promise.resolve(); r.lease.release();
  });

  it("drains publication before release cleanup and unlock", async () => {
    const locks = new FakeLocks(), io = new MemIo(), t = timers();
    const r = await tryAcquireFolderLease(ID, io, { locks: locks as unknown as LockManager, instance: "owned", ...t });
    if (!("lease" in r)) throw Error("refused");
    let finish!: () => void;
    const writes = vi.spyOn(io, "write").mockImplementation(async text => {
      await new Promise<void>(resolve => { finish = resolve; });
      io.text = text;
    });
    const cleanup = vi.spyOn(io, "remove");
    await t.tick();
    r.lease.release();await t.tick();
    expect(writes).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    expect(locks.held.has(leaseName(ID))).toBe(true);
    finish();
    await vi.waitFor(() => expect(locks.held.has(leaseName(ID))).toBe(false));
    expect(cleanup).toHaveBeenCalledTimes(1);expect(io.text).toBeNull();
    await t.tick();expect(writes).toHaveBeenCalledTimes(1);
  });

  it("yields at the next heartbeat when the daemon re-asserts its descriptor, and frees the Web Lock", async () => {
    const now = 9_000_000;
    const locks = new FakeLocks() as unknown as LockManager;
    const io = new MemIo();
    const t = timers();
    const r = await tryAcquireFolderLease(ID, io, { locks, now: () => now, instance: "obsidian-a", ...t });
    if (!("lease" in r)) throw new Error("refused");
    const lost: string[] = [];
    r.lease.onLost((why) => lost.push(why));
    io.text = daemonDesc(now);
    await t.tick();
    expect(lost).toEqual(["hosted_by_daemon"]);
    expect(parseHostDescriptor(io.text)).toMatchObject({ kind: "present", d: { host: "daemon" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(await tryAcquireLease(ID, locks)).not.toBeNull();
  });
});
