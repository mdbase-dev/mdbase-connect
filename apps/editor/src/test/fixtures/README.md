The TaskNotes type and contract are exact copies of the resources installed by
`tasknotes-app/src/generated/mdbase-app.json` at
`9c38c7ddb7f6e91609760bb148d420ff71f44042`:

- `_types/task.md` (task version 5, with its inline record schema and binding)
- `_contracts/tasknotes.task/0.3.0-rc.6.md` (record and binding schemas)

They exercise the Type Browser's binding validator with the full installed
TaskNotes definition and the same restriction on dynamic code evaluation as the
production Content Security Policy. Keep the schemas and binding together when
updating this fixture.
