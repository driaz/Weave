# CLAUDE.md — Weave

## Project Overview

Weave is a spatial canvas tool where users drag and drop text cards and images onto a 2D workspace. Claude analyzes the relationships between objects and draws connections between them — visualized like a neural network structure — to help users see relationships they couldn't see on their own. The core idea is to defeat reflexivity: rather than users connecting dots based on their existing assumptions, Claude surfaces unexpected or non-obvious relationships between the objects on the canvas. Built with React, it prioritizes accessibility and simplicity above all else. The UI should be clean and uncluttered, making it effortless for users to zoom in and out of the canvas, select and interact with individual nodes, and rearrange their workspace. May evolve to 3D spatial layouts in the future, but the initial focus is a clean, intuitive 2D experience.

## Tech Stack

- **Framework:** React (Vite for build tooling)
- **Canvas/Interaction:** React Flow (node-based canvas with drag, connect, zoom)
- **Styling:** Tailwind CSS
- **Language:** TypeScript
- **Package Manager:** npm
- **AI Integration:** Anthropic Claude API (for relationship classification between nodes)

## Architecture

```
src/
  components/       # React components (nodes, toolbar, canvas)
  hooks/            # Custom React hooks
  utils/            # Helper functions and shared logic
  types/            # TypeScript type definitions
  styles/           # Global styles and Tailwind config
  api/              # API integration (Claude, future services)
```

The app centers on a single canvas workspace powered by React Flow. Users interact with two primary node types (text cards and image cards). When triggered, Claude analyzes all objects on the canvas, identifies relationships between them, and renders connections (edges) with labels explaining the nature of each relationship — resembling a neural network graph. Users don't manually draw connections; Claude does the thinking.

This structure will evolve. Keep it flat and simple until complexity demands otherwise.

## Coding Style and Conventions

- **Simplicity first.** Prefer the simplest solution that works. Avoid abstraction until repetition demands it.
- **Functional components only.** No class components. Use hooks for state and effects.
- **Named exports** over default exports (except for pages/routes if needed).
- **TypeScript strict mode.** Define types explicitly — avoid `any`.
- **Tailwind for styling.** No inline style objects. No separate CSS files unless absolutely necessary.
- **Descriptive naming.** Components: PascalCase. Functions/variables: camelCase. Files: match the primary export name.
- **Small files.** If a component exceeds ~150 lines, consider splitting it.
- **Co-locate related code.** Tests, types, and helpers that serve a single component live near that component.

## Commands and Workflows

```bash
npm install          # Install dependencies
npm run dev          # Start dev server (Vite)
npm run build        # Production build
npm run lint         # Run ESLint
npm run preview      # Preview production build locally
```

## Constraints and Rules

- **No unnecessary dependencies.** Ask before adding a new package. Prefer built-in browser APIs and existing libraries already in the project.
- **Keep the UI clean.** Minimal chrome, no clutter. White space is a feature. The canvas is the product.
- **Smooth, intuitive interactions.** Zoom in/out, pan, and node selection should feel effortless. Individual nodes must be easy to select, move, edit, and inspect. No interaction should require hunting through menus. The experience should feel playful and fun — users should enjoy moving things around and discovering connections.
- **Accessibility matters.** Use semantic HTML, support keyboard navigation, maintain sufficient color contrast. The tool should feel approachable to non-technical users.
- **Environment variables for secrets.** API keys go in `.env` and never in committed code. Add `.env` to `.gitignore`.
- **Small, focused commits.** One logical change per commit with a clear message.
- **Don't over-engineer.** No state management library (Redux, Zustand) until React's built-in state and context are genuinely insufficient.

## Testing Strategy

- Tests will be added as the project matures. Planned approach:
  - **Vitest** for unit tests
  - **React Testing Library** for component tests
- For now, focus on building working features. Test critical logic (API integration, relationship classification) first when testing begins.

## Claude Interaction Preferences

- Explain your reasoning before making significant changes.
- Prefer small, incremental changes over large rewrites.
- Ask before installing new dependencies.
- When in doubt, choose the simpler approach.
- If something is a judgment call, state the tradeoffs and let me decide.

## Development Environment

- **Editor:** VS Code with Claude Code extension
- **Node:** v20+ (LTS)
- **OS:** macOS (primary development)

## Supabase Environments

Weave uses two separate Supabase projects so you can iterate freely without risking production data:

| Environment | Project name | Project ref | Used by |
| ----------- | ------------ | ----------- | ------- |
| Dev | Weave-Dev | `bxbhjybahfyeqytwpkry` | Local development (`npm run dev`) |
| Prod | Weave | `wndfikmpifyqkgivmnwv` | Netlify deploy (production site) |

- **Local `.env`** (gitignored) points at Weave-Dev. Every drag, save, board creation, RLS check, and RPC call hits dev. See README for the full variable list.
- **Netlify environment variables** point at Weave prod. They override the local `.env` at deploy time.
- **Supabase CLI** is linked to Weave-Dev by default. All `supabase db push` / `supabase gen types` calls from the working tree affect dev.
- On app startup the browser logs `[Weave] Connected to Supabase: <project-ref>` so you can confirm the environment at a glance.
- A subtle `DEV` pill appears in the top-left corner when the app is pointed at the dev project. Absent in production.

### Migration promotion workflow

1. Write a new migration in `supabase/migrations/NNN_short_name.sql`.
2. Test locally: `supabase db push` (CLI is linked to dev → applied to Weave-Dev). Exercise affected flows in the running dev server.
3. When the migration is ready for production:
   ```bash
   supabase link --project-ref wndfikmpifyqkgivmnwv   # link to prod
   supabase db push                                    # apply to prod
   supabase link --project-ref bxbhjybahfyeqytwpkry   # re-link back to dev
   ```
4. **Schema changes go out before the code that depends on them.** Apply the migration to prod first, confirm the prod schema is in the expected state, then merge/deploy the PR that uses it. Doing it in the opposite order creates a window where production code is talking to a stale schema.
5. Double-check the `DEV` pill in the browser after any local re-link to make sure you're still pointing at dev.

### Regenerating the TypeScript schema

```bash
npx supabase gen types typescript --linked > src/types/database.ts
```

Run this whenever a migration adds or changes tables / functions / enums so the typed `SupabaseClient<Database>` reflects reality. Commit the regenerated file.

See [`MIGRATIONS.md`](MIGRATIONS.md) for the full inventory of applied migrations and their purpose.

## Future Considerations (not yet implemented)

- 3D spatial layout option (Three.js or React Three Fiber)
- Additional node types beyond text and images
- Relationship type taxonomy (to be developed organically — not borrowing from prior projects)
- Collaboration / sharing features