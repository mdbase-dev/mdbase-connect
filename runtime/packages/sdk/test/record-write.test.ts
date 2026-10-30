import { describe, expect, it } from "vitest";
import { connect, Write, type Connector, type FramePort, type RecordWrite } from "../src/index.js";
import { MemoryReplica } from "../src/testing/index.js";
import { clientFrame } from "../src/wire.js";
import type { CborValue } from "../src/cbor.js";

/** A valid producer response need not contain optimistic record views. */
function withoutRecords(replica: MemoryReplica): Connector {
  const base = replica.connector();
  return {description:base.description, async open(hello, signal) {
    const opened = await base.open(hello, signal), requests = new Set<number>();
    const port: FramePort = {onframe:null,onclose:null,close:() => opened.port.close(),send:frame => {
      const request = clientFrame.dec(frame);
      if (request.kind === "request" && request.method === "submit") requests.add(request.id);
      opened.port.send(frame);
    }};
    opened.port.onframe = frame => {
      const reply = clientFrame.dec(frame);
      if (reply.kind === "response" && requests.delete(reply.id) && Array.isArray(reply.result)) {
        reply.result = reply.result.map(value => {const receipt = new Map(value as Map<number,CborValue>);receipt.delete(5);return receipt;});
        frame = clientFrame.enc(reply);
      }
      port.onframe?.(frame);
    };
    opened.port.onclose = error => port.onclose?.(error);
    return {...opened,port};
  }};
}

describe("create record identity", () => {
  it("returns explicit, minted, contract and intent IDs without optimistic records or a lookup", async () => {
    const replica = new MemoryReplica({confirmDelayMs:null, contracts:[{id:"acme.card",version:"1.0.0",type:"card",fields:{name:"title"}}]});
    const client = await connect({connector:withoutRecords(replica),app:{name:"record-write",version:"1"}});
    try {
      const explicit = "11111111-1111-4111-8111-111111111111";
      const a: RecordWrite = await client.create({id:explicit,path:"explicit.md"});
      const b = await client.create({path:"minted.md"});
      const c = await client.create({path:"contract.md",contract:{id:"acme.card",version:"1.0.0"},frontmatter:{name:"Card"}});
      const d = await client.create({path:"intent.md"},{intent:"one-draft"});
      const retry = await client.create({path:"ignored-on-retry.md"},{intent:"one-draft"});
      expect(a.recordId).toBe(explicit);expect(retry.recordId).toBe(d.recordId);
      expect(retry.mutationId).toBe(d.mutationId);
      for (const [write,path] of [[a,"explicit.md"],[b,"minted.md"],[c,"contract.md"],[d,"intent.md"]] as const) {
        expect(write).toBeInstanceOf(Write);expect(write.records).toEqual([]);
        expect(replica.allRecords.find(record => record.path === path)?.id).toBe(write.recordId);
        expect(write.state).toBe("pending");
      }
      replica.confirmAll();await Promise.all([a.confirmed,b.confirmed,c.confirmed,d.confirmed]);
      expect(a.recordId).toBe(explicit);expect(retry.recordId).toBe(d.recordId);
      expect(replica.allRecords).toHaveLength(4);
    } finally { client.close(); }
  });
});
