---
name: task
description: Local task record tracked in the ops registry.
display_name_key: title
strict: false

path_pattern: "tasks/{title}.md"

match:
  path_glob: "tasks/**/*.md"

fields:
  title:
    type: string
    required: true
  status:
    type: enum
    required: true
    values: [open, in_progress, blocked, done, cancelled]
    default: open
  priority:
    type: enum
    values: [low, medium, high, critical]
  owner:
    type: string
  due:
    type: date
  tags:
    type: list
    items:
      type: string
  created_at:
    type: datetime
  updated_at:
    type: datetime
---

# Task

Task records are plain markdown files under `tasks/`.

The schema is intentionally flexible so teams can add task-specific metadata
without needing to change the canonical skill each time.
