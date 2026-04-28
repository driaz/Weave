// Side-effect import — must come before any module that reads process.env at
// load time (auth.ts, supabase.ts, analyze.ts, embed.ts all throw on missing
// vars). On Fly the env comes from `fly secrets`, so .env is absent and
// dotenv silently no-ops; locally it loads media-server/.env from cwd.
import 'dotenv/config'

import Fastify from 'fastify'
import sensible from '@fastify/sensible'
import { verifyUserToken } from './auth.js'
import { processMedia } from './process.js'

const PORT = Number(process.env.PORT ?? 3000)

const app = Fastify({ logger: true })
await app.register(sensible)

app.get('/health', async () => ({ status: 'ok' }))

interface ProcessBody {
  node_id: string
  board_id: string
  url: string
  node_type: 'youtube' | 'twitter'
}

app.post<{ Body: ProcessBody }>('/process', async (req, reply) => {
  const auth = req.headers.authorization
  if (!auth?.startsWith('Bearer ')) {
    return reply.unauthorized('missing bearer token')
  }
  const userId = await verifyUserToken(auth.slice('Bearer '.length))
  if (!userId) return reply.unauthorized('invalid token')

  const { node_id, board_id, url, node_type } = req.body ?? ({} as ProcessBody)
  if (!node_id || !board_id || !url || !node_type) {
    return reply.badRequest('node_id, board_id, url, node_type required')
  }
  if (node_type !== 'youtube' && node_type !== 'twitter') {
    return reply.badRequest('node_type must be youtube or twitter')
  }

  // Fire-and-forget. Errors are logged inside processMedia; the client
  // doesn't wait — the embedding + media_analysis land async via Supabase.
  processMedia({ nodeId: node_id, boardId: board_id, url, nodeType: node_type, userId })
    .catch((err) => app.log.error({ err, nodeId: node_id }, 'processMedia failed'))

  return reply.code(202).send({ accepted: true })
})

await app.listen({ host: '0.0.0.0', port: PORT })
