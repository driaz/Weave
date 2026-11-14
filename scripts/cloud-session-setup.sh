#!/bin/bash
# SessionStart hook (.claude/settings.json): install dependencies in
# Claude Code cloud sessions, which start from a fresh clone.
# Local sessions exit immediately and are never touched.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
npm ci --no-audit --no-fund
(cd media-server && npm ci --no-audit --no-fund)
