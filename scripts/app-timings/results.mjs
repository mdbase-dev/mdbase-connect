export const apps = {
  editor: {origin: 'https://editor.mdbase.dev', selector: '.note-row:not(.file-row)'},
  writer: {origin: 'https://writer.mdbase.dev', selector: '.manuscript-row'},
  tasknotes: {origin: 'https://app.tasknotes.dev', selector: '.task-row[data-task-id]'},
};
export const sizes = ['100', '1k', '10k'];
export const token = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export function median(values) {
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2);
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
