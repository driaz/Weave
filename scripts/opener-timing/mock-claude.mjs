// Mock of the /api/claude streaming proxy for scripts/opener-timing.
//
// Replays a canned opener as Anthropic-shaped SSE with a fixed time-to-first-
// token and a steady character rate. It exists because a cloud session holds
// no Anthropic key and the Fly proxy only accepts prod JWTs. The TTFT it
// reports is therefore an input, not a measurement: use it to time everything
// AROUND Claude (snapshot/retrieval, segmenter, TTS). Defaults come from prod
// opener telemetry (2026-10-24 .. 11-17): median request→first text ≈ 2.3 s,
// ≈ 68 tok/s ≈ 270 chars/s after that.
//
//   node scripts/opener-timing/mock-claude.mjs [--port 8787] [--ttft 2300] [--cps 270]

import http from 'node:http'
import { parseArgs } from 'node:util'

const { values } = parseArgs({
  options: {
    port: { type: 'string', default: '8787' },
    ttft: { type: 'string', default: '2300' },
    cps: { type: 'string', default: '270' },
  },
})
const PORT = Number(values.port)
const TTFT_MS = Number(values.ttft)
const CHARS_PER_SEC = Number(values.cps)

// Shaped like a real opener: a ~55-char first sentence, then longer ones.
const OPENER =
  'Notice what the clip actually does with suffering. ' +
  'It treats the pain as evidence that the plan is working, which is a claim the chart on the other card quietly contradicts. ' +
  'The chart shows the cost arriving first and the payoff never arriving at all, at least not inside the window it measures. ' +
  "So the two pieces aren't really arguing about effort; they're arguing about whether the future is allowed to vouch for the present. " +
  'Which of those two stories were you already leaning toward when you put them next to each other?'

const sse = (res, obj) => res.write(`event: ${obj.type}\ndata: ${JSON.stringify(obj)}\n\n`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.writeHead(204).end()
  if (req.method !== 'POST' || !req.url?.startsWith('/api/claude')) return res.writeHead(404).end()
  for await (const _ of req); // drain body

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
  sse(res, {
    type: 'message_start',
    message: { usage: { input_tokens: 8, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 } },
  })
  await sleep(TTFT_MS)
  sse(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
  const step = 4 // chars per delta, about one token
  for (let i = 0; i < OPENER.length; i += step) {
    if (res.destroyed) return
    sse(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: OPENER.slice(i, i + step) } })
    await sleep((step / CHARS_PER_SEC) * 1000)
  }
  sse(res, { type: 'content_block_stop', index: 0 })
  sse(res, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: Math.ceil(OPENER.length / 4) } })
  sse(res, { type: 'message_stop' })
  res.end()
})

server.listen(PORT, () => console.log(`[mock-claude] :${PORT} ttft=${TTFT_MS}ms cps=${CHARS_PER_SEC}`))
