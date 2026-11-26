import type { FilterGroup, FilterNode } from "./types.js";

let created = 0;
/** An id no parsed node uses (`parseWhere` numbers its nodes `n0`, `n1`, …). */
export const newId = () => `u${++created}`;

/** `node` and its descendants under fresh ids, so it can join another tree without clashing. */
export function reid(node: FilterNode): FilterNode {
  return node.kind === "group" ? { ...node, id: newId(), children: node.children.map(reid) } : { ...node, id: newId() };
}

export function findNode(group: FilterGroup, id: string): FilterNode | null {
  for (const child of group.children) {
    if (child.id === id) return child;
    const found = child.kind === "group" ? findNode(child, id) : null;
    if (found) return found;
  }
  return null;
}

/** `root` with the node `id` replaced by `next`, or removed when `next` is null. The root itself is replaced, never removed. */
export function replaceNode(root: FilterGroup, id: string, next: FilterNode | null): FilterGroup {
  if (root.id === id) return next?.kind === "group" ? next : { ...root, children: [] };
  const walk = (group: FilterGroup): FilterGroup => ({
    ...group,
    children: group.children.flatMap(child => {
      if (child.id === id) return next ? [next] : [];
      return child.kind === "group" ? [walk(child)] : [child];
    }),
  });
  return walk(root);
}

/** `root` with `node` replacing the child of the same id in group `groupId`, or appended there. A missing group means the root. */
export function upsertChild(root: FilterGroup, groupId: string, node: FilterNode): FilterGroup {
  const target = root.id === groupId ? root : findNode(root, groupId);
  const group = target?.kind === "group" ? target : root;
  const children = group.children.some(child => child.id === node.id)
    ? group.children.map(child => (child.id === node.id ? node : child))
    : [...group.children, node];
  return replaceNode(root, group.id, { ...group, children });
}

/** `root` joined with `node` by `&&`, keeping the root's own combinator inside its own group. */
export function appendAll(root: FilterGroup, node: FilterNode): FilterGroup {
  if (root.combinator === "all" || !root.children.length) return { ...root, combinator: "all", children: [...root.children, node] };
  return { kind: "group", id: newId(), combinator: "all", children: [root, node] };
}
