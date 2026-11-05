import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function deploymentFor(target) {
  if (!['staging','production'].includes(target)) throw Error('Unknown Editor target');
  return { target, project:'mdbase-editor',
    origin:target==='staging'?'https://editor-staging.mdbase.dev':'https://editor.mdbase.dev',
    connectOrigin:target==='staging'?'https://connect-staging.mdbase.dev':'https://connect.mdbase.dev',
    branch:target==='staging'?'staging':'main' };
}
export function assertDispatch(env=process.env) {
  const d=deploymentFor(env.TARGET),sha=env.SOURCE_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha??'') || env.GITHUB_EVENT_NAME!=='workflow_dispatch'
    || env.GITHUB_REF!=='refs/heads/main')
    throw Error('Editor dispatch requires main and a full source SHA');
  return {...d,sha};
}
export function assertCheckout(binding,cwd=process.cwd()) {
  const git=args=>execFileSync('git',args,{cwd,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  if(git(['rev-parse','HEAD'])!==binding.sha || git(['status','--porcelain','--untracked-files=all'])!=='')
    throw Error('Editor publisher requires exact clean source');
  assertAncestor(binding,cwd);
  return {sha:binding.sha,tree:git(['rev-parse','HEAD^{tree}']),target:binding.target};
}
export function assertAncestor(binding,cwd=process.cwd()) {
  try { execFileSync('git',['merge-base','--is-ancestor',binding.sha,'refs/remotes/origin/main'],{cwd,stdio:'pipe'}); }
  catch { throw Error('Editor source must be an ancestor of origin/main'); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  try { assertAncestor(assertDispatch()); }
  catch { console.error('Editor dispatch source is not an admitted main ancestor');process.exitCode=1; }
}
