import { Fragment } from "react";
import type { SearchTextRange } from "./note-search";

export function SearchMatchText({ text, ranges }: { text: string; ranges: SearchTextRange[] }) {
  if (!ranges.length) return text;
  let cursor = 0;
  return <>
    {ranges.map((range, index) => {
      const before = text.slice(cursor, range.from);
      const match = text.slice(range.from, range.to);
      cursor = range.to;
      return <Fragment key={`${range.from}:${range.to}`}>
        {before}
        <mark>{match}</mark>
        {index === ranges.length - 1 ? text.slice(cursor) : null}
      </Fragment>;
    })}
  </>;
}
