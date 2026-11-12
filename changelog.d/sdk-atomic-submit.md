## Breaking

- SDK: `client.submit(ops, options)` resolves one `Write`, not an array: the operations are one mutation and apply together or not at all. Replace `const [write] = await client.submit(ops)` with `const write = await client.submit(ops)`. The `allowPartial` option is removed, and with it `MdbaseError.mutationIds`; `error.mutationId` names the one mutation of a failed write.
