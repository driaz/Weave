import { useState, useCallback, useRef, useEffect } from 'react'
import { useReactFlow } from '@xyflow/react'
import { generateNodeId } from '../utils/nodeId'
import { readFileAsDataUrl, isImageFile } from '../utils/imageUtils'
import { fetchLinkMetadata, isUrl, extractDomain } from '../utils/linkUtils'
import { isPdfFile, renderPdfThumbnail } from '../utils/pdfUtils'

export function AddNodeButton() {
  const { addNodes, screenToFlowPosition, updateNodeData } = useReactFlow()
  const [menuOpen, setMenuOpen] = useState(false)
  const [linkInputMode, setLinkInputMode] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')
  const [fetchingLink, setFetchingLink] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const pdfInputRef = useRef<HTMLInputElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const linkInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false)
        setLinkInputMode(false)
        setLinkUrl('')
      }
    }
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setMenuOpen(false)
        setLinkInputMode(false)
        setLinkUrl('')
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleEscape)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleEscape)
    }
  }, [menuOpen])

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
    addNodes({
      id: generateNodeId(),
      type: 'textCard',
      position: getCenterPosition(),
      data: { text: '' },
    })
    setMenuOpen(false)
  }, [addNodes, getCenterPosition])

  const handleAddImage = useCallback(() => {
    fileInputRef.current?.click()
    setMenuOpen(false)
  }, [])

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0]
      if (!file || !isImageFile(file)) return

      const imageDataUrl = await readFileAsDataUrl(file)
      addNodes({
        id: generateNodeId(),
        type: 'imageCard',
        position: getCenterPosition(),
        data: { imageDataUrl, fileName: file.name, label: '' },
      })

      e.target.value = ''
    },
    [addNodes, getCenterPosition],
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

      addNodes({
        id: generateNodeId(),
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

      e.target.value = ''
    },
    [addNodes, getCenterPosition],
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

    setFetchingLink(false)
  }, [linkUrl, fetchingLink, addNodes, getCenterPosition, updateNodeData])

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
    <div ref={menuRef} className="relative">
      {menuOpen && (
        <div className="absolute bottom-12 left-0 bg-white rounded-lg border border-gray-200 shadow-md py-1 min-w-[140px]">
          {linkInputMode ? (
            <div className="px-3 py-2">
              <input
                ref={linkInputRef}
                type="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={handleLinkKeyDown}
                onBlur={() => {
                  if (!fetchingLink) {
                    setMenuOpen(false)
                    setLinkInputMode(false)
                    setLinkUrl('')
                  }
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
