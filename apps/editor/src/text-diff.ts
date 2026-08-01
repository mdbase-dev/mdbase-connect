export type DiffKind = "same" | "local" | "remote" | "omitted";

export interface DiffLine {
  kind: DiffKind;
  text: string;
  localLine?: number;
  remoteLine?: number;
}

const MAX_MATRIX_LINES = 240;
const MAX_VISIBLE_CHANGES = 80;
const CONTEXT_LINES = 3;

export function compareLines(localText: string, remoteText: string): DiffLine[] {
  const local = localText.split("\n");
  const remote = remoteText.split("\n");
  const compared = local.length <= MAX_MATRIX_LINES && remote.length <= MAX_MATRIX_LINES
    ? lcsDiff(local, remote)
    : boundedDiff(local, remote);
  return compactDiff(compared);
}

function lcsDiff(local: string[], remote: string[]): DiffLine[] {
  const lengths = Array.from({ length: local.length + 1 }, () => new Uint16Array(remote.length + 1));
  for (let localIndex = local.length - 1; localIndex >= 0; localIndex -= 1) {
    for (let remoteIndex = remote.length - 1; remoteIndex >= 0; remoteIndex -= 1) {
      lengths[localIndex][remoteIndex] = local[localIndex] === remote[remoteIndex]
        ? lengths[localIndex + 1][remoteIndex + 1] + 1
        : Math.max(lengths[localIndex + 1][remoteIndex], lengths[localIndex][remoteIndex + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let localIndex = 0;
  let remoteIndex = 0;
  while (localIndex < local.length || remoteIndex < remote.length) {
    if (localIndex < local.length && remoteIndex < remote.length && local[localIndex] === remote[remoteIndex]) {
      lines.push({ kind: "same", text: local[localIndex], localLine: localIndex + 1, remoteLine: remoteIndex + 1 });
      localIndex += 1;
      remoteIndex += 1;
    } else if (remoteIndex >= remote.length || (localIndex < local.length && lengths[localIndex + 1][remoteIndex] >= lengths[localIndex][remoteIndex + 1])) {
      lines.push({ kind: "local", text: local[localIndex], localLine: localIndex + 1 });
      localIndex += 1;
    } else {
      lines.push({ kind: "remote", text: remote[remoteIndex], remoteLine: remoteIndex + 1 });
      remoteIndex += 1;
    }
  }
  return lines;
}

function boundedDiff(local: string[], remote: string[]): DiffLine[] {
  let prefix = 0;
  while (prefix < local.length && prefix < remote.length && local[prefix] === remote[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < local.length - prefix
      && suffix < remote.length - prefix
      && local[local.length - suffix - 1] === remote[remote.length - suffix - 1]) suffix += 1;

  return [
    ...local.slice(0, prefix).map((text, index): DiffLine => ({ kind: "same", text, localLine: index + 1, remoteLine: index + 1 })),
    ...local.slice(prefix, local.length - suffix).map((text, index): DiffLine => ({ kind: "local", text, localLine: prefix + index + 1 })),
    ...remote.slice(prefix, remote.length - suffix).map((text, index): DiffLine => ({ kind: "remote", text, remoteLine: prefix + index + 1 })),
    ...local.slice(local.length - suffix).map((text, index): DiffLine => ({
      kind: "same",
      text,
      localLine: local.length - suffix + index + 1,
      remoteLine: remote.length - suffix + index + 1
    }))
  ];
}

function compactDiff(lines: DiffLine[]): DiffLine[] {
  const changes = lines.reduce((count, line) => count + (line.kind === "same" ? 0 : 1), 0);
  if (changes === 0) return [];
  const visible: DiffLine[] = [];
  let shownChanges = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.kind !== "same") {
      if (shownChanges >= MAX_VISIBLE_CHANGES) {
        visible.push({ kind: "omitted", text: `${changes - shownChanges} more changed lines` });
        break;
      }
      visible.push(line);
      shownChanges += 1;
      continue;
    }
    const previousChange = lines.slice(Math.max(0, index - CONTEXT_LINES), index).some((candidate) => candidate.kind !== "same");
    const nextChange = lines.slice(index + 1, index + CONTEXT_LINES + 1).some((candidate) => candidate.kind !== "same");
    if (previousChange || nextChange) {
      visible.push(line);
    } else if (visible.at(-1)?.kind !== "omitted") {
      visible.push({ kind: "omitted", text: "Unchanged lines" });
    }
  }
  return visible;
}
