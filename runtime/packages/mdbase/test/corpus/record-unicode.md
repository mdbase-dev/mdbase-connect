---
kind: mdbase.contract
contract_type: record
id: example.unicode-note
version: 1.2.3-beta.1
name: Ünïcödé nötes — 日本語
description: Exercises JCS key ordering, escapes and number formatting.
record_schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    required: [title, "émoji 🎉", zebra, Apple, "a\"quote"]
    additionalProperties: false
    properties:
      zebra: { type: string, maxLength: 1000000 }
      Apple: { type: string }
      "émoji 🎉": { type: string, pattern: "^[a-z]+$" }
      "a\"quote": { type: string }
      title: { type: string, minLength: 1 }
      "tab\tkey": { type: string }
      ratio: { type: number, minimum: 0.1, maximum: 1.5, multipleOf: 0.05 }
      big: { type: integer, minimum: -9007199254740991, maximum: 9007199254740991 }
      tiny: { type: number, exclusiveMinimum: 0.000001 }
      huge: { type: number, maximum: 1e21 }
      "1": { type: integer }
      "10": { type: integer }
      "2": { type: integer }
      nested:
        type: object
        properties:
          deep:
            type: array
            items:
              anyOf:
                - { type: "null" }
                - { type: boolean, const: true }
                - { type: string, enum: ["b", "a", "ä", "z"] }
    $defs:
      Thing:
        type: object
        properties:
          id: { type: string }
binding_schema:
  dialect: json-schema-2020-12
  value:
    type: object
    properties:
      archive_folder: { type: string, default: "Archive/" }
      weight: { type: number, default: 2.5 }
---

A record contract with awkward keys and numbers.
