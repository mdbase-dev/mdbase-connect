# SDK: values

Every client method answers in plain JSON. A record's `frontmatter`,
`effective` and `values`, a contract's `fields`, a description's `definition`
and `schema`, presence `state` and a conflict's values are `JsonValue`; a data
map is an object. A record goes through `JSON.stringify`, `structuredClone`,
`postMessage` and a store as it is.

```ts
const record = await db.get(id);
record.frontmatter.title;                        // JsonValue
const w = await db.update(record, { patch: { status: "done" } });
(await w.confirmed).records?.[0]?.frontmatter;   // the same shape
```

Reading YAML as JSON gives up three things:

| In the file | Read as |
|---|---|
| `1.0` (a float with no fraction) | `1` |
| an integer beyond ±(2^53−1) | a decimal string |
| a map whose keys look like integers (`2024:`) | an object that lists those keys first |

None of them is written back by accident. `update(record, { patch })` drops a
patched key whose value equals what the record held, so sending a record's own
frontmatter back changes nothing, and the replica compares the values a write
was based on by value (`1` is `1.0`, key order is free). The one case it cannot
match is an integer beyond 2^53 that the app replaces: its `base` is the string
that was read, so the replica treats the field as changed elsewhere.

Writes take plain data, and the exact forms where an app wants them: `Float64`
to write `1.0`, `bigint` for a large integer, a `Map` to fix key order
(`toValue` converts, `toPlain` converts back).

For the exact form of an answer, call without a codec and decode with a
`wire` codec. Nothing is rounded or reordered on that path:

```ts
import { wire } from "@mdbase-dev/sdk";

const answer = await db.call("query", new Map([[0, new Map([["types", ["task"]]])]]), { retry: true });
const [exact] = wire.queryResult.dec(answer).records;
exact.frontmatter;   // Map<string, CborValue>, in file order, with Float64 and bigint
```

| CBOR | Plain (client methods) | Exact (`wire` codecs) |
|---|---|---|
| integer within ±(2^53−1) | `number` | `number` |
| integer beyond that | decimal `string` | `bigint` |
| float with a fractional part | `number` | `number` |
| integral float (`1.0`, `-0.0`) | `number` | `Float64` (so `1` and `1.0` stay distinct) |
| data map (text keys, order is data) | object | `Map<string, …>` |
| struct map | named-field object | named-field object (`Map<number, …>` when raw) |

The root exports the plain types (`RecordView`, `Receipt`, `QueryResult`,
`DescribeResult`, …); `wire.RecordView` and the rest are the exact ones, and
`Plain<T>` maps one to the other. Numbers that are part of an answer's
structure, such as a file's size, and byte strings such as a blob ID are the
same in both. The `details` of a problem, issue or incident are plain JSON
everywhere, including on `MdbaseError`.

In both forms UUIDs are canonical lowercase strings, hashes are `sha256:<hex>`
revision tokens, and enumerations are their snake_case names.
