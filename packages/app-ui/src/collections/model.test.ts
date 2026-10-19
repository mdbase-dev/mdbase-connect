import type { MdbasePhase, MdbaseSnapshot } from "@mdbase-dev/sdk";
import { describeError } from "@mdbase-dev/sdk/describe";
import { describe, expect, it } from "vitest";

import { collectionView, problemControl } from "./model.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";

function snapshot(phase: MdbasePhase, extra: Partial<MdbaseSnapshot> = {}): MdbaseSnapshot {
  return {
    status: "unselected",
    signIn: { state: "paired", accountEmail: "ada@example.com" } as MdbaseSnapshot["signIn"],
    collections: [
      { collectionId: A, displayName: "[test] Field notes from the long expedition", role: "owner" },
      { collectionId: B, displayName: "Recipes", role: "viewer", availability: { state: "unavailable", reason: "device_offline" } },
    ],
    selectedCollectionId: null,
    problem: null,
    timing: null,
    readiness: { checking: false, assessment: null, problem: null, facets: {} as never },
    selection: { state: "none", problem: null, usable: null, requested: { collectionId: null, source: "none", displayName: null, approved: false } },
    phase,
    sync: null,
    links: { account: "https://connect.example/account", manageAccess: "https://connect.example/account/applications" },
    ...extra,
  } as MdbaseSnapshot;
}

const app = { appName: "TaskNotes" };

describe("collectionView", () => {
  it.each([
    ["joining", "Connecting your collection…"], ["opening_store", "Opening the local collection…"],
    ["connecting_log", "Connecting to sync…"], ["syncing", "Syncing your collection…"],
    ["loading_snapshot", "Loading the collection snapshot…"], ["replaying", "Applying collection updates…"],
    ["waiting_for_key", "Waiting for the collection key…"], ["verifying_read", "Checking the collection is readable…"],
    ["checking_setup", "Checking collection setup…"],
  ])("shows only truthful fixed progress copy for %s, including slow opens", (progress, lead) => {
    const phase = {kind: "opening" as const, collectionId: A, displayName: "Notes", slow: true, progress};
    expect(collectionView(snapshot(phase), app)).toMatchObject({kind: "opening", lead, slow: true});
  });
  it("keeps the older-SDK fallback and never renders unknown progress text", () => {
    for (const progress of [undefined, "private document name", "__proto__", "constructor"]) {
      const phase = {kind: "opening" as const, collectionId: A, displayName: "Notes", slow: true, progress};
      expect(collectionView(snapshot(phase), app).lead).toBe("This is taking longer than usual.");
      expect(collectionView(snapshot({...phase, slow: false}), app).lead).toBeNull();
    }
  });
  it("names the blocked collection in the heading, puts its fix inside the problem, and lists it once as current", () => {
    const problem = describeError("collection_migrating")!;
    const view = collectionView(snapshot({ kind: "problem", collectionId: A, problem: { ...problem, transient: false } }, { status: "blocked", selectedCollectionId: A }), app);

    expect(view.kind).toBe("problem");
    expect(view.heading).toBe("Can't open [test] Field notes from the long expedition");
    if (view.kind !== "problem") throw new Error("unreachable");
    expect(view.notice.title).toBe(problem.title);
    expect(view.notice.message).toBe(problem.message);
    expect(view.collections.filter((row) => row.id === A)).toEqual([expect.objectContaining({ current: true, name: "[test] Field notes from the long expedition" })]);
    expect(view.collections[0]?.id).toBe(A);
    expect(view.canChooseAnother).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/Welcome back|in this build|developer/i);
  });

  it("maps sign-in, choosing, empty and declined-add states to their own headings", () => {
    expect(collectionView(snapshot({ kind: "signed_out", notice: null }, { signIn: null, collections: [] }), app))
      .toMatchObject({ heading: "Open your collections in TaskNotes", signedIn: false, account: null });
    expect(collectionView(snapshot({ kind: "choosing", lastApproval: null }), app))
      .toMatchObject({ heading: "Choose a collection", account: "ada@example.com", lead: null });
    expect(collectionView(snapshot({ kind: "choosing", lastApproval: { kind: "add", outcome: "closed", collectionId: null } }, { collections: [] }), app))
      .toMatchObject({ heading: "Give TaskNotes a collection", notice: { message: "No collection was added." } });
    expect(collectionView(snapshot({ kind: "authorizing", purpose: "approve", collectionId: B }), app))
      .toMatchObject({ heading: "Continue in the mdbase window", lead: "Review access to Recipes there." });
  });

  it("describes availability, roles and same-named collections in the rows", () => {
    const view = collectionView(snapshot({ kind: "choosing", lastApproval: null }, {
      collections: [
        { collectionId: B, displayName: "Notes", role: "editor" },
        { collectionId: C, displayName: "Notes", role: "viewer", availability: { state: "unavailable", reason: "device_offline" } },
      ],
    }), app);
    expect(view.collections.map((row) => [row.roleLabel, row.disambiguator, row.available])).toEqual([
      ["Can edit", "ID 22222222", true],
      ["Can view", "ID 33333333", false],
    ]);
    expect(view.collections[1]?.status).toBe(describeError({ state: "unavailable", reason: "device_offline" })?.title);
  });
});

describe("problemControl", () => {
  const signedInOpen = { collectionId: A, signedIn: true, open: true };
  it("gives every SDK action one control or none", () => {
    const of = (action: string, updateUrl: string | null = null, context = signedInOpen) =>
      problemControl({ action: action as never, actionLabel: "Go", updateUrl }, context)?.kind ?? null;
    expect(of("sign_in")).toBe("sign_in");
    expect(of("approve")).toBe("approve");
    expect(of("choose_collection")).toBe("choose_another");
    expect(of("choose_collection", null, { ...signedInOpen, signedIn: false })).toBeNull();
    expect(of("update_app", "https://mdbase.dev/download")).toBe("link");
    expect(of("retry")).toBe("assess");
    expect(of("retry", null, { collectionId: null, signedIn: true, open: false })).toBe("start");
    expect(of("reload")).toBe("reload");
    expect(of("wait")).toBeNull();
    expect(of("none")).toBeNull();
  });
});
