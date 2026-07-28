export const PICKLE_REQUEST_CONTRACT_DOCUMENT = `---
kind: mdbase.contract
contract_type: record
id: pickle.request
version: 1.0.0
name: Pickle request
description: A portable asynchronous request that needs a human response.
record_schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    additionalProperties: true
    required: [title, response_type]
    properties:
      id: { type: string }
      title: { type: string, minLength: 1 }
      source: { type: string }
      message: { type: string }
      kind: { enum: [approval, choice, input, notice, message] }
      status: { enum: [pending, answered, cancelled] }
      priority: { enum: [low, normal, high, urgent] }
      response_type: { type: string }
      created_at: { type: string, format: date-time }
      tags:
        type: array
        items: { type: string }
      links:
        type: array
        items:
          type: object
          additionalProperties: false
          properties:
            label: { type: string }
            url: { type: string }
            path: { type: string }
      attachment_paths:
        type: array
        items: { type: string }
      metadata:
        type: object
        additionalProperties: true
---
`;

export const PICKLE_REQUEST_TYPE_DOCUMENT = `---
kind: mdbase.type
name: pickle_request
version: 1
description: Async request that needs a human response.
schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    additionalProperties: true
    required: [title, response_type]
    properties:
      type: { const: pickle_request }
      id: { type: string }
      title: { type: string, minLength: 1 }
      source: { type: string }
      message: { type: string }
      kind: { enum: [approval, choice, input, notice, message] }
      status:
        enum: [pending, answered, cancelled]
        description: Legacy lifecycle marker. Response links are authoritative for answered state.
      priority: { enum: [low, normal, high, urgent] }
      response_type: { type: string }
      created_at: { type: string, format: date-time }
      due_at: { type: string, format: date-time }
      dedupe_key: { type: string }
      tags:
        type: array
        items: { type: string }
      links:
        type: array
        items:
          type: object
          additionalProperties: false
          properties:
            label: { type: string }
            url: { type: string }
            path: { type: string }
      attachment_paths:
        type: array
        items: { type: string }
      metadata:
        type: object
        additionalProperties: true
      context:
        type: object
        additionalProperties: false
        properties:
          cwd: { type: string }
          repo: { type: string }
          task: { type: string }
collection:
  display:
    name_field: title
  unique:
    - field: id
      scope: collection
lifecycle:
  on_create:
    set:
      created_at: { now: true }
implements:
  - contract: pickle.request
    version: 1.0.0
    fields:
      id: id
      title: title
      source: source
      message: message
      kind: kind
      status: status
      priority: priority
      response_type: response_type
      created_at: created_at
      tags: tags
      links: links
      attachment_paths: attachment_paths
      metadata: metadata
---
`;

export const PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT = `---
kind: mdbase.type
name: pickle_response_approval
version: 1
description: Approve, reject, or request revision for a Pickle request.
schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    additionalProperties: true
    required: [request, decision]
    properties:
      type: { const: pickle_response_approval }
      id: { type: string }
      request: { type: string }
      decision: { enum: [approve, reject, revise] }
      comment: { type: string }
      responded_at: { type: string, format: date-time }
      responder: { type: string }
      attachment_paths:
        type: array
        items: { type: string }
collection:
  display:
    name_field: decision
  links:
    request:
      target_type: pickle_request
      validate_exists: true
  unique:
    - field: id
      scope: collection
lifecycle:
  on_create:
    set:
      id: { ulid: true }
      responded_at: { now: true }
---
`;

export const PICKLE_ACK_RESPONSE_TYPE_DOCUMENT = `---
kind: mdbase.type
name: pickle_response_ack
version: 1
description: Acknowledge that a Pickle message was read.
schema:
  dialect: json-schema-2020-12
  value:
    $schema: "https://json-schema.org/draft/2020-12/schema"
    type: object
    additionalProperties: true
    required: [request]
    properties:
      type: { const: pickle_response_ack }
      id: { type: string }
      request: { type: string }
      message: { type: string }
      responded_at: { type: string, format: date-time }
      responder: { type: string }
      attachment_paths:
        type: array
        items: { type: string }
collection:
  display:
    name_field: message
  links:
    request:
      target_type: pickle_request
      validate_exists: true
  unique:
    - field: id
      scope: collection
lifecycle:
  on_create:
    set:
      id: { ulid: true }
      responded_at: { now: true }
---
`;

export const PICKLE_TYPE_PACK_PROVISION = {
  manifest: {
    kind: "mdbase.type-pack",
    id: "pickle.requests",
    version: "1.0.0",
    name: "Pickle requests",
    description: "Pickle request and response record types.",
    resources: [
      {
        kind: "contract",
        source: "contracts/pickle.request.md",
        target: "_contracts/pickle.request.md",
        digest: "sha256:6ec14bdc2bb23d9889f0d6d72a6175a74b45713891fd87e9e05e3be9075e45b1"
      },
      {
        kind: "type",
        source: "types/pickle_request.md",
        target: "_types/pickle_request.md",
        digest: "sha256:7f84e359a5a3b7d23dd3471c7557f67cb8a80eb553184db83c4750b2af5761e4"
      },
      {
        kind: "type",
        source: "types/pickle_response_approval.md",
        target: "_types/pickle_response_approval.md",
        digest: "sha256:944d2b68c158297f5d2a035fa6ff3c81a7098531f77a9bc3342dc9435ffcb8b8"
      },
      {
        kind: "type",
        source: "types/pickle_response_ack.md",
        target: "_types/pickle_response_ack.md",
        digest: "sha256:2530c8d21bb711889f20e0d096045cb6c9a7618583b1e2afff7ada72367de41f"
      }
    ]
  },
  resources: [
    {
      source: "contracts/pickle.request.md",
      document: PICKLE_REQUEST_CONTRACT_DOCUMENT
    },
    {
      source: "types/pickle_request.md",
      document: PICKLE_REQUEST_TYPE_DOCUMENT
    },
    {
      source: "types/pickle_response_approval.md",
      document: PICKLE_APPROVAL_RESPONSE_TYPE_DOCUMENT
    },
    {
      source: "types/pickle_response_ack.md",
      document: PICKLE_ACK_RESPONSE_TYPE_DOCUMENT
    }
  ],
  provides: [{ id: "pickle.request", version: "1.0.0" }]
} as const;
