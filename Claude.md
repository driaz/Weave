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

## Future Considerations (not yet implemented)

- 3D spatial layout option (Three.js or React Three Fiber)
- Additional node types beyond text and images
- Relationship type taxonomy (to be developed organically — not borrowing from prior projects)
- Collaboration / sharing features