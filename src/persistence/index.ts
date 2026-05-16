import * as boards from './boards'
import * as nodes from './nodes'
import * as edges from './edges'
import * as voiceSessions from './voiceSessions'
import * as voiceUtterances from './voiceUtterances'
import * as media from './media'

/**
 * Weave persistence layer — Supabase CRUD for canvas data.
 *
 * Usage:
 *   import { persistence } from '@/persistence'
 *   const board = await persistence.boards.create({ name: 'Untitled' })
 *
 * `user_id` is injected automatically from the active Supabase session;
 * callers never pass it. `create` inputs omit server-generated fields
 * (id, created_at, updated_at). See README.md for details.
 */
export const persistence = {
  boards: {
    list: boards.list,
    get: boards.get,
    create: boards.create,
    update: boards.update,
    delete: boards.remove,
  },
  nodes: {
    listByBoard: nodes.listByBoard,
    get: nodes.get,
    create: nodes.create,
    update: nodes.update,
    delete: nodes.remove,
    batchUpdate: nodes.batchUpdate,
    batchCreate: nodes.batchCreate,
  },
  edges: {
    listByBoard: edges.listByBoard,
    create: edges.create,
    update: edges.update,
    delete: edges.remove,
    batchCreate: edges.batchCreate,
    deleteByBoard: edges.deleteByBoard,
  },
  voiceSessions: {
    createSession: voiceSessions.createSession,
    endSession: voiceSessions.endSession,
    getSession: voiceSessions.getSession,
  },
  voiceUtterances: {
    writeUtterance: voiceUtterances.writeUtterance,
    updateUtteranceEmbedding: voiceUtterances.updateUtteranceEmbedding,
    listUtterancesBySession: voiceUtterances.listUtterancesBySession,
  },
  media: {
    upload: media.upload,
    getSignedUrl: media.getSignedUrl,
    delete: media.remove,
  },
}

export { detectSentinel } from './voiceUtterances'

export type {
  Board,
  Node,
  Edge,
  VoiceSession,
  VoiceUtterance,
  NewBoardInput,
  NewNodeInput,
  NewEdgeInput,
  NewVoiceSessionInput,
  NewVoiceUtteranceInput,
  Speaker,
  EndReason,
  VoiceSessionEndPatch,
  WriteUtteranceContext,
  WriteUtteranceResult,
  SentinelEvent,
  BoardSnapshot,
} from './types'

export {
  PersistenceError,
  NetworkError,
  AuthError,
  NotFoundError,
  PermissionError,
  ValidationError,
} from './errors'
