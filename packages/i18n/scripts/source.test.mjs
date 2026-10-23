import assert from "node:assert/strict";
import test from "node:test";
import { inspectUiSource } from "./source.mjs";

for (const [name, source, kind] of [
  [
    "plain copy",
    "function Panel() { return <button>Save changes</button> }",
    "unmarked JSX text",
  ],
  [
    "accessible copy",
    'function Panel() { return <button aria-label="Save changes" /> }',
    "unmarked visible string",
  ],
  [
    "recovery copy",
    'function Panel() { return <Notice recovery="Try again." /> }',
    "unmarked visible string",
  ],
  [
    "conditional copy",
    'function Panel() { return <span>{busy ? "Saving" : "Save"}</span> }',
    "unmarked visible string",
  ],
  [
    "interpolated copy",
    "function Panel() { return <button aria-label={`Delete ${title}`} /> }",
    "unmarked visible interpolation",
  ],
  [
    "identifier comparison",
    'function handle() { return kind === t({message:"task"}) }',
    "translation in control-flow comparison",
  ],
  [
    "identifier lookup",
    'function handle() { return names.includes(t({message:"task"})) }',
    "translation in identifier lookup",
  ],
  [
    "count-kind identifier",
    'function label() { return countLabel(2, t({message:"dependency"})) }',
    "translation in count-kind identifier",
  ],
  [
    "nested descriptor macro",
    'function label() { return t`Editor for ${t({message:"scratchpad"})}` }',
    "uncompiled nested translation macro",
  ],
  [
    "nested tagged macro",
    "function label() { return t`Editor for ${t`scratchpad`}` }",
    "uncompiled nested translation macro",
  ],
  [
    "explicit-instance identifier attribute",
    'function Panel() { return <span className={t(i18n)`is-open`} /> }',
    "translation in identifier attribute",
  ],
  [
    "explicit-instance comparison",
    'function Panel() { return value === t(i18n)({message: "Open"}) }',
    "translation in control-flow comparison",
  ],
  [
    "eager explicit-instance label",
    'const label = t(i18n)`Today`;',
    "eager module-level translation",
  ],
  [
    "static class field",
    'class Panel { static label = t(i18n)`Today`; }',
    "eager module-level translation",
  ],
  [
    "static class block",
    'class Panel { static { this.label = t`Today`; } }',
    "eager module-level translation",
  ],
  [
    "class identifier field",
    'class Panel { className = t`is-open`; }',
    "translation in identifier property",
  ],
  [
    "explicit-instance nested translation",
    'function label() { return t(i18n)`Editor for ${t(i18n)({message:"scratchpad"})}` }',
    "uncompiled nested translation macro",
  ],
  [
    "eager label",
    'const options = [{label:t({message:"Today"})}];',
    "eager module-level translation",
  ],
  [
    "CSS attribute",
    'function Panel() { return <span className={t({message:"is-open"})} /> }',
    "translation in identifier attribute",
  ],
  [
    "CSS variable",
    "function Panel() { const positionClass = t`is-open`; return <span className={positionClass} /> }",
    "translation in CSS class variable",
  ],
  [
    "record key",
    "function input() { return {key:t`scheduled`} }",
    "translation in identifier property",
  ],
]) {
  test(`source guard rejects ${name}`, () => {
    assert.ok(inspectUiSource(source).some((issue) => issue.kind === kind));
  });
}

test("source guard follows rendered React state, including the private-account notices QA found", () => {
  const source = `function PrivateAccountPanel() {
    const [notice, setNotice] = useState<string | null>(null);
    const [action, setAction] = useState("unlock");
    async function submit() {
      setAction("change_password");
      setNotice(result.incomplete?.length
        ? \`Recovery is set up. \${result.incomplete.length} private collections still need to finish key access.\`
        : translate({message: "Recovery is set up. Save your recovery key before leaving this screen."}));
      setNotice(result.incomplete?.length
        ? \`Account unlocked. \${result.incomplete.length} private collections still need to finish key access; retry unlock when they are current.\`
        : translate({message: "Account unlocked. Private collection keys are available on this device."}));
      setNotice(result.complete ? translate({message: "Done"})
        : \`Strict mode is pending in \${result.pending.length} recovery \${result.pending.length === 1 ? "target" : "targets"}.\`);
    }
    return <section>{notice && <p role="status">{notice}</p>}<p>{labels[action]}</p></section>;
  }`;
  const issues = inspectUiSource(source);
  assert.equal(issues.filter((issue) => issue.kind === "unmarked visible interpolation").length, 3);
  assert.deepEqual(issues.filter((issue) => issue.kind === "unmarked visible string").map((issue) => issue.text), ["target", "targets"]);
});

const writerNotice = (initial, update, rendered = "notice.text") => `function WorkspaceView() {
  const [notice, setNotice] = useState(${initial});
  function store() { setNotice(${update}); }
  return notice && <div className={\`toast tone-\${notice.tone}\`}
    role={notice.tone === "problem" ? "alert" : "status"}>
    {notice.tone === "busy" ? <Spinner /> : <Icon />}
    <span>{${rendered}}</span>
    {notice.tone === "busy" && <Cancel />}
  </div>;
}`;

test("source guard accepts writer notice discriminators but follows rendered text", () => {
  assert.deepEqual(inspectUiSource(writerNotice("null", '{ tone: "busy", text: t`Storing…` }')), []);
  assert.deepEqual(inspectUiSource(writerNotice("null", '{ tone: "problem", text: translate`Try again.` }')), []);
  assert.deepEqual(inspectUiSource(writerNotice("null", '{ tone: "ok", text: t`Stored.` }')), []);
  assert.deepEqual(inspectUiSource(writerNotice("null", '{ tone: "busy", text: "Storing…" }'))
    .map((issue) => issue.text), ["Storing…"]);
});

for (const [name, initial, update, rendered, expected] of [
  ["initializer", '{ tone: "busy", text: "Storing…" }', "null", "notice.text", ["Storing…"]],
  ["updater", "null", 'previous => ({ ...previous, tone: "busy", text: "Storing…" })', "notice.text", ["Storing…"]],
  ["computed access", "null", '{ tone: "busy", text: "Storing…" }', 'notice["text"]', ["Storing…"]],
  ["quoted keys", "null", '{ "tone": "busy", ["text"]: "Storing…" }', "notice.text", ["Storing…"]],
  ["nested fields", "null", '{ tone: "busy", content: { mode: "pending", copy: "Storing…" } }', "notice.content.copy", ["Storing…"]],
  ["arbitrary field names", "null", '{ text: "busy", tone: "Storing…" }', "notice.tone", ["Storing…"]],
  ["multiple rendered fields", "null", '{ tone: "busy", text: "Storing…", detail: "Please wait." }', "notice.text}{notice.detail", ["Storing…", "Please wait."]],
  ["conditional copy", "null", '{ tone: "busy", text: ok ? "Stored." : "Try again." }', "notice.text", ["Stored.", "Try again."]],
]) {
  test(`source guard tracks object-state ${name} at field granularity`, () => {
    assert.deepEqual(inspectUiSource(writerNotice(initial, update, rendered)).map((issue) => issue.text), expected);
  });
}

test("editor state types and opaque component prop spreads are not rendered copy", () => {
  assert.deepEqual(inspectUiSource(`function CollectionRail() {
    const [folderChange, setFolderChange] = useState<{ mode: "rename" | "move"; from: string }>();
    const moveFolder = (from) => setFolderChange({ from, mode: "move" });
    return <>{folderChange && <FolderChangeDialog key={folderChange.mode} {...folderChange} />}</>;
  }`), []);
  assert.deepEqual(inspectUiSource(`function Panel() {
    const [notice, setNotice] = useState<{ text: "Storing…"; mode: "busy" }>({ text: "Storing…", mode: "busy" });
    return <><Dialog {...notice} /><p>{notice.text}</p></>;
  }`).map((issue) => issue.text), ["Storing…"]);
});

test("source guard still rejects scalar initializers with literal state types", () => {
  assert.deepEqual(inspectUiSource(`function Panel() {
    const [notice] = useState<"Storing…" | null>("Storing…");
    return <p>{notice}</p>;
  }`).map((issue) => issue.text), ["Storing…"]);
});

test("object-state fields reaching visible attributes are copy too", () => {
  assert.deepEqual(inspectUiSource(`function Panel() {
    const [notice, setNotice] = useState(null);
    setNotice({ status: "busy", hint: "Please wait." });
    return <input placeholder={notice.hint} className={notice.status} />;
  }`).map((issue) => issue.text), ["Please wait."]);
});

test("truthiness-only object state does not make sibling fields visible", () => {
  assert.deepEqual(inspectUiSource(`function Panel() {
    const [notice, setNotice] = useState(null);
    setNotice({ status: "busy", payload: "internal" });
    return notice && <Spinner />;
  }`), []);
});

for (const [name, value, kind] of [
  ["plain notice", '"Save your recovery key."', "unmarked visible string"],
  ["template notice", '`Save your recovery key.`', "unmarked visible string"],
  ["conditional notice", 'ok ? "Account unlocked." : "Retry unlock."', "unmarked visible string"],
  ["interpolated notice", '`Unlocked ${count} collections.`', "unmarked visible interpolation"],
  ["updater notice", 'previous => `Unlocked ${count} collections.`', "unmarked visible interpolation"],
]) {
  test(`source guard rejects ${name} passed to a rendered state setter`, () => {
    const source = `function Panel() { const [notice, showCopy] = React.useState(null);
      function submit() { showCopy(${value}); } return <p>{notice}</p>; }`;
    assert.ok(inspectUiSource(source).some((issue) => issue.kind === kind));
  });
}

test("source guard rejects unmarked initial rendered state", () => {
  assert.ok(inspectUiSource('function Panel() { const [notice] = useState("Save your key."); return <p>{notice}</p>; }')
    .some((issue) => issue.kind === "unmarked visible string"));
});

for (const [name, source] of [
  [
    "marked state notices",
    'function Panel() { const [notice, setNotice] = useState(null); function submit() { setNotice(t(i18n)`Unlocked ${count} collections.`); } return <p>{notice}</p>; }',
  ],
  [
    "non-copy state and opaque calls",
    'function Panel() { const [action, setAction] = useState("unlock"); const [password, setPassword] = useState("secret"); setAction("recover"); log(`Account unlocked: ${id}`); return <><input value={password} /><p>{labels[action]}</p></>; }',
  ],
  [
    "marked React copy",
    "function Panel() { return <button><Trans>Save {title}</Trans></button> }",
  ],
  [
    "marked attributes",
    "function Panel() { return <button aria-label={t`Save ${title}`} /> }",
  ],
  [
    "explicit-instance tagged macro",
    'function Panel() { return <span title={t(i18n)`Save ${name}`}>{t(runtime.i18n)`Hello`}</span> }',
  ],
  [
    "explicit-instance descriptor macro",
    'function Panel() { return <span title={t(i18n)({message: "Save", context: "action"})} /> }',
  ],
  [
    "nested plural",
    'function Panel() { return <span>{t`Hide ${plural(count, {one: "# file", other: "# files"})}`}</span> }',
  ],
  [
    "explicit-instance nested plural",
    'function Panel() { return <span>{t(i18n)`Hide ${plural(count, {one: "# file", other: "# files"})}`}</span> }',
  ],
  [
    "nested selection helpers",
    'function Panel() { return <span>{t`Place ${selectOrdinal(count, {one: "#st", other: "#th"})}: ${select(kind, {open: "Open", other: "Closed"})}`}</span> }',
  ],
  [
    "class instance fields",
    'class Panel { label = t`Today`; detail = t(i18n)({message: "Open"}); plural = t`Hide ${plural(count, {one: "# file", other: "# files"})}`; }',
  ],
  [
    "plural macro",
    'function Panel() { return <Plural value={count} one="# task" other="# tasks" /> }',
  ],
  [
    "lazy translated interpolation",
    'function label() { return t`Editor for ${uiCopy("scratchpad")}` }',
  ],
  [
    "module-level descriptors (not eager translations)",
    'const label = msg({message: "Today"}); const detail = defineMessage({message: "Open"});',
  ],
  [
    "lazy labels",
    'const options = [{get label() {return t({message:"Today"})}}];',
  ],
  [
    "opaque identifiers",
    'function Panel() { return <input id="task-title" type="text" className="form-field" /> }',
  ],
  ["user content", "function Panel() { return <span>{task.title}</span> }"],
  [
    "translation alias",
    "function Panel() { return <button aria-label={translate`Save ${title}`} /> }",
  ],
]) {
  test(`source guard accepts ${name}`, () => {
    assert.deepEqual(inspectUiSource(source), []);
  });
}
