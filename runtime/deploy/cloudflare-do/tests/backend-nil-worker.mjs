// Local synthetic namespace capabilities only; never a deployed/public route.
import Ordinary, { LogCollection as Native } from "../build/worker/shim.mjs";
export class Bound extends Native {}
// Same native constructor sees LOG, but this physical actor belongs to OTHER.
export class Misbound extends Native {}
const NIL = "00000000-0000-0000-0000-000000000000";
export default {
  async fetch(req, env) {
    if (new URL(req.url).pathname === "/health") return new Response("local fixture");
    const q = await req.json();
    if (q.public) {
      const r = await new Ordinary({}, env).fetch(new Request(`https://test/registry/collection-deletion?c=${NIL}&target=${q.target}`));
      return Response.json({ status: r.status });
    }
    const ns = q.other ? env.OTHER : env.LOG;
    const stub = ns.get(ns.idFromName(q.actor));
    try {
      const r = await stub.fetch(`https://do/registry/collection-deletion?c=${NIL}&target=${q.target}`);
      // Bounded synthetic reply only. The real backend retains its mandatory
      // <=1024B BYOB/CBOR parser, this test isn't a replacement for that parser.
      const raw = new Uint8Array(await r.arrayBuffer());
      return Response.json({ status: r.status, bytes: r.status === 200 ? [...raw] : [] });
    } catch { return Response.json({ refused: true }); }
  },
};
