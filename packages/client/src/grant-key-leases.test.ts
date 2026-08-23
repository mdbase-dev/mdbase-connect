import { expect, it, vi } from "vitest";
import { GrantKeyLeaseSet } from "./grant-key-leases.js";

const collectionId = "00000000-0000-0000-0000-000000000002";

it("releases earlier leases when a later acquisition fails so deletion proceeds", async () => {
  let oldKeyPresent = true;
  let oldKeyLeased = false;
  let deletionPending = false;
  const deleteOld = vi.fn(() => {
    if (oldKeyLeased) deletionPending = true;
    else oldKeyPresent = false;
  });
  const leases = new GrantKeyLeaseSet(collectionId, async (_collection, handle) => {
    if (handle === "rejected-key") throw new Error("acquisition rejected");
    oldKeyLeased = true;
    return () => {
      oldKeyLeased = false;
      if (deletionPending) oldKeyPresent = false;
    };
  });

  await leases.retain("old-key");
  deleteOld();
  await expect(leases.retain("rejected-key")).rejects.toThrow("acquisition rejected");

  expect(deleteOld).toHaveBeenCalledOnce();
  expect(oldKeyLeased).toBe(false);
  expect(oldKeyPresent).toBe(false);
});
