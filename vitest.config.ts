import { defineConfig } from 'vitest/config'

/**
 * Test config used only by `npm test`.
 *
 * - `envPrefix` includes `SUPABASE_` so tests can read the service
 *   role key from .env (VITE_* vars are already loaded by default).
 * - `environment: 'node'` — persistence tests are pure HTTP calls
 *   against Supabase; no DOM needed.
 * - `testTimeout` bumped to 30s to tolerate network latency.
 * - `pool: 'forks'` keeps each test file in its own process so
 *   module-level Supabase auth state is isolated per file.
 */
export default defineConfig({
  envPrefix: ['VITE_', 'SUPABASE_'],
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    pool: 'forks',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
})
