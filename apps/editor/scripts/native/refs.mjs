// Existing native publisher dispatch/clean-HEAD checks, not release authority.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
export function deploymentFor(target) {
  if (!['staging','production'].includes(target)) throw Error('Unknown native Editor target');
  return { target, releaseRef:`release/native-${target}`, project:'mdbase-editor',
    origin:target==='staging'?'https://editor-staging.mdbase.dev':'https://editor.mdbase.dev',
    connectOrigin:target==='staging'?'https://connect-staging.mdbase.dev':'https://connect.mdbase.dev',
    branch:target==='staging'?'staging':'main' };
}
export function assertDispatch(env=process.env) {
  const d=deploymentFor(env.TARGET),sha=env.SOURCE_SHA;
  if (!/^[a-f0-9]{40}$/.test(sha??'') || env.GITHUB_EVENT_NAME!=='workflow_dispatch'
    || env.GITHUB_REF!==`refs/heads/${d.releaseRef}` || env.GITHUB_SHA!==sha)
    throw Error('Native dispatch requires the literal target release branch and exact full HEAD SHA');
  return {...d,sha};
}
export function assertCheckout(binding,cwd=process.cwd()) {
  const git=args=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
  if(git(['rev-parse','HEAD'])!==binding.sha || git(['status','--porcelain','--untracked-files=all'])!=='')
    throw Error('Native publisher requires exact clean source');
  const tip=git(['rev-parse',`refs/remotes/origin/${binding.releaseRef}^{commit}`]);
  if(tip!==binding.sha)throw Error('Native release HEAD differs from requested source');
  return {sha:binding.sha,tree:git(['rev-parse','HEAD^{tree}']),target:binding.target,releaseRef:binding.releaseRef};
}
export async function assertCurrentHead(env=process.env,transport=fetch) {
  const binding=assertDispatch(env);
  const response=await transport(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/git/ref/heads/${binding.releaseRef}`,{
    redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'}});
  if(!response.ok)throw Error('Current native release HEAD unavailable');
  const ref=await response.json();
  if(ref.ref!==`refs/heads/${binding.releaseRef}` || ref.object?.type!=='commit' || ref.object.sha!==binding.sha)
    throw Error('Current native release HEAD moved; refusing upload');
  return binding;
}
if(process.argv[1]===fileURLToPath(import.meta.url))await assertCurrentHead();
