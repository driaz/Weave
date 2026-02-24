import * as pdfjsLib from 'pdfjs-dist'
import pdfjsWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl

const THUMBNAIL_WIDTH = 250
const THUMBNAIL_SCALE_FACTOR = 2

export function isPdfFile(file: File): boolean {
  return file.type === 'application/pdf'
}

function dataUrlToUint8Array(dataUrl: string): Uint8Array {
  const base64 = dataUrl.split(',')[1]
  const binaryString = atob(base64)
  const bytes = new Uint8Array(binaryString.length)
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i)
  }
  return bytes
}

export async function renderPdfPage(
  pdfDataUrl: string,
  pageNumber: number,
  maxWidth: number,
): Promise<string> {
  try {
    const data = dataUrlToUint8Array(pdfDataUrl)
    const pdf = await pdfjsLib.getDocument({ data }).promise

    if (pageNumber < 1 || pageNumber > pdf.numPages) return ''

    const page = await pdf.getPage(pageNumber)
    const unscaledViewport = page.getViewport({ scale: 1 })
    const scale = maxWidth / unscaledViewport.width
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height

    const context = canvas.getContext('2d')
    if (!context) return ''

    await page.render({ canvasContext: context, canvas, viewport }).promise
    return canvas.toDataURL('image/png')
  } catch {
    return ''
  }
}

export async function renderPdfThumbnail(
  pdfDataUrl: string,
): Promise<{ thumbnailDataUrl: string; pageCount: number }> {
  try {
    const data = dataUrlToUint8Array(pdfDataUrl)
    const pdf = await pdfjsLib.getDocument({ data }).promise
    const pageCount = pdf.numPages

    const page = await pdf.getPage(1)
    const unscaledViewport = page.getViewport({ scale: 1 })
    const scale =
      (THUMBNAIL_WIDTH * THUMBNAIL_SCALE_FACTOR) / unscaledViewport.width
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    canvas.width = viewport.width
    canvas.height = viewport.height

    const context = canvas.getContext('2d')
    if (!context) {
      return { thumbnailDataUrl: '', pageCount }
    }

    await page.render({ canvasContext: context, canvas, viewport }).promise

    const thumbnailDataUrl = canvas.toDataURL('image/png')
    return { thumbnailDataUrl, pageCount }
  } catch {
    return { thumbnailDataUrl: '', pageCount: 0 }
  }
}
