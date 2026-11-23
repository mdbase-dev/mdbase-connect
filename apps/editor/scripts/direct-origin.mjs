export function editorDirectOrigin(value) {
  if (!value) return undefined;
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.origin !== value ||
      /^(?:editor|editor-staging|editor-lab)\.mdbase\.dev\.?$/i.test(origin.hostname)) {
    throw new Error('MDBASE_EDITOR_DIRECT_ORIGIN must be a dedicated, bare HTTPS origin');
  }
  return origin.origin;
}
