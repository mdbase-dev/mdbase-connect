# Where your collection lives

Every mdbase collection has one **main copy**. The main copy can be hosted by mdbase or kept in a folder on your computer.

Apps work with the collection in the same way either way. The difference is where the main copy lives and what must be online for apps to reach it.

## Hosted by mdbase

For a hosted collection, mdbase keeps the main copy available for you.

- Approved apps can reach it without your computer being online.
- You can use it from the web editor and other connected apps.
- You can optionally sync its Markdown to a folder on your computer.

This starter collection is hosted by mdbase.

## On this computer

For a local collection, a folder on your computer is the main copy.

- The files remain in the folder you chose.
- Adding the folder to the desktop connector does not upload or move it.
- The connector makes the collection available to approved apps.
- Your computer and the connector must be online for apps on other devices to reach it.

This is useful when you want your own computer to remain the authority for the collection.

## A synced folder is still a hosted collection

You can sync a hosted collection to a folder on your computer. This is sometimes called a local mirror.

The folder contains ordinary Markdown, but it is not a separate collection. The hosted copy remains the main copy, and the desktop connector keeps the two in sync.

You can choose how the folder behaves:

- **Sync edits both ways** downloads hosted changes and sends local edits back to mdbase.
- **Download updates only** keeps a read-only local view of the hosted collection. Do not edit this folder; local changes are not uploaded and can prevent it from syncing.

With two-way sync, if the same record changes in two places, mdbase does not silently choose one version. The connector shows the conflict so you can decide what to keep.

A synced folder is not a backup: deletions and other changes may also be synchronized. Use your normal backup tools if you want separate history or recovery copies.

## Sync this collection to your computer

1. [Install and open the desktop connector](https://mdbase.dev/downloads/).
2. Select **Continue in browser**, then sign in and approve the computer.
3. Return to the editor. Open **Connect**, then **Storage & sync** for this collection.
4. Select **Sync a folder**. The desktop connector opens to this collection.
5. Choose a new or empty folder on your computer for this collection.
6. Choose **Sync edits both ways** or **Download updates only**.
7. Select **Start syncing**.

The connector downloads the collection and continues syncing in the background. You can open the folder with Obsidian, a text editor, command-line tools, or anything else that works with Markdown.

## Which should you choose?

Choose a collection **hosted by mdbase** when you want it to remain available without depending on one computer.

Choose a collection **on this computer** when you want a particular folder and computer to remain its main copy.

Add a **synced folder** when you want the availability of a hosted collection and the freedom of working with ordinary local files.

You are not locked into the first arrangement you choose. Moving the main copy is a separate, explicit action, so mdbase never turns two copies into competing authorities without asking you.
