export function markdownFragment(body: string, anchor?: string): string | undefined {
  if (!anchor) return body;
  const decoded = decodeAnchor(anchor);
  if (decoded.startsWith("^")) {
    const blockId = decoded.slice(1).toLocaleLowerCase();
    const line = body.split(/\r?\n/).find((candidate) => {
      const match = candidate.match(/\s+\^([\p{L}\p{N}_-]+)\s*$/u);
      return match?.[1].toLocaleLowerCase() === blockId;
    });
    return line?.replace(/\s+\^[\p{L}\p{N}_-]+\s*$/u, "");
  }

  const lines = body.split(/\r?\n/);
  const requested = headingIdentity(decoded);
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(lines[index]);
    if (!heading || headingIdentity(heading[2]) !== requested) continue;
    const level = heading[1].length;
    let end = index + 1;
    while (end < lines.length) {
      const next = /^(#{1,6})\s+/.exec(lines[end]);
      if (next && next[1].length <= level) break;
      end += 1;
    }
    return lines.slice(index, end).join("\n").trimEnd();
  }
  return undefined;
}

function decodeAnchor(value: string): string {
  try { return decodeURIComponent(value).trim(); } catch { return value.trim(); }
}

function headingIdentity(value: string): string {
  return value.normalize("NFC")
    .toLocaleLowerCase()
    .replace(/[*_~`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
