import { useEffect, useState, useMemo } from 'react'
import { supabase } from '../services/supabaseClient'
import type { WeaveMode } from '../types/board'

type SnapshotCluster = {
  cluster_id: string
  size: number
  theme_description: string | null
}

type Snapshot = {
  id: string
  created_at: string
  node_count: number
  clusters: SnapshotCluster[] | null
  narrative: string | null
  generation_metadata: { title?: string } | null
}

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

const HARDCODED_REFLECTION: Reflection = {
  id: 'seed-clarity-as-cost',
  shortDate: 'APRIL 17',
  longDate: 'APRIL 17, 2026 · 10:52 PM',
  threadCount: 11,
  pieceCount: 37,
  mode: 'weave',
  paragraphs: [
    'There is a recurring figure across this entire collection: someone who sees through the machinery and is worse off for it. It appears in the venture capital threads, where stripping away mythology leaves you holding an emptier thing than you started with. It appears in the life-script cluster, where understanding that the goalposts dissolved doesn’t give you new goalposts. It appears in the Norm Macdonald clip, where the person stating the universal truth watches it fail to land on the person standing right there. And it appears most explicitly in the largest thread, the one that asks whether heightened understanding separates you from ease rather than delivering you to it. The collection keeps arriving at the same structure from wildly different directions: clarity as cost, not reward. That this pattern spans VC critique, parenting disillusionment, comedy, and personal philosophy suggests it isn’t a position being argued so much as a gravitational tendency—a way of encountering the world that precedes any particular subject.',
    'But set against this is something that cuts against resignation. The pieces about connection-as-subtraction, the scenes where a character stops performing and speaks a simple emotional truth, the twice-saved clip where someone converts damage into purpose—these are moments of arrival, not withdrawal. They don’t celebrate understanding; they celebrate the instant someone drops their understanding and says the plain thing. The curator is drawn to both modes almost equally: the lucidity that isolates and the vulnerability that connects. The tension isn’t hidden. The largest thread names it outright—the suspicion that meaning-seeking might itself be avoidance of simple presence. What’s striking is that the collection doesn’t resolve this suspicion. It holds court, gathering evidence on both sides, as if the act of curation itself is the deliberation.',
    'There’s a second tension worth naming. Several threads are fascinated by moments where someone’s mask slips involuntarily—the public figure whose scripture indicts their own worship, the self-justifying monologue that’s half confession. But the threads about bold visual posts and about declarative emotional scenes are drawn to the opposite: moments where someone drops the mask on purpose, with full intention, and that act of deliberate exposure is what gives the moment its weight. The collection seems to be working out whether truth emerges despite people or because of them—whether the meaningful reveal is the one the speaker didn’t mean to make, or the one they chose to make at great cost. Both are collected with the same intensity, which suggests the curator isn’t sure either, and finds the question itself worth sitting inside.',
    'What runs beneath all of it is an attention to the moment a shared script fails. The life scripts that collapsed. The VC mythology that dissolves under scrutiny. The hierarchies people impose that prevent the connection they claim to want. The political critique that crosses tribal lines precisely because the old lines stopped holding. Even the comedy and image-posting thread carries this: a fascination with people who declare something into a void where no shared framework guarantees it will land. The collection maps a landscape where the old agreements—about careers, about institutions, about how to be in relationships, about what intelligence or success even means—have quietly expired, and the people inside them are only now noticing. The curator isn’t mourning those agreements exactly, but they’re not celebrating the absence either. They’re watching, very carefully, for what happens in the gap.',
  ],
  themes: [
    'clarity as burden',
    'involuntary confession',
    'connection through subtraction',
    'scripts that expired',
    'vulnerability as arrival',
    'meaning-seeking as avoidance',
    'institutional mythology',
    'comedy as failed truth-delivery',
    'deliberate exposure',
    'the gap after agreement',
    'presence vs. understanding',
  ],
}

const MODE_ACCENT: Record<WeaveMode, string> = {
  weave: 'var(--w-standard-accent)',
  deeper: 'var(--w-deeper-accent)',
  tensions: 'var(--w-tensions-accent)',
}

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

function reflectionFromSnapshot(snap: Snapshot): Reflection | null {
  const narrative = snap.narrative?.trim()
  if (!narrative) return null
  const paragraphs = narrative
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
    threadCount: clusters.length || HARDCODED_REFLECTION.threadCount,
    pieceCount: pieceCount || HARDCODED_REFLECTION.pieceCount,
    mode: 'weave',
  }
}

type ReflectViewProps = {
  onBack: () => void
  boardName: string
}

export function ReflectView({ onBack, boardName }: ReflectViewProps) {
  const [reflection, setReflection] = useState<Reflection>(HARDCODED_REFLECTION)
  const [activeId, setActiveId] = useState<string>(HARDCODED_REFLECTION.id)

  // Try to fetch the latest real snapshot; if narrative is present, swap in.
  // If not, the hardcoded seed remains.
  useEffect(() => {
    if (!supabase) return
    let cancelled = false
    async function load() {
      const { data, error } = await supabase!
        .from('weave_profile_snapshots')
        .select('id, created_at, node_count, clusters, narrative, generation_metadata')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled || error || !data) return
      const real = reflectionFromSnapshot(data as Snapshot)
      if (real) {
        setReflection(real)
        setActiveId(real.id)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const accent = MODE_ACCENT[reflection.mode]
  const reflections: Reflection[] = useMemo(() => [reflection], [reflection])

  const [firstChar, ...firstRest] = reflection.paragraphs[0] ?? ['']
  const firstParagraphRest = firstRest.join('')

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
        <nav className="flex flex-col">
          {reflections.map((r) => {
            const isActive = r.id === activeId
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => setActiveId(r.id)}
                className="text-left cursor-pointer"
                style={{
                  display: 'block',
                  padding: '10px 0 10px 14px',
                  background: 'transparent',
                  border: 'none',
                  borderLeft: `2px solid ${
                    isActive ? MODE_ACCENT[r.mode] : 'var(--w-line)'
                  }`,
                  opacity: isActive ? 1 : 0.55,
                  transition: 'opacity 200ms ease, border-color 200ms ease',
                }}
              >
                {r.title && (
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
                    {r.title}
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
                  {r.shortDate}
                </div>
              </button>
            )
          })}
        </nav>
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
      </article>
    </div>
  )
}
