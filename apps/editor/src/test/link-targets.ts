import { LinkTargets } from "../collection-links";
import type { LinkTarget } from "../model";

/** Links from `from` resolved as the collection would answer: each raw link
 * in `answers`, and every other link missing. */
export function linkTargets(from: string, answers: Record<string, LinkTarget> = {}): LinkTargets {
  return new LinkTargets({
    resolveLinks: async (_from, raws) => raws.map((raw) => answers[raw] ?? { kind: "missing" })
  }, from);
}
