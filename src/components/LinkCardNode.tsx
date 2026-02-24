import { useCallback, useRef } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'

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
}

function SkeletonCard() {
  return (
    <div className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden w-[250px]">
      <div className="shimmer w-full h-[140px]" />
      <div className="px-3 py-2 space-y-2">
        <div className="shimmer h-4 w-[80%] rounded" />
        <div className="shimmer h-3 w-[50%] rounded" />
      </div>
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-gray-400"
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-gray-400"
      />
    </div>
  )
}

function TwitterCard({
  authorName,
  authorHandle,
  tweetText,
  domain,
}: {
  authorName: string
  authorHandle: string
  tweetText: string
  domain: string
}) {
  return (
    <>
      <div className="px-3 pt-3 pb-1">
        <p className="text-sm font-medium text-gray-900 leading-snug">
          {authorName}
        </p>
        {authorHandle && (
          <p className="text-xs text-gray-400">{authorHandle}</p>
        )}
      </div>
      <div className="px-3 py-2">
        <p className="text-sm text-gray-700 leading-snug line-clamp-4 whitespace-pre-line">
          {tweetText}
        </p>
      </div>
      <div className="px-3 pb-2">
        <p className="text-xs text-gray-400 truncate">{domain}</p>
      </div>
    </>
  )
}

function YouTubeCard({
  imageUrl,
  title,
  authorName,
  domain,
}: {
  imageUrl: string
  title: string
  authorName: string
  domain: string
}) {
  return (
    <>
      <div className="relative">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={title}
            draggable={false}
            className="w-full h-[140px] object-cover"
            onError={(e) => {
              ;(e.target as HTMLImageElement).style.display = 'none'
            }}
          />
        ) : (
          <div className="w-full h-[140px] bg-gray-100" />
        )}
        <div className="absolute inset-0 flex items-center justify-center">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            className="drop-shadow-lg"
            aria-hidden="true"
          >
            <circle cx="24" cy="24" r="22" fill="rgba(0,0,0,0.6)" />
            <path d="M19 15 L35 24 L19 33 Z" fill="white" />
          </svg>
        </div>
      </div>
      <div className="px-3 py-2">
        <p className="text-sm text-gray-800 leading-snug line-clamp-2">
          {title}
        </p>
        {authorName && (
          <p className="text-xs text-gray-400 mt-1 truncate">{authorName}</p>
        )}
        <p className="text-xs text-gray-400 mt-0.5 truncate">{domain}</p>
      </div>
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
      {imageUrl ? (
        <img
          src={imageUrl}
          alt={title}
          draggable={false}
          className="w-full h-[140px] object-cover"
          onError={(e) => {
            ;(e.target as HTMLImageElement).style.display = 'none'
          }}
        />
      ) : (
        <div className="w-full h-[60px] bg-gray-50 flex items-center justify-center">
          <span className="text-gray-300 text-2xl" aria-hidden="true">
            &#128279;
          </span>
        </div>
      )}
      <div className="px-3 py-2">
        <p className="text-sm text-gray-800 leading-snug line-clamp-2">
          {title}
        </p>
        <p className="text-xs text-gray-400 mt-1 truncate">{domain}</p>
      </div>
    </>
  )
}

export function LinkCardNode({ data }: NodeProps) {
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
  } = data as LinkCardData
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null)

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    mouseDownPos.current = { x: e.clientX, y: e.clientY }
  }, [])

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!mouseDownPos.current) return
      const dx = Math.abs(e.clientX - mouseDownPos.current.x)
      const dy = Math.abs(e.clientY - mouseDownPos.current.y)
      if (dx < 5 && dy < 5) {
        window.open(url, '_blank', 'noopener,noreferrer')
      }
      mouseDownPos.current = null
    },
    [url],
  )

  if (loading) {
    return <SkeletonCard />
  }

  const cardType = type || 'generic'

  return (
    <div
      className="rounded-lg border border-gray-200 bg-white shadow-sm overflow-hidden w-[250px] cursor-pointer"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      role="link"
      aria-label={`Link to ${title} on ${domain}`}
    >
      {cardType === 'twitter' && (
        <TwitterCard
          authorName={authorName || ''}
          authorHandle={authorHandle || ''}
          tweetText={tweetText || ''}
          domain={domain}
        />
      )}
      {cardType === 'youtube' && (
        <YouTubeCard
          imageUrl={imageUrl}
          title={title}
          authorName={authorName || ''}
          domain={domain}
        />
      )}
      {cardType === 'generic' && (
        <GenericCard imageUrl={imageUrl} title={title} domain={domain} />
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-gray-400"
      />
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-gray-400"
      />
    </div>
  )
}
