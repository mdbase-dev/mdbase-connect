---
kind: mdbase.type
name: task
version: 4
description: A task managed by TaskNotes.
match:
  where:
    tags:
      contains: task
schema:
  dialect: json-schema-2020-12
  value:
    $schema: https://json-schema.org/draft/2020-12/schema
    type: object
    additionalProperties: true
    properties:
      id:
        type: string
        minLength: 1
      title:
        type: string
        minLength: 1
      status:
        enum: &a2
          - none
          - open
          - in-progress
          - done
          - cancelled
        default: open
      priority:
        enum: &a4
          - none
          - low
          - normal
          - high
        default: normal
      due: &a1
        anyOf:
          - type: string
            format: date
          - type: string
            format: date-time
      scheduled: *a1
      contexts:
        type: array
        items:
          type: string
      projects:
        type: array
        items:
          type: string
      assignees:
        type: array
        items:
          type: string
          minLength: 1
          pattern: \S
        uniqueItems: true
      attachments:
        type: array
        items:
          type: string
          minLength: 1
        uniqueItems: true
      timeEstimate:
        type: integer
        minimum: 0
      completedDate:
        type: string
        format: date
      dateCreated:
        type: string
        format: date-time
      dateModified:
        type: string
        format: date-time
      recurrence:
        type: string
      recurrence_anchor:
        enum:
          - scheduled
          - completion
        default: scheduled
      occurrence_materialization:
        enum:
          - manual
          - on_completion
          - rolling
        default: manual
      occurrence_next_trigger:
        enum:
          - completion
          - completion_or_skip
        default: completion
      occurrence_template:
        type: string
      occurrence_past_horizon:
        type: string
      occurrence_future_horizon:
        type: string
      recurrence_parent:
        type: string
      occurrence_date:
        type: string
        format: date
      tags:
        type: array
        items:
          type: string
      timeEntries:
        type: array
        items:
          type: object
          additionalProperties: false
          properties:
            startTime:
              type: string
              format: date-time
            endTime:
              type: string
              format: date-time
            description:
              type: string
            duration:
              type: integer
      reminders:
        type: array
        items:
          oneOf:
            - type: object
              required:
                - id
                - type
                - absoluteTime
              additionalProperties: false
              properties:
                id:
                  type: string
                type:
                  const: absolute
                description:
                  type: string
                absoluteTime:
                  type: string
                  format: date-time
            - type: object
              required:
                - id
                - type
                - relatedTo
                - offset
              additionalProperties: false
              properties:
                id:
                  type: string
                type:
                  const: relative
                description:
                  type: string
                relatedTo:
                  enum:
                    - due
                    - scheduled
                offset:
                  type: string
      blockedBy:
        type: array
        items:
          type: object
          additionalProperties: false
          properties:
            uid:
              type: string
            reltype:
              type: string
            gap:
              type: string
          required:
            - uid
      complete_instances:
        type: array
        items:
          type: string
          format: date
      skipped_instances:
        type: array
        items:
          type: string
          format: date
      icsEventId:
        type: array
        items:
          type: string
      googleCalendarEventId:
        type: string
      googleCalendarExceptionEventId:
        type: string
      googleCalendarExceptionOriginalScheduled:
        type: string
        format: date
      googleCalendarMovedOriginalDates:
        type: array
        items:
          type: string
          format: date
      tasknotes_manual_order:
        type: string
    allOf:
      - if:
          required:
            - status
          properties:
            status:
              enum: &a3
                - done
          not:
            required:
              - recurrence
        then:
          required:
            - completedDate
    required:
      - title
      - status
      - dateCreated
collection:
  read_defaults:
    status: open
    priority: normal
    recurrence_anchor: scheduled
    occurrence_materialization: manual
    occurrence_next_trigger: completion
  links:
    projects[]:
      target_type: any
      validate_exists: false
    assignees[]:
      validate_exists: false
    attachments[]:
      validate_exists: false
    occurrence_template:
      target_type: any
      validate_exists: false
    recurrence_parent:
      target_type: task
      validate_exists: false
    blockedBy[].uid:
      target_type: task
      validate_exists: false
  path:
    runtime: tasknotes
    template: "{{zettel}}"
    folder: tasks
    generated_by: tasknotes.filename.create
  display:
    name_field: title
  unique:
    - field: id
      scope: type
lifecycle:
  on_create:
    set:
      id:
        uuid: true
      dateCreated:
        now: true
      dateModified:
        now: true
  on_update:
    set:
      dateModified:
        now: true
implements:
  - contract: tasknotes.task
    version: 0.3.0-rc.5
    fields:
      id: id
      title: title
      status: status
      priority: priority
      due: due
      scheduled: scheduled
      contexts: contexts
      projects: projects
      assignees: assignees
      attachments: attachments
      timeEstimate: timeEstimate
      completedDate: completedDate
      dateCreated: dateCreated
      dateModified: dateModified
      recurrence: recurrence
      recurrenceAnchor: recurrence_anchor
      occurrenceMaterialization: occurrence_materialization
      occurrenceNextTrigger: occurrence_next_trigger
      occurrenceTemplate: occurrence_template
      occurrencePastHorizon: occurrence_past_horizon
      occurrenceFutureHorizon: occurrence_future_horizon
      recurrenceParent: recurrence_parent
      occurrenceDate: occurrence_date
      tags: tags
      timeEntries: timeEntries
      reminders: reminders
      blockedBy: blockedBy
      completeInstances: complete_instances
      skippedInstances: skipped_instances
      icsEventId: icsEventId
      googleCalendarEventId: googleCalendarEventId
      googleCalendarExceptionEventId: googleCalendarExceptionEventId
      googleCalendarExceptionOriginalScheduled: googleCalendarExceptionOriginalScheduled
      googleCalendarMovedOriginalDates: googleCalendarMovedOriginalDates
      sortOrder: tasknotes_manual_order
    binding:
      profiles:
        - core-lite
        - recurrence
        - materialized-occurrences
      capabilities:
        - dependencies
        - reminders
        - attachments
        - links
        - time-tracking
        - materialized-occurrences
        - archive
        - templating
      title:
        storage: frontmatter
        filename_format: zettel
      status:
        values: *a2
        default: open
        completed_values: *a3
        skipped_values:
          - cancelled
        default_skipped: cancelled
        definitions:
          - value: none
            label: None
            color: "#94a3b8"
            is_completed: false
            is_skipped: false
            exclude_from_cycle: false
            order: 0
            auto_archive: false
            auto_archive_delay_minutes: 5
          - value: open
            label: Open
            color: "#64748b"
            is_completed: false
            is_skipped: false
            exclude_from_cycle: false
            order: 1
            auto_archive: false
            auto_archive_delay_minutes: 5
          - value: in-progress
            label: In progress
            color: "#3b82f6"
            is_completed: false
            is_skipped: false
            exclude_from_cycle: false
            order: 2
            auto_archive: false
            auto_archive_delay_minutes: 5
          - value: done
            label: Done
            color: "#22c55e"
            is_completed: true
            is_skipped: false
            exclude_from_cycle: false
            order: 3
            auto_archive: false
            auto_archive_delay_minutes: 5
          - value: cancelled
            label: Cancelled
            color: "#94a3b8"
            is_completed: false
            is_skipped: true
            exclude_from_cycle: true
            order: 4
            auto_archive: false
            auto_archive_delay_minutes: 5
      priority:
        values: *a4
        default: normal
        definitions:
          - value: none
            label: None
            color: "#94a3b8"
            weight: 0
          - value: low
            label: Low
            color: "#3b82f6"
            weight: 1
          - value: normal
            label: Normal
            color: "#f59e0b"
            weight: 2
          - value: high
            label: High
            color: "#ef4444"
            weight: 3
      recurrence:
        syntax: tasknotes
        maintain_due_date_offset: true
        reset_body_checkboxes: false
      occurrences:
        identity_roles:
          - recurrenceParent
          - occurrenceDate
        default_materialization: manual
        default_next_trigger: completion
        past_horizon: P0D
        future_horizon: P14D
      links:
        accepted_formats:
          - wikilink
          - markdown
        write_format: wikilink
      archive:
        archived_tag: archived
        move_on_archive: false
      time_tracking:
        auto_stop_on_complete: false
      templating:
        enabled: false
        occurrence_enabled: false
x-tasknotes-generator:
  managed_fields:
    - attachments
    - blockedBy
    - complete_instances
    - completedDate
    - contexts
    - dateCreated
    - dateModified
    - due
    - googleCalendarEventId
    - googleCalendarExceptionEventId
    - googleCalendarExceptionOriginalScheduled
    - googleCalendarMovedOriginalDates
    - icsEventId
    - id
    - occurrence_date
    - occurrence_future_horizon
    - occurrence_materialization
    - occurrence_next_trigger
    - occurrence_past_horizon
    - occurrence_template
    - priority
    - projects
    - recurrence
    - recurrence_anchor
    - recurrence_parent
    - reminders
    - scheduled
    - skipped_instances
    - status
    - tags
    - tasknotes_manual_order
    - timeEntries
    - timeEstimate
    - title
---
# Task

Task records live under `tasks/`.
