import { useEffect, useState } from "react";

/** A permission review survives polling, but never silently rebases onto changed access. */
export function usePermissionSelection(id: string, allowed: readonly string[]) {
  const key = JSON.stringify([id, [...allowed].sort()]);
  const [review, setReview] = useState(() => ({ key, selected: [...allowed], needsReview: false }));
  const changedExternally = review.key !== key;
  const needsReview = changedExternally && JSON.stringify([id, [...review.selected].sort()]) !== key;
  useEffect(() => {
    if (changedExternally) setReview({ key, selected: [...allowed], needsReview });
  }, [key, changedExternally, needsReview]);
  return {
    selected: changedExternally ? [...allowed] : review.selected,
    needsReview: changedExternally ? needsReview : review.needsReview,
    setSelected: (selected: string[] | ((current: string[]) => string[])) => setReview((current) => ({
      ...current,
      selected: typeof selected === "function" ? selected(current.selected) : selected
    })),
    acknowledge: () => setReview((current) => ({ ...current, needsReview: false }))
  };
}
