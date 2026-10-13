// Fixed selector/dispatch guards only; this never dispatches a workflow or signs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require=createRequire(new URL('../../packages/protocol/package.json',import.meta.url));
const {parse}=require('yaml');
const workflow=parse(readFileSync(new URL('../../.github/workflows/publish-images.yml',import.meta.url),'utf8'));
test('fixed LAB/staging selector does not schedule image publication',()=>{
 assert.deepEqual(workflow.on.workflow_dispatch.inputs.operation.options,['images','lab-trust','staging-trust']);
 const guard=workflow.jobs.changes.if;
 assert.ok(guard.includes("inputs.operation == 'images'"));
 assert.ok(!guard.includes("inputs.operation != 'lab-trust'"));
 const job=workflow.jobs['trust-bundle'];
 assert.ok(job.if.includes("inputs.operation == 'lab-trust'"));
 assert.ok(job.if.includes("inputs.operation == 'staging-trust'"));
 assert.equal(job.env.TRUST_ENVIRONMENT,"${{ inputs.operation == 'staging-trust' && 'staging' || 'lab' }}");
 assert.equal(job.permissions['id-token'],'write');
 const qualify=job.steps.find(s=>s.id==='publisher-qualification').run;
 for(const gate of ['test "$GITHUB_REF" = refs/heads/main','test "$GITHUB_REPOSITORY" = mdbase-dev/mdbase-connect','asset="config/next-trust/$TRUST_ENVIRONMENT.json"','test -f "$asset" && test ! -L "$asset"','test "$(jq -er .environment "$asset")" = "$TRUST_ENVIRONMENT"','scripts/ci/verify-qualified-commit "$GITHUB_SHA"'])assert.ok(qualify.includes(gate),gate);
 const steps=job.steps.filter(s=>s.run).map(s=>s.run).join('\n');
 assert.ok(steps.includes('"$RUNNER_TEMP/release-trust" "$TRUST_ENVIRONMENT"'));
 assert.ok(steps.includes('--certificate-identity \'https://github.com/mdbase-dev/mdbase-connect/.github/workflows/publish-images.yml@refs/heads/main\''));
 assert.ok(steps.includes('--certificate-oidc-issuer https://token.actions.githubusercontent.com'));
 assert.ok(steps.includes('scripts/ci/verify-qualified-commit "$SOURCE_COMMIT" "$run"'));
 assert.ok(steps.includes('cosign sign-blob --yes'));
 assert.equal(Object.hasOwn(workflow.on.workflow_dispatch.inputs,'asset_path'),false);
 assert.equal(Object.hasOwn(workflow.on.workflow_dispatch.inputs,'trust_environment'),false);
});
