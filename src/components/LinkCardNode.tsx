import { useState, useCallback, useEffect, useRef, type CSSProperties } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { useNodeHighlightStatus } from '../hooks/useSelectedNode'
import { createPortal } from 'react-dom'
import { extractYouTubeVideoId, extractYouTubeUrlFromText } from '../utils/linkUtils'
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'
import { useCancelNodeSelect } from '../hooks/useCancelNodeSelect'

export type LinkCardData = {
  url: string
  title: string
  description: string
  imageUrl: string
  domain: string
  type?: 'generic' | 'twitter' | 'youtube'
  loading?: boolean
  authorName?: string
  authorHandle?: string
  tweetText?: string
  embedHtml?: string
  imageBase64?: string
  imageMimeType?: string
  transcript?: string
  youtubeTranscript?: string
  /**
   * 2-3 sentence Sonnet summary of YouTube video content. Generated after
   * the transcript lands and consumed by the voice pipeline so it can speak
   * about a node without the raw transcript. Populated only on YouTube
   * linkCards (not Twitter, not generic).
   */
  contentDescription?: string
}

const CARD_WIDTH = 250

const CARD_BASE: CSSProperties = {
  width: CARD_WIDTH,
  background: 'var(--w-card)',
  borderRadius: 'var(--w-radius-lg)',
  boxShadow: 'var(--w-shadow-card)',
  border: '1px solid var(--w-line)',
  overflow: 'hidden',
  fontFamily: 'var(--w-font-sans)',
  color: 'var(--w-ink)',
  userSelect: 'none',
  cursor: 'pointer',
}

const HANDLE_STYLE: CSSProperties = {
  background: 'var(--w-ink-faint)',
  border: 'none',
  width: 6,
  height: 6,
}

function Favicon({ label, color = 'standard' }: { label: string; color?: 'standard' | 'tensions' }) {
  const palette =
    color === 'tensions'
      ? { bg: '#f0d2c8', fg: '#6b2a24' }
      : { bg: '#e8dcc4', fg: '#6b4e1e' }
  return (
    <span
      aria-hidden="true"
      style={{
        display: 'grid',
        placeItems: 'center',
        width: 16,
        height: 16,
        borderRadius: 4,
        background: palette.bg,
        color: palette.fg,
        fontSize: 10,
        fontWeight: 700,
        flexShrink: 0,
        fontFamily: 'var(--w-font-sans)',
      }}
    >
      {label.slice(0, 1).toUpperCase() || '·'}
    </span>
  )
}

function NodeTag({ children }: { children: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--w-font-mono)',
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: 0.6,
        color: 'var(--w-ink-soft)',
        textTransform: 'uppercase',
      }}
    >
      {children}
    </span>
  )
}

function NodeMeta({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center"
      style={{
        gap: 8,
        padding: '10px 14px',
        fontSize: 11,
        color: 'var(--w-ink-soft)',
        borderTop: '1px solid var(--w-line-soft)',
      }}
    >
      {children}
    </div>
  )
}

function SkeletonCard() {
  return (
    <div style={CARD_BASE}>
      <div className="shimmer" style={{ width: '100%', height: 120 }} />
      <div style={{ padding: '12px 14px 10px' }}>
        <div className="shimmer" style={{ height: 14, width: '80%', borderRadius: 4, marginBottom: 8 }} />
        <div className="shimmer" style={{ height: 11, width: '50%', borderRadius: 4 }} />
      </div>
      <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
      <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
    </div>
  )
}

function TweetLightbox({
  authorName,
  authorHandle,
  tweetText,
  imageUrl,
  embedHtml,
  domain,
  onClose,
}: {
  authorName: string
  authorHandle: string
  tweetText: string
  imageUrl: string
  embedHtml: string
  domain: string
  onClose: () => void
}) {
  const embedRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  useEffect(() => {
    if (!embedHtml || !embedRef.current) return
    const container = embedRef.current

    type Twttr = { widgets: { load: (el?: HTMLElement) => void } }
    const win = window as unknown as { twttr?: Twttr }

    const hydrate = () => {
      if (win.twttr?.widgets) {
        win.twttr.widgets.load(container)
      }
    }

    if (win.twttr?.widgets) {
      hydrate()
    } else {
      let script = document.querySelector('script[src*="platform.twitter.com/widgets.js"]') as HTMLScriptElement | null
      if (!script) {
        script = document.createElement('script')
        script.src = 'https://platform.twitter.com/widgets.js'
        script.async = true
        script.charset = 'utf-8'
        document.head.appendChild(script)
      }
      script.addEventListener('load', hydrate)
    }
  }, [embedHtml])

  const youtubeUrl = extractYouTubeUrlFromText(tweetText)
  const youtubeVideoId = youtubeUrl ? extractYouTubeVideoId(youtubeUrl) : null

  let displayText = tweetText
  if (imageUrl) {
    displayText = displayText.replace(/https?:\/\/pic\.twitter\.com\/\S+/g, '').trim()
  }
  if (youtubeVideoId) {
    displayText = displayText.replace(/https?:\/\/(?:www\.)?(?:youtube\.com\/(?:watch\S*|shorts\/\S+)|youtu\.be\/\S+)/g, '').trim()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Tweet by ${authorName}`}
    >
      <div
        className="bg-white rounded-xl shadow-2xl w-[550px] max-w-[90vw] max-h-[90vh] overflow-y-auto p-5 cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        {embedHtml ? (
          <div className="tweet-embed-container">
            <div
              ref={embedRef}
              dangerouslySetInnerHTML={{ __html: embedHtml }}
            />
          </div>
        ) : (
          <>
            <div className="mb-3">
              <p className="text-base font-semibold text-gray-900">{authorName}</p>
              {authorHandle && (
                <p className="text-sm text-gray-400">{authorHandle}</p>
              )}
            </div>
            <p className="text-[15px] text-gray-700 leading-relaxed whitespace-pre-line mb-4">
              {displayText}
            </p>
            {imageUrl && (
              <img
                src={imageUrl}
                alt={`Image from tweet by ${authorName}`}
                className="w-full rounded-lg mb-4"
                onError={(e) => {
                  ;(e.target as HTMLImageElement).style.display = 'none'
                }}
              />
            )}
            {youtubeVideoId && (
              <div className="w-full aspect-video mb-4">
                <iframe
                  src={`https://www.youtube.com/embed/${youtubeVideoId}`}
                  title="Embedded YouTube video"
                  className="w-full h-full rounded-lg"
                  allow="autoplay; encrypted-media"
                  allowFullScreen
                />
              </div>
            )}
            <p className="text-xs text-gray-400">{domain}</p>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

function YouTubeLightbox({
  videoId,
  title,
  onClose,
}: {
  videoId: string
  title: string
  onClose: () => void
}) {
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose])

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 cursor-pointer"
      onClick={(e) => {
        e.stopPropagation()
        onClose()
      }}
      role="dialog"
      aria-modal="true"
      aria-label={`Video: ${title}`}
    >
      <div
        className="w-[800px] max-w-[90vw] aspect-video cursor-default"
        onClick={(e) => e.stopPropagation()}
      >
        <iframe
          src={`https://www.youtube.com/embed/${videoId}?autoplay=1`}
          title={title}
          className="w-full h-full rounded-lg shadow-2xl"
          allow="autoplay; encrypted-media"
          allowFullScreen
        />
      </div>
    </div>,
    document.body,
  )
}

function TwitterCard({
  authorName,
  authorHandle,
  tweetText,
}: {
  authorName: string
  authorHandle: string
  tweetText: string
}) {
  const initial = (authorName || authorHandle || '?').trim().slice(0, 1).toUpperCase()
  const handle = authorHandle ? authorHandle.replace(/^@?/, '@') : ''
  return (
    <div style={{ padding: '14px 16px 12px' }}>
      <div className="flex items-center" style={{ gap: 10, marginBottom: 10 }}>
        <span
          aria-hidden="true"
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 32,
            height: 32,
            borderRadius: 999,
            background: 'linear-gradient(135deg, #c9b88a, #a88a5e)',
            color: '#ffffff',
            fontSize: 12,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {initial}
        </span>
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--w-ink)',
              lineHeight: 1.2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: 180,
            }}
          >
            {authorName || 'Unknown'}
          </div>
          {handle && (
            <div
              style={{
                fontSize: 11,
                color: 'var(--w-ink-faint)',
                lineHeight: 1.2,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                maxWidth: 180,
              }}
            >
              {handle}
            </div>
          )}
        </div>
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 13,
          lineHeight: 1.45,
          color: 'var(--w-ink)',
          display: '-webkit-box',
          WebkitLineClamp: 5,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          whiteSpace: 'pre-line',
        }}
      >
        {tweetText}
      </p>

      <div
        className="flex items-center"
        style={{
          marginTop: 10,
          paddingTop: 8,
          borderTop: '1px solid var(--w-line-soft)',
          gap: 14,
          fontFamily: 'var(--w-font-mono)',
          fontSize: 10,
          color: 'var(--w-ink-faint)',
        }}
      >
        {/* Engagement stats slot — wired up when likes/retweets land in
            LinkCardData. Footer structure stays so the layout doesn't jump
            once they arrive. */}
        <span style={{ marginLeft: 'auto' }}>
          <NodeTag>POST</NodeTag>
        </span>
      </div>
    </div>
  )
}

function YouTubeCard({
  imageUrl,
  title,
  authorName,
}: {
  imageUrl: string
  title: string
  authorName: string
}) {
  const channelLabel = authorName || 'Channel'
  return (
    <>
      <div
        style={{
          position: 'relative',
          height: 150,
          background: imageUrl
            ? `center / cover no-repeat url(${JSON.stringify(imageUrl)})`
            : 'radial-gradient(circle at 30% 30%, #4a3a2a 0%, #1a1612 70%)',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: 44,
            height: 44,
            borderRadius: 999,
            background: 'rgba(255, 255, 255, 0.92)',
            boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
            display: 'grid',
            placeItems: 'center',
          }}
        >
          <span
            style={{
              display: 'block',
              width: 0,
              height: 0,
              borderLeft: '12px solid #1a1612',
              borderTop: '8px solid transparent',
              borderBottom: '8px solid transparent',
              marginLeft: 3,
            }}
          />
        </div>
      </div>

      <div style={{ padding: '12px 14px 10px' }}>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--w-font-display)',
            fontSize: 14,
            fontWeight: 500,
            lineHeight: 1.3,
            color: 'var(--w-ink)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {title}
        </p>
      </div>

      <NodeMeta>
        <span
          aria-hidden="true"
          style={{
            display: 'grid',
            placeItems: 'center',
            width: 14,
            height: 14,
            borderRadius: 999,
            background: '#e8b4a8',
            color: '#6b2a24',
            fontSize: 9,
            fontWeight: 700,
            flexShrink: 0,
          }}
        >
          {channelLabel.slice(0, 1).toUpperCase()}
        </span>
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {channelLabel}
        </span>
        <NodeTag>VIDEO</NodeTag>
      </NodeMeta>
    </>
  )
}

function GenericCard({
  imageUrl,
  title,
  domain,
}: {
  imageUrl: string
  title: string
  domain: string
}) {
  return (
    <>
      <div
        style={{
          position: 'relative',
          height: 120,
          background: imageUrl
            ? `center / cover no-repeat url(${JSON.stringify(imageUrl)})`
            : undefined,
        }}
        className={imageUrl ? undefined : 'w-stripe-placeholder'}
      >
        {!imageUrl && (
          <span
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              fontFamily: 'var(--w-font-mono)',
              fontSize: 10,
              color: 'rgba(60, 50, 30, 0.5)',
              background: 'rgba(255, 255, 255, 0.7)',
              padding: '3px 8px',
              borderRadius: 4,
              letterSpacing: 0.4,
            }}
          >
            og:image
          </span>
        )}
      </div>

      <div style={{ padding: '12px 14px 10px' }}>
        <p
          style={{
            margin: 0,
            fontFamily: 'var(--w-font-display)',
            fontSize: 15,
            fontWeight: 500,
            lineHeight: 1.25,
            color: 'var(--w-ink)',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
          }}
        >
          {title}
        </p>
      </div>

      <NodeMeta>
        <Favicon label={domain} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {domain}
        </span>
      </NodeMeta>
    </>
  )
}

export function LinkCardNode({ id, data }: NodeProps) {
  const {
    url,
    title,
    imageUrl,
    domain,
    type,
    loading,
    authorName,
    authorHandle,
    tweetText,
    embedHtml,
  } = data as LinkCardData
  const { isSelected, isConnected } = useNodeHighlightStatus(id)
  const [showLightbox, setShowLightbox] = useState(false)
  const lightboxOpenedAtRef = useRef<number | null>(null)
  const boardId = useBoardId()
  const cancelPendingNodeSelect = useCancelNodeSelect()

  const closeLightbox = useCallback(() => {
    setShowLightbox(false)
    const openedAt = lightboxOpenedAtRef.current
    lightboxOpenedAtRef.current = null
    if (boardId && openedAt !== null) {
      trackEvent('lightbox_closed', {
        targetId: `node:${boardId}:${id}`,
        boardId,
        durationMs: Math.round(performance.now() - openedAt),
        metadata: { node_type: 'linkCard', link_type: type || 'generic' },
      })
    }
  }, [boardId, id, type])

  const handleDoubleClick = useCallback(() => {
    const cardType = type || 'generic'
    cancelPendingNodeSelect()
    if (cardType === 'twitter' || cardType === 'youtube') {
      setShowLightbox(true)
      lightboxOpenedAtRef.current = performance.now()
      if (boardId) {
        trackEvent('lightbox_opened', {
          targetId: `node:${boardId}:${id}`,
          boardId,
          metadata: { node_type: 'linkCard', link_type: cardType },
        })
      }
    } else {
      window.open(url, '_blank', 'noopener,noreferrer')
    }
  }, [type, url, boardId, id, cancelPendingNodeSelect])

  if (loading) {
    return <SkeletonCard />
  }

  const cardType = type || 'generic'
  const highlightClass = `${isConnected ? ' node-highlight' : ''}${isSelected ? ' selected-node-highlight' : ''}`.trim()

  return (
    <>
      <div
        style={CARD_BASE}
        className={highlightClass || undefined}
        onDoubleClick={handleDoubleClick}
        role="link"
        aria-label={`Link to ${title} on ${domain}`}
      >
        {cardType === 'twitter' && (
          <TwitterCard
            authorName={authorName || ''}
            authorHandle={authorHandle || ''}
            tweetText={tweetText || ''}
          />
        )}
        {cardType === 'youtube' && (
          <YouTubeCard
            imageUrl={imageUrl}
            title={title}
            authorName={authorName || ''}
          />
        )}
        {cardType === 'generic' && (
          <GenericCard imageUrl={imageUrl} title={title} domain={domain} />
        )}
        <Handle type="source" position={Position.Right} style={HANDLE_STYLE} />
        <Handle type="target" position={Position.Left} style={HANDLE_STYLE} />
      </div>
      {showLightbox && cardType === 'twitter' && (
        <TweetLightbox
          authorName={authorName || ''}
          authorHandle={authorHandle || ''}
          tweetText={tweetText || ''}
          imageUrl={imageUrl || ''}
          embedHtml={embedHtml || ''}
          domain={domain}
          onClose={closeLightbox}
        />
      )}
      {showLightbox && cardType === 'youtube' && (
        <YouTubeLightbox
          videoId={extractYouTubeVideoId(url) || ''}
          title={title}
          onClose={closeLightbox}
        />
      )}
    </>
  )
}
