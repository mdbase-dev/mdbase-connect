# SDK: problem copy in the person's language

The SDK describes every problem in plain English: a `title`, a `message` and,
where the person can act, an `actionLabel`. An app in another language passes
its own copy by problem key.

```ts
import { createMdbase, describeError } from "@mdbase-dev/sdk";

const messages = {
  access_removed: {
    title: "Accès retiré",
    message: "Demandez à nouveau l'accès à cette collection, ou choisissez-en une autre.",
    actionLabel: "Choisir une collection",
  },
};
const mdbase = createMdbase(declaration, { messages });
```

`phase.problem` and the signed-out `phase.notice` then carry that copy. The
same object goes to `describeError` for errors the app catches itself:

```ts
show(describeError(error, { messages }));
```

## The shape

- Keys are the problem codes in `PROBLEM_CODES`, plus `"unknown"` for an error
  the SDK cannot name. `description.key` is the key that was used.
- Each entry may give `title`, `message` and `actionLabel`. A field or key
  left out keeps the English copy, so a catalogue can be filled in over time.
- `actionLabel` is only used for a problem that has an action. `action` itself
  (`retry`, `sign_in`, `approve` and so on) is never translated: branch on it.

## Limits

- `createMdbase` reads `messages` once. An app that changes language while
  running describes the problem again from its code, with
  `describeError(phase.problem.code, { messages })`.
- The copy for `recovery_account_mismatch` names the account. A replacement
  `message` for that key replaces the whole sentence, so it loses the name.
