import type { JsonObject } from "@mdbase-dev/connect-protocol";

export const STARTER_COLLECTION_NAME = "Welcome to mdbase";
export const STARTER_TEMPLATE_VERSION = "starter-v1";

export interface StarterRecord {
  record_id: string;
  path: string;
  document: string;
  frontmatter: JsonObject;
  body: string;
  types: string[];
}

export function starterCollectionRecords(): StarterRecord[] {
  return [
    starterRecord(
      "019c0000-0000-7000-8000-000000000001",
      "Start here.md",
      `# Welcome to mdbase

This is your first hosted collection. It is private to your account until you explicitly give an app access.

## Try the editor

1. Change a sentence in this note and save it.
2. Create a new note of your own.
3. Move between notes using the collection list.

Everything here is ordinary Markdown. The editor is one view of the collection, not the place your data is locked away.

## When you are ready

- Read [[How collections work]].
- Open [[Build with mdbase]] when you want to connect another app or build one of your own.
`
    ),
    starterRecord(
      "019c0000-0000-7000-8000-000000000002",
      "How collections work.md",
      `# How collections work

A collection is a set of Markdown records with one authority. This starter collection is hosted by mdbase connect, so it is available wherever you sign in.

Apps never receive access just because you have an account. When an app asks to connect, mdbase shows you the collection and permissions it wants. You approve that grant explicitly and can revoke it later.

You can also mirror a hosted collection to a local folder with the desktop connector. The Markdown stays useful with or without a particular app.
`
    ),
    starterRecord(
      "019c0000-0000-7000-8000-000000000003",
      "Build with mdbase.md",
      `# Build with mdbase

The editor is your first mdbase app. It gives you a simple place to learn the model before you connect anything else.

From here you can:

- [install the desktop connector](https://mdbase.dev/downloads/) to mirror a collection to a folder;
- authorize another mdbase app for only the collection and permissions it needs; or
- [read the developer documentation](https://mdbase.dev/docs/) and build an app against mdbase connect.

Keep this collection, rename it, or delete it when it has done its job. Deleting it will not make another starter collection appear.
`
    )
  ];
}

function starterRecord(recordId: string, path: string, body: string): StarterRecord {
  return {
    record_id: recordId,
    path,
    document: body,
    frontmatter: {},
    body,
    types: []
  };
}
