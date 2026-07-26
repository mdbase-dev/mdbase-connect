import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import { createDatabase } from "./db.js";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (resources.length) await resources.pop()?.();
});

describe("authoritative connector inventory", () => {
  it("retires omitted collections, ignores stale snapshots, and resolves duplicate authorities explicitly", async () => {
    const db = await createDatabase("memory");
    resources.push(() => db.end());
    const { app } = await buildApp({
      db,
      devAuth: true,
      publicUrl: "http://connect.test"
    });
    resources.push(() => app.close());
    const session = await app.inject({
      method: "POST",
      url: "/v1/dev/session",
      payload: { name: "Owner", email: "inventory@example.test" }
    });
    const setCookie = session.headers["set-cookie"]!;
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0];
    const first = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "First computer" }
    })).json();
    const second = (await app.inject({
      method: "POST",
      url: "/v1/connectors",
      headers: { cookie },
      payload: { name: "Second computer" }
    })).json();
    const sharedId = "125cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";
    const omittedId = "225cc8cf-dad5-4fc9-b0bc-a1c92e99f3ed";

    const firstSnapshot = await sync(app, first.token, 1, [
      collection(sharedId, "Shared"),
      collection(omittedId, "Temporary")
    ]);
    expect(firstSnapshot.statusCode).toBe(200);
    expect(firstSnapshot.json().accepted).toBe(true);
    const omittedServerId = firstSnapshot.json().collections[1].id as string;

    const secondSnapshot = await sync(app, second.token, 1, [
      collection(sharedId, "Shared copy")
    ]);
    expect(secondSnapshot.json().collections[0]).toMatchObject({
      authority_state: "candidate",
      authority_epoch: 1
    });
    const secondControl = await app.inject({
      method: "GET",
      url: "/v1/connectors/control",
      headers: { authorization: `Bearer ${second.token}` }
    });
    expect(secondControl.json().authority_conflicts).toEqual([
      {
        collection_id: sharedId,
        display_name: "Shared copy",
        active_connector_name: "First computer"
      }
    ]);

    const reduced = await sync(app, first.token, 2, [
      collection(sharedId, "Shared")
    ]);
    expect(reduced.json().accepted).toBe(true);
    const retired = await db.query<{
      present: boolean;
      enabled: boolean;
      authority_state: string;
    }>(
      "SELECT present, enabled, authority_state FROM collections WHERE id = $1",
      [omittedServerId]
    );
    expect(retired.rows[0]).toEqual({
      present: false,
      enabled: false,
      authority_state: "retired"
    });

    const stale = await sync(app, first.token, 1, [
      collection(sharedId, "Stale"),
      collection(omittedId, "Must not return")
    ]);
    expect(stale.json()).toMatchObject({
      accepted: false,
      inventory_revision: 2,
      collections: []
    });
    expect(Number((await db.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM collections
       WHERE connector_id = $1 AND local_id = $2 AND present = true`,
      [first.connector.id, omittedId]
    )).rows[0].count)).toBe(0);

    const moved = await app.inject({
      method: "POST",
      url: `/v1/connectors/authority-conflicts/${sharedId}/move`,
      headers: { authorization: `Bearer ${second.token}` }
    });
    expect(moved.statusCode).toBe(200);
    const authorities = await db.query<{
      connector_id: string;
      authority_state: string;
      authority_epoch: string | number;
      enabled: boolean;
    }>(
      `SELECT connector_id, authority_state, authority_epoch, enabled
       FROM collections WHERE local_id = $1 ORDER BY connector_id`,
      [sharedId]
    );
    expect(authorities.rows).toContainEqual(expect.objectContaining({
      connector_id: second.connector.id,
      authority_state: "active",
      authority_epoch: 2,
      enabled: true
    }));
    expect(authorities.rows).toContainEqual(expect.objectContaining({
      connector_id: first.connector.id,
      authority_state: "retired",
      authority_epoch: 2,
      enabled: false
    }));
    expect(authorities.rows.filter((row) => row.authority_state === "active")).toHaveLength(1);
  });
});

function collection(id: string, displayName: string) {
  return {
    id,
    display_name: displayName,
    spec_version: "0.3.0",
    enabled: true,
    contracts: []
  };
}

function sync(
  app: Awaited<ReturnType<typeof buildApp>>["app"],
  token: string,
  inventoryRevision: number,
  collections: ReturnType<typeof collection>[]
) {
  return app.inject({
    method: "POST",
    url: "/v1/connectors/sync",
    headers: { authorization: `Bearer ${token}` },
    payload: {
      inventory_revision: inventoryRevision,
      collections
    }
  });
}
