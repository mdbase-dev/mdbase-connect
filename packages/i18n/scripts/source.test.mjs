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

for (const [name, source] of [
  [
    "marked React copy",
    "function Panel() { return <button><Trans>Save {title}</Trans></button> }",
  ],
  [
    "marked attributes",
    "function Panel() { return <button aria-label={t`Save ${title}`} /> }",
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
