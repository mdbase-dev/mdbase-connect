export function MdbaseMark() {
  return <svg className="wordmark-mark" viewBox="18 18 84 84" aria-hidden="true" focusable="false">
    <g className="wordmark-mark-ink">
      <rect x="22" y="22" width="20" height="10" rx="2" />
      <rect x="50" y="22" width="20" height="10" rx="2" />
      <rect x="78" y="22" width="20" height="10" rx="2" />
      <rect x="22" y="44" width="12" height="10" rx="2" />
      <rect x="22" y="66" width="28" height="10" rx="2" />
      <rect x="58" y="66" width="40" height="10" rx="2" />
      <rect x="22" y="88" width="20" height="10" rx="2" />
      <rect x="50" y="88" width="20" height="10" rx="2" />
      <rect x="78" y="88" width="20" height="10" rx="2" />
    </g>
    <rect className="wordmark-mark-accent" x="42" y="44" width="56" height="10" rx="2" />
  </svg>;
}

export function Wordmark() {
  return <div className="wordmark"><MdbaseMark /><span className="wordmark-label"><span>mdbase</span><strong>editor</strong></span></div>;
}
