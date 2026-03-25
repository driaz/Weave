import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { backfillEmbeddings } from './utils/backfillEmbeddings'

// Expose backfill utility on window for console access:
//   window.backfillEmbeddings()
;(window as unknown as Record<string, unknown>).backfillEmbeddings =
  backfillEmbeddings

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
