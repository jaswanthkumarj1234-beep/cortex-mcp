# Cortex MCP — Copilot Instructions

> IMPORTANT: Before answering any coding question, ALWAYS call `recall_memory` to check for relevant past context.

## Project Rules
- Use TypeScript strict mode for all new files
- All hooks must fail silently (never block git)
- Every new tool must have an enterprise test
- No external LLM API dependencies in core (optional only)
- Console output goes to stderr in MCP mode (stdout = JSON-RPC only)