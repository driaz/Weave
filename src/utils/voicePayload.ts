import type { Node } from '@xyflow/react'
import type { TextCardData } from '../components/TextCardNode'
import type { ImageCardData } from '../components/ImageCardNode'
import type { LinkCardData } from '../components/LinkCardNode'
import type { PdfCardData } from '../components/PdfCardNode'

export type VoiceNodePayload = {
  title: string
  contentDescription: string
  contentType: string
}

const TEXT_TITLE_MAX = 60

function trimOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

export function nodeToVoicePayload(node: Node): VoiceNodePayload | null {
  switch (node.type) {
    case 'linkCard': {
      const data = node.data as LinkCardData
      const title = trimOrEmpty(data.title) || trimOrEmpty(data.url)
      const description =
        trimOrEmpty(data.contentDescription) ||
        trimOrEmpty(data.description) ||
        trimOrEmpty(data.tweetText) ||
        trimOrEmpty(data.transcript) ||
        trimOrEmpty(data.url)
      const contentType = trimOrEmpty(data.type) || 'link'
      if (!title || !description) return null
      return { title, contentDescription: description, contentType }
    }
    case 'textCard': {
      const text = trimOrEmpty((node.data as TextCardData).text)
      if (!text) return null
      const firstLine = text.split('\n')[0]
      const title =
        firstLine.length > TEXT_TITLE_MAX
          ? `${firstLine.slice(0, TEXT_TITLE_MAX)}…`
          : firstLine
      return { title, contentDescription: text, contentType: 'text' }
    }
    case 'imageCard': {
      const data = node.data as ImageCardData
      const title = trimOrEmpty(data.label) || trimOrEmpty(data.fileName)
      if (!title) return null
      return {
        title,
        contentDescription: `Image titled "${title}".`,
        contentType: 'image',
      }
    }
    case 'pdfCard': {
      const data = node.data as PdfCardData
      const title = trimOrEmpty(data.label) || trimOrEmpty(data.fileName)
      if (!title) return null
      const pages = data.pageCount
        ? `${data.pageCount} ${data.pageCount === 1 ? 'page' : 'pages'}`
        : 'a PDF document'
      return {
        title,
        contentDescription: `PDF titled "${title}" (${pages}).`,
        contentType: 'pdf',
      }
    }
    default:
      return null
  }
}
