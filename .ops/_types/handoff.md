---
name: handoff
strict: true
fields:
  id:
    type: string
    required: true
    unique: true
  item_id:
    type: string
    required: true
  for_agent:
    type: string
    required: true
  status:
    type: enum
    values: [open, acknowledged, completed, closed]
    default: open
  next_step:
    type: string
  created_by:
    type: string
  created_at:
    type: datetime
---

# Handoff

Handoffs route work between agents or people.

Keep detailed context, blockers, and open questions in the body.
