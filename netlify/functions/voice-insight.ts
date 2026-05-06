// Generates a spoken-style insight about a connection between two nodes on
// the canvas. Called by the client when the user taps the voice button on a
// connection card. The returned text is plain spoken prose (no markdown,
// no lists) and gets piped to ElevenLabs TTS by the client.
//
// Synchronous request/response — streaming will come later once the Netlify
// timeout story is sorted.

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages'
const CLAUDE_MODEL = 'claude-opus-4-7'
const CLAUDE_MAX_TOKENS = 500

const SYSTEM_PROMPT = `You are an analytical companion reflecting on a connection between two pieces
of content someone has collected on a personal creative board. You've studied
the board. You have specific observations.

Your voice is that of a sharp, intellectually curious thinker — someone who
has actually sat with the material and noticed something worth saying. You
are not a narrator. You are not summarizing. You are making an argument about
what this connection reveals.

Structure your response as a single spoken arc — 5 to 7 sentences:
- Open by naming the tension, pattern, or structural move you see.
- Build the argument. What are these two pieces doing that's the same,
  or doing that contradicts each other?
- Turn it. Say the thing the person probably hasn't considered.
- Close with a question that lingers — not rhetorical, genuinely open.

The question at the end matters. Even though the listener can't respond yet,
it should change how they see the connection after the audio stops.

What makes this work:
- Notice what the pieces DO, not just what they're ABOUT.
- Say something the connection explanation doesn't already say.
  You have the explanation as context — don't restate it in fancier words.
  Your job is to go ONE LEVEL DEEPER.
- Be falsifiably specific. If your observation could apply to any two
  pieces of content, it's not an observation.
- Speak in your own analytical voice. Don't match the emotional register
  of the content. A connection about existential dread gets the same
  measured, precise tone as one about absurdist comedy.
- Occasional dry wit is good. Overwrought language is not.

What NOT to do:
- Don't open with "What a fascinating connection" or any throat-clearing.
- Don't narrate what you're about to do ("Let me walk you through...").
- Don't be therapeutic ("and how does that make you feel?").
- Don't use transitional filler ("Now, interestingly...", "It's worth noting...").
- Don't list observations. This is a spoken arc, not bullet points read aloud.
- Don't hedge with "perhaps" or "it could be argued" — have a stance.
- No markdown, asterisks, or any formatting. Plain spoken text only.

You've been thinking about this. Start mid-thought.`

type NodeInput = {
  title?: string
  contentDescription?: string
  contentType?: string
}

type RequestBody = {
  connectionLabel?: string
  connectionExplanation?: string
  node1?: NodeInput
  node2?: NodeInput
}

function buildUserMessage(body: Required<RequestBody>): string {
  const { connectionLabel, connectionExplanation, node1, node2 } = body
  return `Here's the connection to reflect on:

Connection label: ${connectionLabel}
Connection explanation: ${connectionExplanation}

Node 1 (${node1.contentType}): ${node1.title}
${node1.contentDescription}

Node 2 (${node2.contentType}): ${node2.title}
${node2.contentDescription}

Speak about what this connection reveals.`
}

function isValidNode(node: NodeInput | undefined): node is Required<NodeInput> {
  return Boolean(
    node &&
      typeof node.title === 'string' &&
      node.title.trim() &&
      typeof node.contentDescription === 'string' &&
      node.contentDescription.trim() &&
      typeof node.contentType === 'string' &&
      node.contentType.trim(),
  )
}

export default async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }
  if (req.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 })
  }

  const apiKey = process.env.VITE_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    return Response.json(
      { insight: '', error: 'ANTHROPIC_API_KEY not configured on server' },
      { status: 200 },
    )
  }

  let body: RequestBody
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const connectionLabel = body.connectionLabel?.trim() ?? ''
  const connectionExplanation = body.connectionExplanation?.trim() ?? ''
  if (
    !connectionLabel ||
    !connectionExplanation ||
    !isValidNode(body.node1) ||
    !isValidNode(body.node2)
  ) {
    return Response.json(
      {
        error:
          'connectionLabel, connectionExplanation, node1 and node2 are required (each node needs title, contentDescription, contentType)',
      },
      { status: 400 },
    )
  }

  const userMessage = buildUserMessage({
    connectionLabel,
    connectionExplanation,
    node1: body.node1,
    node2: body.node2,
  })

  try {
    const response = await fetch(CLAUDE_API_URL, {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
    })

    if (!response.ok) {
      const errBody = await response.text()
      console.warn(
        `[voice-insight] claude api failed status=${response.status} label=${connectionLabel}`,
      )
      return Response.json(
        {
          insight: '',
          error: `HTTP ${response.status}: ${errBody.slice(0, 200)}`,
        },
        { status: 200 },
      )
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const insight = data.content?.[0]?.text?.trim() ?? ''
    if (!insight) {
      console.warn(`[voice-insight] empty response label=${connectionLabel}`)
      return Response.json(
        { insight: '', error: 'no text in response' },
        { status: 200 },
      )
    }

    console.log(
      `[voice-insight] ok label=${connectionLabel} length=${insight.length}`,
    )
    return Response.json({ insight }, { status: 200 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[voice-insight] error label=${connectionLabel} err=${message}`)
    return Response.json({ insight: '', error: message }, { status: 200 })
  }
}
