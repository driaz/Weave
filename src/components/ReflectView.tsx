import { useMemo } from 'react'
import { useProfileSnapshot } from '../hooks/useProfileSnapshot'
import type {
  ProfileSnapshot,
  SnapshotCluster,
} from '../persistence/profileSnapshots'
import type { WeaveMode } from '../types/board'

type Reflection = {
  id: string
  title?: string
  /** Pre-formatted, e.g. "APRIL 17". */
  shortDate: string
  /** Pre-formatted, e.g. "APRIL 17, 2026 · 10:52 PM". */
  longDate: string
  /** Body paragraphs in reading order. */
  paragraphs: string[]
  themes: string[]
  threadCount: number
  pieceCount: number
  /** Mode tint for the spine border + scope dot. */
  mode: WeaveMode
}

const MODE_ACCENT: Record<WeaveMode, string> = {
  weave: 'var(--w-standard-accent)',
  deeper: 'var(--w-deeper-accent)',
  tensions: 'var(--w-tensions-accent)',
}

const EMPTY_COPY =
  'Add more to your canvas — Claude will reflect on it as patterns emerge.'

function formatLongDate(iso: string): string {
  const d = new Date(iso)
  const month = d
    .toLocaleString('en-US', { month: 'long' })
    .toUpperCase()
  const day = d.getDate()
  const year = d.getFullYear()
  let hour = d.getHours()
  const ampm = hour >= 12 ? 'PM' : 'AM'
  hour = hour % 12 || 12
  const minute = d.getMinutes().toString().padStart(2, '0')
  return `${month} ${day}, ${year} · ${hour}:${minute} ${ampm}`
}

function formatShortDate(iso: string): string {
  const d = new Date(iso)
  const month = d
    .toLocaleString('en-US', { month: 'long' })
    .toUpperCase()
  return `${month} ${d.getDate()}`
}

function reflectionFromSnapshot(snap: ProfileSnapshot): Reflection | null {
  const paragraphs = snap.narrative
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
  if (paragraphs.length === 0) return null

  const clusters = (snap.clusters ?? []).filter(
    (c): c is SnapshotCluster => !!c,
  )
  const themes = clusters
    .map((c) => c.theme_description?.trim())
    .filter((t): t is string => !!t && t.length > 0)
  const pieceCount = clusters.reduce((sum, c) => sum + (c.size ?? 0), 0)

  const title = snap.generation_metadata?.title ?? ''

  return {
    id: snap.id,
    title,
    shortDate: formatShortDate(snap.created_at),
    longDate: formatLongDate(snap.created_at),
    paragraphs,
    themes,
    threadCount: clusters.length,
    pieceCount,
    mode: 'weave',
  }
}

type ReflectViewProps = {
  onBack: () => void
  boardName: string
}

export function ReflectView({ onBack, boardName }: ReflectViewProps) {
  const { snapshot, loading, error } = useProfileSnapshot()

  const reflection = useMemo<Reflection | null>(
    () => (snapshot ? reflectionFromSnapshot(snapshot) : null),
    [snapshot],
  )

  // Render mode for the content area:
  //   - 'snapshot': have a usable reflection
  //   - 'loading' : no snapshot yet, refresh in flight
  //   - 'empty'   : no snapshot, not loading (or refresh errored — silent)
  const contentMode: 'snapshot' | 'loading' | 'empty' = reflection
    ? 'snapshot'
    : loading
      ? 'loading'
      : 'empty'

  // Empty / error both surface as the empty state. `error` is read so
  // an explicit reference exists for future diagnostics; current UX
  // matches the historical silent-error behavior.
  void error

  const accent = reflection
    ? MODE_ACCENT[reflection.mode]
    : MODE_ACCENT.weave

  const firstChar = reflection?.paragraphs[0]?.[0] ?? ''
  const firstParagraphRest = reflection?.paragraphs[0]?.slice(1) ?? ''

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'var(--w-paper)',
        color: 'var(--w-ink)',
        fontFamily: 'var(--w-font-sans)',
        overflow: 'hidden',
      }}
    >
      {/* Subtle warm wash */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          pointerEvents: 'none',
          background:
            'radial-gradient(ellipse at 50% 0%, var(--w-standard-bg-soft) 0%, transparent 55%)',
          opacity: 0.66,
        }}
      />

      {/* Local context bar — sits directly under BrandChrome (52px) */}
      <div
        className="flex items-center justify-between"
        style={{
          position: 'absolute',
          top: 52,
          left: 0,
          right: 0,
          height: 56,
          padding: '0 28px',
          zIndex: 10,
        }}
      >
        <button
          type="button"
          onClick={onBack}
          className="cursor-pointer"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            background: 'transparent',
            border: 'none',
            padding: 0,
            fontFamily: 'var(--w-font-sans)',
            fontSize: 13,
            color: 'var(--w-ink-soft)',
          }}
        >
          <span>{'← Back to canvas'}</span>
          <span
            style={{
              fontFamily: 'var(--w-font-display)',
              fontStyle: 'italic',
              color: 'var(--w-ink-faint)',
            }}
          >
            {boardName}
          </span>
        </button>
        <span
          style={{
            fontFamily: 'var(--w-font-mono)',
            fontSize: 10,
            letterSpacing: 0.8,
            color: 'var(--w-ink-faint)',
            textTransform: 'uppercase',
          }}
        >
          Reflect
        </span>
      </div>

      {/* Left spine — snapshot history */}
      <aside
        style={{
          position: 'absolute',
          left: 28,
          top: 52 + 90,
          bottom: 40,
          width: 140,
          zIndex: 1,
        }}
      >
        <h2
          style={{
            margin: 0,
            marginBottom: 14,
            fontFamily: 'var(--w-font-mono)',
            fontSize: 10,
            letterSpacing: 0.8,
            color: 'var(--w-ink-faint)',
            textTransform: 'uppercase',
            fontWeight: 500,
          }}
        >
          Reflections
        </h2>
        {reflection && (
          <nav className="flex flex-col">
            <div
              className="text-left"
              style={{
                display: 'block',
                padding: '10px 0 10px 14px',
                background: 'transparent',
                border: 'none',
                borderLeft: `2px solid ${MODE_ACCENT[reflection.mode]}`,
                opacity: 1,
              }}
            >
              {reflection.title && (
                <div
                  style={{
                    fontFamily: 'var(--w-font-display)',
                    fontStyle: 'italic',
                    fontSize: 13,
                    color: 'var(--w-ink)',
                    lineHeight: 1.25,
                    marginBottom: 4,
                  }}
                >
                  {reflection.title}
                </div>
              )}
              <div
                style={{
                  fontFamily: 'var(--w-font-mono)',
                  fontSize: 9.5,
                  color: 'var(--w-ink-faint)',
                  letterSpacing: 0.4,
                  textTransform: 'uppercase',
                }}
              >
                {reflection.shortDate}
              </div>
            </div>
          </nav>
        )}
      </aside>

      {/* Reading column */}
      <article
        style={{
          position: 'absolute',
          left: 220,
          right: 220,
          top: 52 + 90,
          bottom: 40,
          overflowY: 'auto',
          zIndex: 1,
        }}
      >
        {contentMode === 'snapshot' && reflection && (
          <>
            <div
              className="flex items-center"
              style={{
                gap: 20,
                marginBottom: 18,
                fontFamily: 'var(--w-font-mono)',
                fontSize: 10.5,
                letterSpacing: 0.8,
                color: 'var(--w-ink-faint)',
                textTransform: 'uppercase',
              }}
            >
              <span>{reflection.longDate}</span>
              <span style={{ color: accent }}>
                {`● ${reflection.threadCount} THREADS · ${reflection.pieceCount} PIECES`}
              </span>
            </div>

            {reflection.title && (
              <h1
                style={{
                  margin: 0,
                  marginBottom: 32,
                  fontFamily: 'var(--w-font-display)',
                  fontSize: 38,
                  fontWeight: 400,
                  letterSpacing: '-0.5px',
                  lineHeight: 1.1,
                  color: 'var(--w-ink)',
                }}
              >
                {reflection.title}
              </h1>
            )}

            {reflection.paragraphs.map((para, i) => {
              if (i === 0) {
                return (
                  <p
                    key={i}
                    style={{
                      margin: 0,
                      marginBottom: 22,
                      fontFamily: 'var(--w-font-display)',
                      fontSize: 17.5,
                      lineHeight: 1.65,
                      color: 'var(--w-ink)',
                    }}
                  >
                    <span
                      style={{
                        float: 'left',
                        fontFamily: 'var(--w-font-display)',
                        fontSize: 64,
                        fontWeight: 500,
                        lineHeight: 0.9,
                        color: 'var(--w-standard-accent)',
                        marginRight: 10,
                        marginTop: 6,
                        marginBottom: -6,
                        letterSpacing: '-2px',
                      }}
                    >
                      {firstChar}
                    </span>
                    {firstParagraphRest}
                  </p>
                )
              }
              return (
                <p
                  key={i}
                  style={{
                    margin: 0,
                    marginBottom: 22,
                    fontFamily: 'var(--w-font-display)',
                    fontSize: 17.5,
                    lineHeight: 1.65,
                    color: 'var(--w-ink)',
                  }}
                >
                  {para}
                </p>
              )
            })}

            <div
              className="flex items-center"
              style={{ marginTop: 24, gap: 10 }}
            >
              <span
                aria-hidden="true"
                style={{
                  width: 24,
                  height: 1,
                  background: 'var(--w-line)',
                }}
              />
              <span
                style={{
                  fontFamily: 'var(--w-font-mono)',
                  fontSize: 11,
                  color: 'var(--w-ink-faint)',
                  letterSpacing: 0.5,
                }}
              >
                woven from {reflection.threadCount} themes
              </span>
            </div>

            <div
              className="flex flex-wrap"
              style={{ marginTop: 14, columnGap: 14, rowGap: 6 }}
            >
              {reflection.themes.map((theme, i) => (
                <span
                  key={`${theme}-${i}`}
                  style={{
                    fontFamily: 'var(--w-font-display)',
                    fontStyle: 'italic',
                    fontSize: 13.5,
                    color: 'var(--w-ink-soft)',
                  }}
                >
                  {theme}
                  {i < reflection.themes.length - 1 && (
                    <span
                      aria-hidden="true"
                      style={{
                        color: 'var(--w-ink-faint)',
                        marginLeft: 14,
                      }}
                    >
                      {'·'}
                    </span>
                  )}
                </span>
              ))}
            </div>

            <div style={{ height: 60 }} />
          </>
        )}

        {contentMode === 'loading' && <ReflectionSkeleton />}

        {contentMode === 'empty' && (
          <div
            style={{
              fontFamily: 'var(--w-font-display)',
              fontStyle: 'italic',
              fontSize: 18,
              lineHeight: 1.55,
              color: 'var(--w-ink-soft)',
              maxWidth: 520,
              marginTop: 24,
            }}
          >
            {EMPTY_COPY}
          </div>
        )}
      </article>
    </div>
  )
}

function ReflectionSkeleton() {
  const block = (height: number, width: string, marginBottom: number) => (
    <div
      style={{
        height,
        width,
        marginBottom,
        background:
          'linear-gradient(90deg, var(--w-line) 0%, var(--w-bg-soft, rgba(0,0,0,0.04)) 50%, var(--w-line) 100%)',
        backgroundSize: '200% 100%',
        borderRadius: 3,
        opacity: 0.55,
        animation: 'reflectShimmer 1.6s ease-in-out infinite',
      }}
    />
  )
  return (
    <div
      role="status"
      aria-label="Loading reflection"
      style={{ marginTop: 4 }}
    >
      <style>{`
        @keyframes reflectShimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
      {block(11, '46%', 18)}
      {block(34, '78%', 32)}
      {block(14, '96%', 8)}
      {block(14, '92%', 8)}
      {block(14, '88%', 8)}
      {block(14, '94%', 28)}
      {block(14, '90%', 8)}
      {block(14, '82%', 8)}
      {block(14, '70%', 28)}
    </div>
  )
}
