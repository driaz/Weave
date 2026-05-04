import type { ReactNode } from 'react'

type ViewMode = 'canvas' | 'reflect'

type BrandChromeProps = {
  view: ViewMode
  onViewChange: (view: ViewMode) => void
  nodeCount: number
  boardSwitcher: ReactNode
  userMenu: ReactNode
}

function LogoPaper() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 22 22"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M 3 8 Q 11 14, 19 8"
        stroke="#c9942f"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M 3 14 Q 11 8, 19 14"
        stroke="#3a7359"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <circle cx="3" cy="11" r="1.5" fill="#b84c3a" />
      <circle cx="19" cy="11" r="1.5" fill="#b84c3a" />
    </svg>
  )
}

function ViewToggle({
  view,
  onViewChange,
}: {
  view: ViewMode
  onViewChange: (view: ViewMode) => void
}) {
  const segments: { id: ViewMode; label: string }[] = [
    { id: 'canvas', label: 'Canvas' },
    { id: 'reflect', label: 'Reflect' },
  ]
  return (
    <div
      className="flex items-center"
      style={{
        padding: 3,
        borderRadius: 'var(--w-radius-pill)',
        border: '1px solid var(--w-line)',
        background: 'transparent',
      }}
      role="tablist"
      aria-label="View"
    >
      {segments.map((seg) => {
        const active = seg.id === view
        return (
          <button
            key={seg.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onViewChange(seg.id)}
            className="cursor-pointer transition-colors duration-150"
            style={{
              padding: '4px 12px',
              borderRadius: 'var(--w-radius-pill)',
              border: 'none',
              background: active ? 'var(--w-card)' : 'transparent',
              boxShadow: active ? 'var(--w-shadow-lift)' : 'none',
              color: active ? 'var(--w-ink)' : 'var(--w-ink-soft)',
              fontFamily: 'var(--w-font-sans)',
              fontSize: 12,
              fontWeight: active ? 600 : 500,
            }}
          >
            {seg.label}
          </button>
        )
      })}
    </div>
  )
}

export function BrandChrome({
  view,
  onViewChange,
  nodeCount,
  boardSwitcher,
  userMenu,
}: BrandChromeProps) {
  return (
    <div
      className="flex items-center"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: 52,
        padding: '0 16px',
        background: '#f5f1e8d9',
        backdropFilter: 'blur(12px)',
        WebkitBackdropFilter: 'blur(12px)',
        borderBottom: '1px solid var(--w-line)',
        fontFamily: 'var(--w-font-sans)',
        zIndex: 30,
      }}
    >
      <div className="flex items-center" style={{ gap: 10 }}>
        <LogoPaper />
        <span
          style={{
            fontFamily: 'var(--w-font-display)',
            fontSize: 16,
            fontWeight: 600,
            letterSpacing: '-0.2px',
            color: 'var(--w-ink)',
          }}
        >
          Weave
        </span>
        <div
          style={{
            marginLeft: 20,
            paddingLeft: 20,
            borderLeft: '1px solid var(--w-line)',
          }}
        >
          {boardSwitcher}
        </div>
      </div>

      <div className="flex-1" />

      <div className="flex items-center" style={{ gap: 12 }}>
        <span
          style={{
            fontFamily: 'var(--w-font-mono)',
            fontSize: 11,
            color: 'var(--w-ink-soft)',
            letterSpacing: 0.5,
            marginRight: 4,
          }}
        >
          {nodeCount} NODES
        </span>
        <ViewToggle view={view} onViewChange={onViewChange} />
        {userMenu}
      </div>
    </div>
  )
}
