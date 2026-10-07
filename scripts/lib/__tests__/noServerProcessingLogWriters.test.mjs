import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * T5 (migration 043): no server source writes processing_log into
 * nodes.data. Server = Fly (media-server/src), Netlify (netlify/), and
 * service-role operator scripts (scripts/). nodes.data.processing_log is
 * client-owned; server entries go to node_processing_log through
 * append_node_processing_log.
 *
 * The patterns are the three shapes the pre-043 writers actually took:
 * calling the 021 RPC by name, putting processing_log in an object as a
 * key, and a jsonb_set path into it. They deliberately don't match the
 * table/RPC name (node_processing_log) or a string value such as
 * intended_key: 'processing_log'.
 */

const SERVER_ROOTS = ['media-server/src', 'netlify', 'scripts']

const FORBIDDEN = [
  { name: '021 RPC call', re: /['"`]append_processing_log['"`]/ },
  { name: 'processing_log object key', re: /(?<![\w.])['"]?processing_log['"]?\s*:/ },
  { name: 'jsonb_set path', re: /\{processing_log\}/ },
]

function violations(source) {
  return FORBIDDEN.filter((f) => f.re.test(source)).map((f) => f.name)
}

describe('T5: no residual server writers to nodes.data.processing_log', () => {
  it('the patterns catch every pre-043 writer shape', () => {
    expect(violations("admin.rpc('append_processing_log', { p_client_id: nodeId })")).toContain('021 RPC call')
    expect(violations("patch: { processing_log: [entry] }")).toContain('processing_log object key')
    expect(violations("p_patch: { 'processing_log': [] }")).toContain('processing_log object key')
    expect(violations("jsonb_set(data, '{processing_log}', x)")).toContain('jsonb_set path')
    expect(violations("rpc('append_node_processing_log', { p_detail: { intended_key: 'processing_log' } })")).toEqual([])
  })

  it('no server source file matches', () => {
    const files = execFileSync('git', ['ls-files', '--', ...SERVER_ROOTS], { encoding: 'utf8' })
      .split('\n')
      .filter((f) => /\.(ts|mts|js|mjs|cjs|sql)$/.test(f) && !f.includes('/__tests__/'))
    expect(files.length).toBeGreaterThan(20)
    const hits = files
      .map((f) => ({ f, v: violations(readFileSync(f, 'utf8')) }))
      .filter((h) => h.v.length > 0)
    expect(hits).toEqual([])
  })
})
