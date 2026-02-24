export type LinkMetadata = {
  url: string
  title: string
  description: string
  imageUrl: string
  domain: string
  type: 'generic' | 'twitter' | 'youtube'
  authorName?: string
  authorHandle?: string
  tweetText?: string
}

export function isUrl(text: string): boolean {
  try {
    const url = new URL(text.trim())
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

export function extractDomain(urlString: string): string {
  try {
    return new URL(urlString.trim()).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

export function isTwitterUrl(url: string): boolean {
  try {
    const hostname = new URL(url.trim()).hostname.replace(/^www\./, '')
    return hostname === 'twitter.com' || hostname === 'x.com'
  } catch {
    return false
  }
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const hostname = new URL(url.trim()).hostname.replace(/^www\./, '')
    return (
      hostname === 'youtube.com' ||
      hostname === 'youtu.be' ||
      hostname === 'm.youtube.com'
    )
  } catch {
    return false
  }
}

export function extractYouTubeVideoId(url: string): string | null {
  try {
    const parsed = new URL(url.trim())
    const hostname = parsed.hostname.replace(/^www\./, '')

    if (hostname === 'youtu.be') {
      return parsed.pathname.slice(1) || null
    }

    if (hostname === 'youtube.com' || hostname === 'm.youtube.com') {
      const v = parsed.searchParams.get('v')
      if (v) return v

      const shortsMatch = parsed.pathname.match(/^\/shorts\/([^/?]+)/)
      if (shortsMatch) return shortsMatch[1]
    }

    return null
  } catch {
    return null
  }
}

function stripHtmlTags(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim()
}

function extractHandleFromUrl(authorUrl: string): string {
  try {
    const pathname = new URL(authorUrl).pathname
    return '@' + pathname.replace(/^\//, '')
  } catch {
    return ''
  }
}

async function fetchTwitterMetadata(url: string): Promise<LinkMetadata> {
  const trimmedUrl = url.trim()
  const domain = extractDomain(trimmedUrl)

  try {
    const response = await fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(trimmedUrl)}&omit_script=true`,
    )
    const json = await response.json()

    const authorName = json.author_name || ''
    const authorHandle = json.author_url
      ? extractHandleFromUrl(json.author_url)
      : ''
    const tweetText = json.html ? stripHtmlTags(json.html) : ''

    return {
      url: trimmedUrl,
      title: authorName || domain,
      description: tweetText,
      imageUrl: '',
      domain,
      type: 'twitter',
      authorName,
      authorHandle,
      tweetText,
    }
  } catch {
    // Fall through to Microlink
  }

  return fetchMicrolinkMetadata(trimmedUrl)
}

async function fetchYouTubeMetadata(url: string): Promise<LinkMetadata> {
  const trimmedUrl = url.trim()
  const domain = extractDomain(trimmedUrl)
  const videoId = extractYouTubeVideoId(trimmedUrl)

  try {
    const response = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(trimmedUrl)}&format=json`,
    )
    const json = await response.json()

    const thumbnailUrl = videoId
      ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
      : ''

    return {
      url: trimmedUrl,
      title: json.title || domain,
      description: '',
      imageUrl: thumbnailUrl,
      domain,
      type: 'youtube',
      authorName: json.author_name || '',
    }
  } catch {
    // Fall through to Microlink
  }

  return fetchMicrolinkMetadata(trimmedUrl)
}

async function fetchMicrolinkMetadata(url: string): Promise<LinkMetadata> {
  const trimmedUrl = url.trim()
  const domain = extractDomain(trimmedUrl)

  try {
    const response = await fetch(
      `https://api.microlink.io?url=${encodeURIComponent(trimmedUrl)}`,
    )
    const json = await response.json()

    if (json.status === 'success' && json.data) {
      const { title, description, image, logo } = json.data
      return {
        url: trimmedUrl,
        title: title || domain,
        description: description || '',
        imageUrl: image?.url || logo?.url || '',
        domain,
        type: 'generic',
      }
    }
  } catch {
    // Network error or JSON parse error — fall through to fallback
  }

  return {
    url: trimmedUrl,
    title: domain || trimmedUrl,
    description: '',
    imageUrl: '',
    domain,
    type: 'generic',
  }
}

export async function fetchLinkMetadata(url: string): Promise<LinkMetadata> {
  const trimmedUrl = url.trim()

  if (isTwitterUrl(trimmedUrl)) {
    return fetchTwitterMetadata(trimmedUrl)
  }

  if (isYouTubeUrl(trimmedUrl)) {
    return fetchYouTubeMetadata(trimmedUrl)
  }

  return fetchMicrolinkMetadata(trimmedUrl)
}
