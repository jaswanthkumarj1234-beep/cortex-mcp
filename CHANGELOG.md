# Changelog

All notable changes to Cortex MCP Server are documented here.

## [1.0.1] -- 2026-02-19

### Fixed
- **FTS5 indexing** -- Triggers were silently failing to index memories for search
- **Emoji removal** -- All emojis removed from source code for professional terminal output
- **SECURITY.md port** -- Documented port corrected from 3100 to 3456
- **CONTRIBUTING.md** -- Fixed `npm run dev` to `npm run watch`
- **Config leak** -- Added `bin/` and `.ai/` to `.gitignore` and `.npmignore`

### Added
- **Soak testing** -- 500-operation stability test (1800+ ops/sec, 0 failures)
- **Binary builds** -- `scripts/build-binaries.js` for standalone executables
- **CI/CD pipeline** -- `.github/workflows/release.yml` for automated releases
- **Value verification** -- `scripts/value-test.js` proves cross-session memory recall
- **Performance stats** -- Added to README (<1ms latency, 1800+ ops/sec)
- **Direct download** -- README Option 3 for binary downloads

## [1.0.0] -- 2026-02-18

### Added
- **`force_recall` tool** — Mandatory context injection at conversation start
- **`quick_store` tool** — One-sentence memory storage with auto-classification
- **`store_memory` / `recall_memory`** — Full memory CRUD with type, tags, reason
- **`update_memory` / `delete_memory` / `list_memories`** — Memory management
- **`auto_learn` tool** — Extracts decisions and patterns from AI responses
- **`verify_code` tool** — Detects hallucinated imports, exports, env variables
- **`verify_files` tool** — Catches hallucinated file paths
- **`scan_project` tool** — Scans project structure, stack, and git history
- **`get_context` tool** — Compressed context for current file
- **`get_stats` / `health_check`** — Database and server diagnostics
- **`export_memories` / `import_memories`** — JSON bundle export/import with dedup
- **Git auto-capture** — `post-commit` hook classifies every commit as a memory
- **Branch/merge capture** — `post-checkout` and `post-merge` hooks track workflow
- **Build error capture** — `cortex-run` wrapper captures test/build failures
- **Optional LLM enhancement** — OpenAI/Anthropic/compatible APIs for smarter classification
- **Web dashboard** — localhost:3456 with memory viewer, search, export
- **`cortex-setup` CLI** — Auto-configures Antigravity, Claude, Cursor, Copilot, Windsurf, Zed
- **CLI routing** — `npx @cortex-mcp/server setup` and `--version` subcommands
- **Quality gates** — Junk rejection, contradiction detection, deduplication
- **Rate limiting** — 30 stores, 100 auto-learns, 500 calls per session
- **Memory decay** — Stale/low-quality memories cleaned automatically
- **Crash protection** — `uncaughtException` and `unhandledRejection` handlers
- **Degraded mode** — Server reports errors instead of crashing if DB init fails

### Technical
- SQLite-backed persistence with FTS5 full-text search
- MiniLM-L6-v2 semantic embeddings via `@xenova/transformers` (background worker)
- Hybrid retrieval: semantic similarity + keyword FTS + recency scoring
- Direct SQLite hooks for sub-500ms git hook execution
- Optional LLM with graceful fallback to keyword classification
