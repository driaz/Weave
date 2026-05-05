function KnotMark() {
  return (
    <svg
      width="120"
      height="90"
      viewBox="0 0 120 90"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 10 30 Q 60 60, 110 30"
        stroke="var(--w-tensions-accent)"
        strokeOpacity="0.3"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="3 4"
      />
      <path
        d="M 10 60 Q 60 30, 110 60"
        stroke="var(--w-tensions-accent)"
        strokeOpacity="0.3"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray="3 4"
      />
      <circle
        cx="10"
        cy="45"
        r="5"
        fill="var(--w-standard-bg)"
        stroke="var(--w-standard-accent)"
        strokeWidth="1.5"
      />
      <circle
        cx="110"
        cy="45"
        r="5"
        fill="var(--w-standard-bg)"
        stroke="var(--w-standard-accent)"
        strokeWidth="1.5"
      />
      <circle
        cx="60"
        cy="45"
        r="5"
        fill="var(--w-standard-bg)"
        stroke="var(--w-standard-accent)"
        strokeWidth="1.5"
        strokeDasharray="2 2"
      />
    </svg>
  )
}

export function EmptyCanvas() {
  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        pointerEvents: 'none',
        zIndex: 1,
      }}
    >
      <div
        className="flex flex-col items-center"
        style={{ padding: '0 24px' }}
      >
        <div style={{ marginBottom: 20 }}>
          <KnotMark />
        </div>
        <h2
          style={{
            margin: 0,
            marginBottom: 10,
            fontFamily: 'var(--w-font-display)',
            fontSize: 28,
            fontWeight: 500,
            letterSpacing: '-0.5px',
            color: 'var(--w-ink)',
            textWrap: 'balance',
            textAlign: 'center',
            userSelect: 'none',
          }}
        >
          Drop a few things you’ve been thinking about.
        </h2>
        <p
          style={{
            margin: 0,
            maxWidth: 380,
            fontFamily: 'var(--w-font-sans)',
            fontSize: 14,
            lineHeight: 1.5,
            color: 'var(--w-ink-soft)',
            textAlign: 'center',
            userSelect: 'none',
          }}
        >
          Links, images, quotes, half-finished notes — Claude will look for the
          threads between them.
        </p>
      </div>
    </div>
  )
}
