import { LOCAL_REHEARSAL_BUILD } from '#hosted-local-build';

/** Local transport needs BOTH a compiled local build and the exact local scope.
 * No DNS names, alternate IP spellings, paths, credentials or implicit ports. */
export function localOrigin(value: string, environment: string | undefined): boolean {
  if (!LOCAL_REHEARSAL_BUILD || environment !== 'local') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && !!url.port && url.origin === value
      && !url.username && !url.password;
  } catch { return false; }
}

export function localBuild(): boolean { return LOCAL_REHEARSAL_BUILD; }
