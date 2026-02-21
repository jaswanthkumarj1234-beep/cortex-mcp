# Contributing to Cortex MCP

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

```bash
git clone https://github.com/jaswanthkumarj1234-beep/cortex-mcp.git
cd cortex-mcp
npm install
npm run build
npm test
```

## Running Locally

```bash
npm run watch  # Watch mode (recompiles on changes)
npm test       # Unit tests
npm run test:enterprise  # Full enterprise test suite
```

## Project Structure

```
src/
├── cli/         # CLI tools (setup, etc.)
├── db/          # Database layer (SQLite + FTS)
├── hooks/       # Git hooks & command wrappers
├── memory/      # Memory management (quality, decay, LLM)
├── scanners/    # Project & code scanners
├── security/    # Rate limiting
├── server/      # MCP handler & dashboard
└── mcp-stdio.ts # Main entry point
```

## How to Contribute

1. **Fork** the repository
2. **Create a branch** for your feature: `git checkout -b feat/your-feature`
3. **Make changes** and add tests
4. **Run tests**: `npm test && npm run test:enterprise`
5. **Submit a PR** with a clear description

## Coding Conventions

- TypeScript strict mode
- No external LLM API dependencies in core (optional only)
- All hooks must fail silently (never block git)
- Every new tool must have an enterprise test

## Reporting Bugs

Open an issue with:
- Steps to reproduce
- Expected vs actual behavior
- OS and Node.js version
- AI client being used (Claude, Cursor, etc.)
