import { useEffect, useState } from 'react'
import {
  getLastHydrationSource,
  type HydrationSourceRecord,
} from '../persistence/syncLogger'

/**
 * Dev-only pill showing where the current canvas state was loaded
 * from. Reads the last hydration record from the syncLogger; updates
 * live via the `weave:hydration-source` custom event. Renders nothing
 * in production — the tree-shake leaves no footprint.
 */
export function HydrationSourceIndicator() {
  const [record, setRecord] = useState<HydrationSourceRecord | null>(
    () => getLastHydrationSource(),
  )

  useEffect(() => {
    if (!import.meta.env.DEV) return
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<HydrationSourceRecord>).detail
      if (detail) setRecord(detail)
    }
    window.addEventListener('weave:hydration-source', handler)
    return () => window.removeEventListener('weave:hydration-source', handler)
  }, [])

  if (!import.meta.env.DEV) return null
  if (!record) return null

  const tone =
    record.source === 'supabase'
      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
      : record.source === 'localStorage'
        ? 'bg-amber-50 border-amber-200 text-amber-800'
        : 'bg-gray-50 border-gray-200 text-gray-600'

  return (
    <div
      className={`fixed bottom-2 left-1/2 -translate-x-1/2 z-40 px-2.5 py-1 rounded-full border text-[10px] font-mono shadow-sm ${tone}`}
      role="status"
      aria-label={`Hydrated from ${record.source}`}
      title={`${record.timestamp} — ${record.reason}`}
    >
      hydrated from {record.source}
      {record.reason ? ` — ${record.reason}` : ''}
    </div>
  )
}
