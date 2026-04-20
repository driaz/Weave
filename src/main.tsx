import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
} from 'react-router-dom'
import './index.css'
import { App } from './App'
import { AuthProvider } from './auth/AuthContext'
import { ProtectedRoute } from './auth/ProtectedRoute'
import { Login } from './pages/Login'
import { AuthCallback } from './pages/AuthCallback'
import { backfillEmbeddings } from './utils/backfillEmbeddings'
import './utils/backfillTweetEmbeds'
import './utils/backfillTweetImages'
import './utils/backfillTranscripts'

// Expose backfill utility on window for console access:
//   window.backfillEmbeddings()
;(window as unknown as Record<string, unknown>).backfillEmbeddings =
  backfillEmbeddings

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/auth/callback" element={<AuthCallback />} />
          <Route
            path="/"
            element={
              <ProtectedRoute>
                <App />
              </ProtectedRoute>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
)
