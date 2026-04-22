/**
 * Shown on cold start when no cache is available — user is on a
 * fresh device or has cleared storage. Renders a soft shimmer over
 * the canvas area while the first Supabase fetch completes. Swapped
 * out for the real ReactFlow canvas as soon as the store hydrates.
 */
export function CanvasSkeleton() {
  return (
    <div
      className="w-screen h-screen flex items-center justify-center bg-gray-50"
      role="status"
      aria-label="Loading canvas"
    >
      <div className="flex flex-col items-center gap-3">
        <div className="w-10 h-10 rounded-full border-2 border-gray-200 border-t-gray-400 animate-spin" />
        <p className="text-sm text-gray-400 font-light select-none">
          Loading your canvas…
        </p>
      </div>
    </div>
  )
}
