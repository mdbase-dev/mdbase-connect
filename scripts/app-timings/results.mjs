export const apps = {
  editor: {origin: 'https://editor.mdbase.dev', selector: '.note-row:not(.file-row)'},
  writer: {origin: 'https://writer.mdbase.dev', selector: '.manuscript-row'},
  tasknotes: {origin: 'https://app.tasknotes.dev', selector: '.task-row[data-task-id]'},
};
export const sizes = ['100', '1k', '10k'];
export const token = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const openingStages = {
  joining: 'joining',
  opening_store: 'opening_store',
  connecting_log: 'connecting_log',
  syncing: 'syncing',
  loading_snapshot: 'snapshot',
  replaying: 'apply',
  waiting_for_key: 'key_wait',
  verifying_read: 'verifying_read',
  checking_setup: 'checking_setup',
};
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
}
// Page-load stages use navigation time. Cold records start at the approval
// response headers, timestamped by Chromium's network clock, not Node's clock.
export function measuredStages(observation, approvalEpoch) {
  const {ttfb, fcp, lcp, firstRecords, timeOrigin, endedAt, opening, marks, firstQuery} = observation;
  const start = approvalEpoch === undefined ? 0 : approvalEpoch - timeOrigin;
  const stages = {ttfb};
  if (approvalEpoch !== undefined) stages.consent = start;
  if (Number.isFinite(firstRecords)) stages.first_records = firstRecords - start;
  if (fcp !== undefined) stages.fcp = fcp;
  if (lcp !== null) stages.lcp = lcp;
  const openingMarks = opening.filter(entry => Object.hasOwn(openingStages, entry.stage));
  const openingEnd = Math.min(marks.ready ?? endedAt, firstRecords ?? endedAt);
  for (let index = 0; index < openingMarks.length; index++) {
    const current = openingMarks[index];
    const end = Math.min(openingMarks[index + 1]?.at ?? openingEnd, openingEnd);
    if (end < start || current.at > openingEnd) continue;
    const name = openingStages[current.stage];
    stages[name] = (stages[name] ?? 0) + Math.max(0, end - Math.max(start, current.at));
  }
  if (marks.requested !== undefined) {
    if (Number.isFinite(firstRecords)) stages.open_first_records = firstRecords - marks.requested;
    if (marks.approved !== undefined) stages.open_approved = marks.approved - marks.requested;
    if (marks.ready !== undefined) {
      stages.open_ready = marks.ready - marks.requested;
      if (Number.isFinite(firstRecords)) stages.render = firstRecords - marks.ready;
    }
    if (firstQuery !== undefined) stages.first_query = firstQuery - marks.requested;
  }
  return stages;
}
export function result(component, samples, checkedAt) {
  const failure = samples.find(sample => sample.error);
  const revisions = new Set(samples.map(sample => sample.revision));
  const invalid = samples.some(sample => Object.values(sample.stages).some(value => !Number.isFinite(value) || value < 0));
  const error = failure?.error ?? (invalid ? {stage: 'measurement', code: 'invalid_duration'} : null) ?? (revisions.size !== 1 ? {stage: 'revision', code: 'revision_changed'} : null);
  const names = [...new Set(samples.flatMap(sample => Object.keys(sample.stages)))];
  const stages = names.map(name => {
    const values = samples.map(sample => sample.stages[name]);
    const complete = values.every(value => Number.isFinite(value) && value >= 0);
    return {name, status: complete ? 'operational' : 'failed', duration_ms: complete ? median(values) : 0};
  });
  if (error && !stages.some(stage => stage.name === error.stage)) stages.push({name: error.stage, status: 'failed', duration_ms: 0});
  const body = {
    schema_version: 1, source: 'app', component, environment: 'production', checked_at: checkedAt,
    status: error ? 'failed' : 'operational',
    duration_ms: error ? 0 : median(samples.map(sample => sample.stages.first_records)),
    stages, revision: revisions.size === 1 ? samples[0].revision : 'mixed', ...(error ? {error} : {}),
  };
  for (const value of [component, body.revision, ...stages.map(stage => stage.name), ...(error ? [error.stage, error.code] : [])]) {
    if (!token.test(value)) throw Error('invalid_result_token');
  }
  return body;
}
