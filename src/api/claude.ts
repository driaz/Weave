import type { Node } from '@xyflow/react'
import type { TextCardData } from '../components/TextCardNode'
import type { ImageCardData } from '../components/ImageCardNode'
import type { LinkCardData } from '../components/LinkCardNode'
import type { PdfCardData } from '../components/PdfCardNode'
import type { WeaveMode } from '../types/board'
import { compressBase64Image } from '../utils/imageUtils'

const API_URL = 'https://api.anthropic.com/v1/messages'
const MODEL = 'claude-opus-4-6'

const JSON_FORMAT_INSTRUCTIONS = `You MUST respond with ONLY a valid JSON object. Do not include any text before or after the JSON. Do not include markdown formatting or code fences. Do not explain your reasoning outside the JSON structure. Your entire response must be parseable by JSON.parse().

JSON format:
{"connections":[{"from":"<node-id>","to":"<node-id>","label":"Short relationship name","explanation":"2-3 sentence description of why these are connected and what insight this reveals.","type":"organically chosen category","strength":0.0,"surprise":0.0}]}

strength and surprise are floats from 0.0 to 1.0.
If there are fewer than 2 objects or no meaningful connections exist, return: {"connections":[]}`

const WEAVE_PROMPT = `You are an expert analyst examining objects placed on a spatial canvas. Your job is to identify meaningful, non-obvious relationships between pairs of objects.

Guidelines:
- Only surface connections that reveal genuine insight — things the user likely wouldn't see on their own.
- Do NOT connect everything. Be selective. If two objects have no meaningful relationship, don't force one.
- Focus on surprising, non-obvious connections over obvious ones.
- Let relationship types emerge organically (thematic, causal, contrasting, metaphorical, temporal, structural, etc.) rather than using a fixed taxonomy.
- For each connection, assess how strong the relationship is (strength) and how surprising/non-obvious it is (surprise).
- Keep labels concise (2-5 words). Keep explanations to 2-3 sentences.

${JSON_FORMAT_INSTRUCTIONS}`

const GO_DEEPER_PROMPT = `You are an expert analyst examining objects placed on a spatial canvas. The user has already found some connections between these objects. Your job is to go DEEPER — find subtler, more surprising, second-order, or metaphorical relationships that go beyond what has already been found.

Guidelines:
- Do NOT repeat any of the previously found connections listed below.
- Look for connections that require more thought — hidden patterns, structural parallels, ironic juxtapositions, indirect causal chains.
- Be even more selective than usual. Only surface connections that reveal genuine, non-obvious insight.
- Prioritize surprise over strength. The user wants to see things they couldn't see on their own.
- Let relationship types emerge organically.
- Keep labels concise (2-5 words). Keep explanations to 2-3 sentences.

${JSON_FORMAT_INSTRUCTIONS}`

const FIND_TENSIONS_PROMPT = `You are an expert analyst examining objects placed on a spatial canvas. Your job is to find TENSIONS — contradictions, conflicts, and opposing ideas between these objects.

Guidelines:
- Look specifically for where these objects disagree, clash, or undermine each other.
- Surface opposing viewpoints, logical contradictions, unresolved tensions, and incompatible assumptions.
- Find places where one object's message negates or complicates another's.
- Be selective — only surface genuine tensions, not forced disagreements.
- Let relationship types emerge organically (contradicts, undermines, conflicts with, challenges, opposes, etc.).
- For each tension, assess how strong the conflict is (strength) and how surprising/non-obvious it is (surprise).
- Keep labels concise (2-5 words). Keep explanations to 2-3 sentences.

${JSON_FORMAT_INSTRUCTIONS}`

export type Connection = {
  from: string
  to: string
  label: string
  explanation: string
  type: string
  strength: number
  surprise: number
  mode?: WeaveMode
}

export type WeaveResult = {
  connections: Connection[]
}

type ContentBlock =
  | { type: 'text'; text: string }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

function parseDataUrl(dataUrl: string): {
  mediaType: string
  data: string
} {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!match) {
    return { mediaType: 'image/png', data: dataUrl }
  }
  return { mediaType: match[1], data: match[2] }
}

const PLACEHOLDER_TEXT =
  'Drag me around the canvas. Zoom and pan to explore.'

function isEmptyNode(node: Node): boolean {
  switch (node.type) {
    case 'textCard': {
      const data = node.data as TextCardData
      return !data.text?.trim() || data.text.trim() === PLACEHOLDER_TEXT
    }
    case 'imageCard': {
      const data = node.data as ImageCardData
      return !data.imageDataUrl
    }
    case 'linkCard': {
      const data = node.data as LinkCardData
      return !!data.loading || !data.url
    }
    case 'pdfCard': {
      const data = node.data as PdfCardData
      return !data.pdfDataUrl
    }
    default:
      return true
  }
}

async function serializeNodes(nodes: Node[]): Promise<ContentBlock[]> {
  const content: ContentBlock[] = []

  content.push({
    type: 'text',
    text: `There are ${nodes.length} objects on the canvas. Analyze them and identify meaningful, non-obvious relationships between pairs.\n`,
  })

  for (const node of nodes) {
    switch (node.type) {
      case 'textCard': {
        const data = node.data as TextCardData
        content.push({
          type: 'text',
          text: `[Node ${node.id} — Text Card]:\n"${data.text}"\n`,
        })
        break
      }

      case 'imageCard': {
        const data = node.data as ImageCardData
        const label = data.label || data.fileName
        content.push({
          type: 'text',
          text: `[Node ${node.id} — Image Card] (label: "${label}"):\n`,
        })
        const compressed = await compressBase64Image(data.imageDataUrl)
        const { mediaType, data: base64 } = parseDataUrl(compressed)
        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: base64 },
        })
        break
      }

      case 'linkCard': {
        const data = node.data as LinkCardData
        let description = `[Node ${node.id} — Link Card] (${data.domain}):\n`
        description += `Title: ${data.title}\n`
        if (data.description) description += `Description: ${data.description}\n`
        description += `URL: ${data.url}\n`
        if (data.type === 'twitter' && data.tweetText) {
          description += `Tweet by ${data.authorName || ''} ${data.authorHandle || ''}: "${data.tweetText}"\n`
        }
        if (data.type === 'youtube' && data.authorName) {
          description += `Channel: ${data.authorName}\n`
        }
        content.push({ type: 'text', text: description })
        break
      }

      case 'pdfCard': {
        const data = node.data as PdfCardData
        const label = data.label || data.fileName
        content.push({
          type: 'text',
          text: `[Node ${node.id} — PDF Card] (label: "${label}", ${data.pageCount} ${data.pageCount === 1 ? 'page' : 'pages'}):\n`,
        })
        if (data.thumbnailDataUrl) {
          const compressed = await compressBase64Image(data.thumbnailDataUrl)
          const { mediaType, data: base64 } = parseDataUrl(compressed)
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: base64 },
          })
        }
        break
      }
    }
  }

  return content
}

function getSystemPrompt(mode: WeaveMode): string {
  switch (mode) {
    case 'deeper':
      return GO_DEEPER_PROMPT
    case 'tensions':
      return FIND_TENSIONS_PROMPT
    default:
      return WEAVE_PROMPT
  }
}

function serializePreviousConnections(connections: Connection[]): string {
  if (connections.length === 0) return ''

  const lines = connections.map(
    (c) => `  - [${c.from}] <-> [${c.to}]: ${c.label} — ${c.explanation}`,
  )
  return `\n\nPreviously found connections (do NOT repeat these):\n${lines.join('\n')}\n`
}

export async function analyzeCanvas(
  nodes: Node[],
  mode: WeaveMode = 'weave',
  previousConnections: Connection[] = [],
): Promise<WeaveResult> {
  const apiKey = import.meta.env.VITE_ANTHROPIC_API_KEY as string | undefined

  if (!apiKey) {
    throw new Error(
      'Missing VITE_ANTHROPIC_API_KEY. Add it to your .env file.',
    )
  }

  const contentNodes = nodes.filter(
    (n) =>
      n.type &&
      ['textCard', 'imageCard', 'linkCard', 'pdfCard'].includes(n.type) &&
      !isEmptyNode(n),
  )

  if (contentNodes.length < 2) {
    return { connections: [] }
  }

  const content = await serializeNodes(contentNodes)

  // For "Go Deeper", append previous connections as context in the user message
  if (mode === 'deeper' && previousConnections.length > 0) {
    content.push({
      type: 'text',
      text: serializePreviousConnections(previousConnections),
    })
  }

  const response = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system: getSystemPrompt(mode),
      messages: [{ role: 'user', content }],
    }),
  })

  if (!response.ok) {
    const errorBody = await response.text()
    throw new Error(`Anthropic API error (${response.status}): ${errorBody}`)
  }

  const json = await response.json()

  const textBlock = json.content?.find(
    (block: { type: string }) => block.type === 'text',
  )
  if (!textBlock?.text) {
    throw new Error('No text content in Claude response')
  }

  const rawText = textBlock.text
    .replace(/^```json\n?/, '')
    .replace(/\n?```$/, '')
    .trim()

  let parsed: WeaveResult
  try {
    parsed = JSON.parse(rawText) as WeaveResult
  } catch {
    // Fallback: extract JSON object between first '{' and last '}'
    const start = rawText.indexOf('{')
    const end = rawText.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) {
      throw new Error('Could not find JSON in Claude response')
    }
    parsed = JSON.parse(rawText.slice(start, end + 1)) as WeaveResult
  }

  // Tag each connection with the mode
  parsed.connections = parsed.connections.map((c) => ({ ...c, mode }))

  return parsed
}
