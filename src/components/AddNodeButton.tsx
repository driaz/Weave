import { useState, useCallback, useRef, useEffect } from 'react'
import { useReactFlow } from '@xyflow/react'
import { generateNodeId } from '../utils/nodeId'
import { readFileAsDataUrl, isImageFile } from '../utils/imageUtils'
import { fetchLinkMetadata, fetchTweetImage, isUrl, extractDomain, extractYouTubeUrlFromText } from '../utils/linkUtils'
import { fetchTranscript } from '../utils/transcriptUtils'
import { isPdfFile, renderPdfThumbnail } from '../utils/pdfUtils'
import { trackEvent } from '../services/eventTracker'
import { useBoardId } from '../hooks/useBoardId'
import { embedNodeAsync } from '../services/embeddingService'

export function AddNodeButton() {
  const { addNodes, screenToFlowPosition, updateNodeData, getNodes } = useReactFlow()
  const boardId = useBoardId()
  const [menuOpen, setMenuOpen] = useState(false)
  const [linkInputMode, setLinkInputMode] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [fetchingLink, setFetchingLink] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setLinkInputMode(false)
        setLinkUrl('')
      }
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [menuOpen])

  const closeMenu = useCallback(() => {
    setMenuOpen(false)
    setLinkInputMode(false)
    setLinkUrl('')
  }, [])

  useEffect(() => {
    if (linkInputMode && linkInputRef.current) {
      linkInputRef.current.focus()
    }
  }, [linkInputMode])

  const getCenterPosition = useCallback(() => {
    return screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    })
  }, [screenToFlowPosition])

  const handleAddText = useCallback(() => {
    const nodeId = generateNodeId()
    addNodes({
      id: nodeId,
      type: 'textCard',
      position: getCenterPosition(),
      data: { text: '' },
    })
    trackEvent('item_added', {
      targetId: `node:${boardId}:${nodeId}`,
      boardId,
      metadata: { node_type: 'textCard' },
    })
    // Text is empty at creation — embedNode will skip gracefully
    embedNodeAsync(boardId, nodeId, 'textCard', { text: '' })
    setMenuOpen(false)
  }, [addNodes, getCenterPosition, boardId])

  const handleAddImage = useCallback(() => {
    fileInputRef.current?.click()
    setMenuOpen(false)
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !isImageFile(file)) return

      const imageDataUrl = await readFileAsDataUrl(file)
      const nodeId = generateNodeId()
      addNodes({
        id: nodeId,
        type: 'imageCard',
        position: getCenterPosition(),
        data: { imageDataUrl, fileName: file.name, label: '' },
      })
      trackEvent('item_added', {
        targetId: `node:${boardId}:${nodeId}`,
        boardId,
        metadata: { node_type: 'imageCard' },
      })
      embedNodeAsync(boardId, nodeId, 'imageCard', {
        imageDataUrl,
        fileName: file.name,
        label: '',
      })

      e.target.value = ''
    },
    [addNodes, getCenterPosition, boardId],
  )

  const handleAddPdf = useCallback(() => {
    pdfInputRef.current?.click()
    setMenuOpen(false)
  }, [])

  const handlePdfFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !isPdfFile(file)) return

      const pdfDataUrl = await readFileAsDataUrl(file)
      const { thumbnailDataUrl, pageCount } =
        await renderPdfThumbnail(pdfDataUrl)

      const nodeId = generateNodeId()
      addNodes({
        id: nodeId,
        type: 'pdfCard',
        position: getCenterPosition(),
        data: {
          pdfDataUrl,
          fileName: file.name,
          label: '',
          thumbnailDataUrl,
          pageCount,
        },
      })
      trackEvent('item_added', {
        targetId: `node:${boardId}:${nodeId}`,
        boardId,
        metadata: { node_type: 'pdfCard' },
      })
      embedNodeAsync(boardId, nodeId, 'pdfCard', {
        thumbnailDataUrl,
        fileName: file.name,
        label: '',
        pageCount,
      })

      e.target.value = ''
    },
    [addNodes, getCenterPosition, boardId],
  )

  const handleLinkSubmit = useCallback(async () => {
    const trimmed = linkUrl.trim()
    if (!trimmed || fetchingLink) return

    const urlToFetch = isUrl(trimmed)
      ? trimmed
      : isUrl(`https://${trimmed}`)
        ? `https://${trimmed}`
        : null

    if (!urlToFetch) return

    setFetchingLink(true)

    // Create node immediately with loading state
    const nodeId = generateNodeId()
    const domain = extractDomain(urlToFetch)
    addNodes({
      id: nodeId,
      type: 'linkCard',
      position: getCenterPosition(),
      data: {
        url: urlToFetch,
        title: domain || urlToFetch,
        description: '',
        imageUrl: '',
        domain,
        type: 'generic',
        loading: true,
      },
    })
    trackEvent('item_added', {
      targetId: `node:${boardId}:${nodeId}`,
      boardId,
      metadata: { node_type: 'linkCard' },
    })

    // Close menu immediately
    setMenuOpen(false)
    setLinkInputMode(false)
    setLinkUrl('')

    // Fetch metadata and update node
    const metadata = await fetchLinkMetadata(urlToFetch)
    updateNodeData(nodeId, {
      ...metadata,
      loading: false,
    })

    if (metadata.type === 'twitter') {
      // Fetch tweet image async — don't block the card render
      fetchTweetImage(urlToFetch).then((tweetImage) => {
        if (tweetImage.imageBase64 && tweetImage.imageMimeType) {
          updateNodeData(nodeId, {
            imageBase64: tweetImage.imageBase64,
            imageMimeType: tweetImage.imageMimeType,
          })
        }
      })

      // Fetch transcript for tweet video (native or embedded YouTube)
      const tweetYouTubeUrl = metadata.tweetText ? extractYouTubeUrlFromText(metadata.tweetText) : null
      const transcriptUrl = tweetYouTubeUrl || urlToFetch
      fetchTranscript(transcriptUrl).then((transcript) => {
        if (transcript) {
          const field = tweetYouTubeUrl ? 'youtubeTranscript' : 'transcript'
          updateNodeData(nodeId, { [field]: transcript })
        }
      })

      // Delay embedding for tweets to allow image fetch to complete
      setTimeout(() => {
        const current = getNodes().find((n) => n.id === nodeId)
        if (current) {
          embedNodeAsync(boardId, nodeId, 'linkCard', {
            ...current.data,
            loading: false,
          })
        }
      }, 8000)
    } else if (metadata.type === 'youtube') {
      // Fetch transcript async — don't block the card render
      fetchTranscript(urlToFetch).then((transcript) => {
        if (transcript) {
          updateNodeData(nodeId, { transcript })
        }
      })

      // Delay embedding for YouTube to allow transcript fetch to complete
      setTimeout(() => {
        const current = getNodes().find((n) => n.id === nodeId)
        if (current) {
          embedNodeAsync(boardId, nodeId, 'linkCard', {
            ...current.data,
            loading: false,
          })
        }
      }, 8000)
    } else {
      // Embed immediately for other linkCards
      embedNodeAsync(boardId, nodeId, 'linkCard', {
        ...metadata,
        loading: false,
      })
    }

    setFetchingLink(false)
  }, [linkUrl, fetchingLink, addNodes, getCenterPosition, updateNodeData, getNodes, boardId])

  const handleLinkKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleLinkSubmit()
      }
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setLinkInputMode(false)
        setLinkUrl('')
      }
      e.stopPropagation()
    },
    [handleLinkSubmit],
  )

  return (
    <div className="relative">
      {menuOpen && (
        <>
        <div
          className="fixed inset-0 z-40"
          onClick={closeMenu}
          aria-hidden="true"
        />
        <div className="absolute bottom-12 left-0 z-50 bg-white rounded-lg border border-gray-200 shadow-md py-1 min-w-[140px]">
          {linkInputMode ? (
            <div className="px-3 py-2">
              <input
                ref={linkInputRef}
                type="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={handleLinkKeyDown}
                onBlur={() => {
                  if (!fetchingLink) closeMenu()
                }}
                placeholder="Paste a URL..."
                disabled={fetchingLink}
                className="w-full text-sm text-gray-700 bg-transparent outline-none placeholder:text-gray-400 min-w-[200px]"
                aria-label="URL for link card"
              />
              {fetchingLink && (
                <p className="text-xs text-gray-400 mt-1">Fetching...</p>
              )}
            </div>
          ) : (
            <>
              <button
                onClick={handleAddText}
                className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                Text Card
              </button>
              <button
                onClick={handleAddImage}
                className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                Image Card
              </button>
              <button
                onClick={() => setLinkInputMode(true)}
                className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                Link Card
              </button>
              <button
                onClick={handleAddPdf}
                className="w-full px-3 py-2 text-left text-sm text-gray-700 hover:bg-gray-50 cursor-pointer"
              >
                PDF Card
              </button>
            </>
          )}
        </div>
        </>
      )}
      <button
        onClick={() => setMenuOpen(!menuOpen)}
        className="w-10 h-10 rounded-full bg-white border border-gray-200 shadow-sm flex items-center justify-center text-gray-400 text-2xl font-light hover:text-gray-700 hover:shadow-md hover:border-gray-300 hover:scale-105 active:scale-95 transition-all duration-150 cursor-pointer"
        aria-label="Add new card"
        aria-expanded={menuOpen}
        aria-haspopup="true"
      >
        +
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        onChange={handleFileChange}
        className="hidden"
        aria-hidden="true"
      />
      <input
        ref={pdfInputRef}
        type="file"
        accept=".pdf,application/pdf"
        onChange={handlePdfFileChange}
        className="hidden"
        aria-hidden="true"
      />
    </div>
  )
}
