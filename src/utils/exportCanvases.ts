import { keys as idbKeys, get as idbGet } from 'idb-keyval'
import { createStore } from 'idb-keyval'

/**
 * Pre-cutover safety export: dumps the full localStorage
 * `weave-boards` store plus every blob in `weave-binary-db` into a
 * single JSON file the user can download. Restores are manual —
 * paste the JSON back into localStorage + IndexedDB via devtools.
 *
 * Called from UserMenu → "Export all canvases" before the user
 * trusts the cutover. If the Supabase sync has a bug, this is the
 * rollback insurance.
 */

const STORAGE_KEY = 'weave-boards'
const BINARY_DB = 'weave-binary-db'
const BINARY_STORE = 'binary-data'

type ExportBundle = {
  version: 1
  exportedAt: string
  localStorage: unknown
  indexedDB: Record<string, string>
}

export async function buildExportBundle(): Promise<ExportBundle> {
  const raw = localStorage.getItem(STORAGE_KEY)
  const parsed = raw ? JSON.parse(raw) : null

  const binaryStore = createStore(BINARY_DB, BINARY_STORE)
  const allKeys = await idbKeys(binaryStore)
  const indexedDB: Record<string, string> = {}
  await Promise.all(
    allKeys.map(async (key) => {
      if (typeof key !== 'string') return
      const value = await idbGet<string>(key, binaryStore)
      if (typeof value === 'string') indexedDB[key] = value
    }),
  )

  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    localStorage: parsed,
    indexedDB,
  }
}

export async function downloadCanvasExport(): Promise<void> {
  const bundle = await buildExportBundle()
  const blob = new Blob([JSON.stringify(bundle, null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  a.download = `weave-canvases-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  // Give the download a tick to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
