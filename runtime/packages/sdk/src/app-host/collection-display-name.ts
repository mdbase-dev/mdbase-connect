/** Shared cleartext CP catalog label validation, not a path or identity. */
export function collectionDisplayName(value: unknown): string {
  const bad = () => new TypeError("invalid collection display name");
  if (typeof value !== "string" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) throw bad();
  // Reject malformed UTF-16 BEFORE trim; no replacement, NFC or case folding.
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw bad();
    } else if (unit >= 0xdc00 && unit <= 0xdfff) throw bad();
  }
  const name = value.trim();
  if (!name.length || name.length > 200) throw bad();
  return name;
}
