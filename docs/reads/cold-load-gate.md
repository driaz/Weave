# Read: cold-load save-gate drop window

Branch `fix/cold-load-gate`, cut from `origin/main` @ `dec86a5` (fetched 2026-11-13).

## Code path, in call order

1. **Mount, warm cache.** `useBoardStorage` (`src/hooks/useBoardStorage.ts:165-178`) seeds the store
   from `buildStoreFromCache()` (`src/persistence/hydration.ts`). `hydrating` starts `false`, so the
   canvas renders from the cache straight away and looks editable. `App.tsx:101` seeds React `nodes`
   from `currentBoard.nodes`.
2. **Boot fetch.** The bootstrap effect (`useBoardStorage.ts:245-334`) calls
   `fetchFromSupabase(lastActiveBoard)` (`hydration.ts:349`):
   `boards.list()` → `loadFullStateFromSupabase` (`hydration.ts:240`), which loads **every board**
   in one `Promise.all`. Each board does `nodes.listByBoard` + `edges.listByBoard` in parallel, then
   `boardFromSupabase` → `nodeFromSupabase` per node, which **awaits a signed-URL request per
   image/link-image node** (`hydration.ts:121-127, 135-144`). The function resolves only when the
   slowest board, including its signed URLs, is done.
3. **Gate.** `createSaveGate` (`src/hooks/saveGate.ts`) keeps one open flag per board.
   `saveCurrentBoard` (`useBoardStorage.ts:399`) calls `saveGate.decide`; a closed board means
   `dropped-before-fetch`. The drop is counted per path and logged with **`console.debug` only**:
   `[Weave sync] save dropped before first fetch — path=… board=…` (`saveGate.ts:64-67`). Nothing
   is queued.
4. **Add button.** Every add path (`App.tsx` drop/paste/add handlers) calls `generateNodeId()` and
   `setNodes(prev => [...prev, node])`. That changes `nodes`, and the debounced save effect
   (`App.tsx:259-274`, 500 ms, skipped only while `hydrating`) calls
   `saveCurrentBoard(…, 'debounce')`, which is dropped. A move goes through
   `onNodesChange` → `applyNodeChanges` → the same debounce, and is dropped too.
5. **Fetch resolves.** `storeAfterBootFetch` keeps the user's mid-fetch board switch. Then
   `saveGate.markFetched(all board ids)`, `setStore(fetched)` (unconditional replace), and
   `hydrationRevision++` (warm boot only).
6. **Reseed.** The `App.tsx:195-239` effect sees `revalidated`, then
   `setNodes(currentBoard.nodes)` (server state) and `markBoardClean(server state)`.
   **This is the point where the card is lost**: React state is overwritten with server nodes, and
   the card never reached the server because its saves were dropped in step 4.

## Matches the diagnosis of record?

Yes, by code. Within the window between first render and the all-boards fetch resolving, every edit
on any board is dropped and then overwritten. Two more facts from the code:

- The window is the **slowest** board's load, not the current board's, plus serial signed-URL
  round trips inside each board's `Promise.all`.
- The store only ever advances on a successful save (`useBoardStorage.ts:445`), and no save can
  happen before the gate opens. So during the window, the store's copy of a board is still exactly
  the cache seed. Any React node that is in neither that seed nor the fetched board was created in
  this page load. Build (b) uses this definition.

## Dev repro (2026-11-13, Weave-Dev, Test Board 4, warm cache)

Dev's natural window is about 1.5 s, which is too short to act inside through browser automation.
A temporary `?bootDelay=N` hook delayed the boot fetch to approximate prod's measured 9.5 s. It was
removed before the commit. Times are ms after navigation (`performance.now()`).

**Before (main):** cache render, then card added at 252, moved at 6038, then
`save dropped before first fetch — path=debounce … (1)` and `… (2)`. No save request left. The
fetch resolved and all four gates opened together at 16966, when the slowest board (Test Board 2)
finished; the current board itself had finished at 16568. Node count went 4 → 3, so **the card was
gone**. Matches the diagnosis.

**Control (main): add in the window, move deferred past the fetch.** The card was gone at the
fetch: 4 → 3 nodes before any move happened. **This contradicts the premise** that deferring the
move keeps the card. The move is irrelevant; the add being inside the window is enough. Daniel's
third attempt most likely worked because the add itself came after the fetch. Checked directly:
adding after the fetch, then moving, persists across a reload (4 nodes).

**After (branch):** card added and moved at 392, giving one drop line (the add and the move fall in
one debounce burst). Then `gate opened Test Board 4` at 10818,
`kept 1 node(s) created before the first fetch — ids=19`, `supabase success`, and the other three
gates opened at 11821 / 11841 / 11971. Node count stayed at 5, and **5 after a plain reload**: the
card reached the server. Board switch out and back afterwards: 8 nodes, then 5. No console errors
on a clean load.

The drop line inside the window still appears after the fix. That is correct under decision 1 (the
gate stays). The expectation of "zero dropped-save lines" in the after repro **does not hold** for an
edit made before the current board lands; the card is kept and saved after the gate opens instead.

## Measurement (decision 4): cold load, warm cache, dev, no delay

| board | nodes | edges | rows (nodes+edges, ms) | assemble incl. signed URLs (ms) | node bytes | edge bytes |
|---|---|---|---|---|---|---|
| Test Board 3 | 8 | 28 | 399 / 444 | 416 / 368 | 18,206 | 24,491 |
| Test Board | 12 | 36 | 429 / 443 | 642 / 380 | 24,908 | 30,812 |
| Test Board 2 | 11 | 29 | 464 / 437 | 607 / 1,137 | 33,791 | 25,089 |
| Test Board 4 (current) | 3 | 3 | 386 / 438 | 712 / 741 | 7,641 | 2,673 |

Two runs per cell. `boards.list` took 277–403 ms. The heaviest JSONB keys per board were
`processing_log` (1.9–6.6 KB), `media_analysis` (up to 4.5 KB), `embedHtml` (up to 3.6 KB) and
`contentDescription` (up to 2.7 KB).

**Reading:**
- Bytes are not the driver. The largest board is 59 KB in total, and row reads are a flat
  ~400 ms whatever the board size: 3-node and 12-node boards take the same time, so it is latency,
  not transfer.
- The time goes to (1) the board list, (2) one round of row reads, and (3) assembly, which for
  every image or link-image node awaits a signed-URL request. Assembly is as large as or larger
  than the row reads, and it is the variable part (368–1,137 ms).
- The old all-boards wait also tied the current board to the slowest board.
- **(c) is not built.**

After (a) on dev with no delay, the current board's gate opens at about 950 ms, against about
1,850 ms for the last board.

Prod's ~9.5 s cannot be decomposed from here (no prod access from this session). If it is mostly
signed URLs on boards with many media nodes, the next lever is one batched `createSignedUrls` per
board, or deferring signed URLs. That is outside this PR's decisions and is filed as a finding.

## Other findings
- The mount debounce still logs one drop per warm load with no edits. This is pre-existing (#68)
  and unchanged.
- A board created during the window (`createBoard` before the list lands) is still dropped from the
  store when the list arrives, as on main. Not widened here.
