#!/usr/bin/env node
/**
 * Cortex MCP — stdio transport for Antigravity / Gemini integration.
 * 
 * CRITICAL: In stdio mode, stdout is ONLY for JSON-RPC messages.
 * All logging MUST go to stderr. We override console.log/warn/error
 * BEFORE importing any modules to prevent protocol corruption.
 */

// === MUST BE FIRST: Redirect ALL console output to stderr ===
import * as fs from 'fs';
import * as path from 'path';

const DEBUG = process.env.DEBUG === '1' || process.env.CORTEX_DEBUG === '1';
const debugLogPath = DEBUG ? path.join(process.cwd(), 'cortex.log') : null;

function logToFile(msg: string) {
    if (!debugLogPath) return;
    try {
        const timestamp = new Date().toISOString();
        fs.appendFileSync(debugLogPath, `[${timestamp}] ${msg}\n`);
    } catch (e) { /* ignore */ }
}

console.log = (...args: any[]) => {
    const msg = args.join(' ');
    process.stderr.write(msg + '\n');
    logToFile(`INFO: ${msg}`);
};
console.warn = (...args: any[]) => {
    const msg = args.join(' ');
    process.stderr.write(msg + '\n');
    logToFile(`WARN: ${msg}`);
};
console.error = (...args: any[]) => {
    const msg = args.join(' ');
    process.stderr.write(msg + '\n');
    logToFile(`ERROR: ${msg}`);
};

if (DEBUG) {
    logToFile("=== CORTEX SERVER STARTING ===");
    logToFile(`CWD: ${process.cwd()}`);
    logToFile(`ARGS: ${process.argv.join(' ')}`);
}

// --- Crash protection: keep server alive on errors ---
process.on('uncaughtException', (err) => {
    console.log(`[cortex-mcp] UNCAUGHT EXCEPTION (survived): ${err.message}`);
    console.log(`[cortex-mcp] Stack: ${err.stack}`);
    // Do NOT exit — keep the MCP connection alive
});

process.on('unhandledRejection', (reason: any) => {
    console.log(`[cortex-mcp] UNHANDLED REJECTION (survived): ${reason?.message || reason}`);
    // Do NOT exit — keep the MCP connection alive
});


import * as readline from 'readline';
import { CognitiveDatabase } from './db/database';
import { EventLog } from './db/event-log';
import { MemoryStore } from './db/memory-store';
import { createMCPHandler } from './server/mcp-handler';
import { startEmbeddingWorker } from './memory/embedding-manager';
import { cleanupMemories } from './memory/memory-decay';

// ─── CLI Routing ─────────────────────────────────────────────────────────────
// Handle subcommands BEFORE starting the MCP server
const firstArg = process.argv[2];
if (firstArg === 'setup') {
    // Route to setup CLI
    const setupPath = path.join(__dirname, 'cli', 'setup.js');
    process.argv.splice(2, 1); // Remove 'setup' so setup.ts sees clean args
    require(setupPath);
    // Don't continue — setup runs and exits
} else if (firstArg === '--version' || firstArg === '-v') {
    const pkg = require(path.join(__dirname, '..', 'package.json'));
    process.stderr.write(`cortex-mcp v${pkg.version}\n`);
    process.exit(0);
} else if (firstArg === '--help' || firstArg === '-h' || firstArg === 'help') {
    process.stderr.write(`
Cortex MCP Server — Persistent memory for AI coding assistants

USAGE:
  npx @cortex-mcp/server                  Start MCP server (used by AI clients)
  npx @cortex-mcp/server setup            Auto-configure your AI client
  npx @cortex-mcp/server --version        Show version
  npx @cortex-mcp/server --help           Show this help

COMPANION TOOLS (installed automatically):
  cortex-setup                             Configure AI client + git hooks
  cortex-capture                           Capture git commits as memories
  cortex-hooks <checkout|merge>            Capture branch/merge events
  cortex-run <command>                     Run any command and capture errors

ENVIRONMENT VARIABLES:
  CORTEX_DEBUG=1                           Enable file logging (cortex.log)
  CORTEX_PORT=4000                         Custom dashboard port (default: 3456)
  OPENAI_API_KEY=sk-...                    Enable LLM-enhanced classification
  ANTHROPIC_API_KEY=sk-ant-...             Alternative LLM provider
  CORTEX_LLM_BASE_URL=http://...           Custom LLM endpoint (Ollama, etc.)

SUPPORTED AI CLIENTS:
  Antigravity, Claude Desktop, Cursor, GitHub Copilot, Windsurf, Zed
  Also works with: Claude Code (terminal), any MCP-compatible client

DOCS: https://github.com/cortex-mcp/server
`);
    process.exit(0);
}

// Determine data directory — use workspace if provided, else cwd
// Skip arg if it looks like a flag (starts with -)
const workspaceRoot = (firstArg && !firstArg.startsWith('-')) ? firstArg : process.cwd();
const dataDir = path.join(workspaceRoot, '.ai', 'brain-data');

// Initialize database (wrapped to catch lock errors)
let database: CognitiveDatabase;
let eventLog: EventLog;
let memoryStore: MemoryStore;
let handleMCPRequest: any;

try {
    // Initialize database and memory store (console.log now goes to stderr)
    database = new CognitiveDatabase(dataDir);
    eventLog = new EventLog(database);
    memoryStore = new MemoryStore(database);

    // Start embedding worker for vector search
    startEmbeddingWorker();

    // Create MCP handler (reuses all existing logic)
    const handler = createMCPHandler(memoryStore, eventLog, workspaceRoot);
    handleMCPRequest = handler ? handler.handleMCPRequest : null;

    console.log(`[cortex-mcp] Started with ${memoryStore.activeCount()} memories from ${dataDir}`);

    // Run memory decay on startup, then every 6 hours
    cleanupMemories(memoryStore);
    setInterval(() => cleanupMemories(memoryStore), 6 * 60 * 60 * 1000);

    // Auto-scan project on first run (0 memories = brand new install)
    if (memoryStore.activeCount() === 0) {
        try {
            const scanner = new (require('./scanners/project-scanner').ProjectScanner)(memoryStore, workspaceRoot);
            scanner.scan().then((count: number) => {
                if (count > 0) console.log(`[cortex-mcp] Auto-scanned project: ${count} memories created`);
            }).catch(() => { });
        } catch (err: any) {
            console.log(`[cortex-mcp] Auto-scan skipped: ${err.message}`);
        }
    }

    // Start web dashboard (non-blocking, port 3456)
    try {
        const { startDashboard } = require('./server/dashboard');
        const { CONFIG } = require('./config/config');
        startDashboard(memoryStore);
        const port = process.env.CORTEX_PORT || CONFIG.DASHBOARD_PORT || 3456;
        console.log(`[cortex-mcp] Dashboard: http://localhost:${port}`);
    } catch (err: any) {
        console.log(`[cortex-mcp] Dashboard unavailable: ${err.message}`);
    }

} catch (err: any) {
    console.error(`[cortex-mcp] FATAL INIT ERROR: ${err.message}`);
    console.error(`[cortex-mcp] Server running in degraded mode (no DB)`);
    // Fallback: minimal handler that reports error
    handleMCPRequest = async (rpc: any) => ({
        jsonrpc: '2.0', id: rpc.id,
        error: { code: -32603, message: `Server Init Failed: ${err.message}` }
    });
}

// --- stdio JSON-RPC transport ---
// Read line-delimited JSON from stdin, write responses to stdout

const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
});

rl.on('line', async (line: string) => {
    if (!line.trim()) return;

    try {
        const rpc = JSON.parse(line);
        console.log(`[cortex-mcp] ${rpc.method} (id: ${rpc.id})`);

        if (!handleMCPRequest) {
            throw new Error("Handler not initialized");
        }

        const response = await handleMCPRequest(rpc);

        if (response) {
            const json = JSON.stringify(response);
            process.stdout.write(json + '\n');
        }
    } catch (err: any) {
        console.log(`[cortex-mcp] Error: ${err.message}`);
        const errorResponse = {
            jsonrpc: '2.0',
            error: { code: -32700, message: `Parse error: ${err.message}` },
            id: null,
        };
        process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
});

rl.on('close', () => {
    console.log('[cortex-mcp] stdin closed, shutting down');
    if (database) database.close();
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('[cortex-mcp] SIGTERM received, shutting down');
    if (database) database.close();
    process.exit(0);
});

process.on('SIGINT', () => {
    console.log('[cortex-mcp] SIGINT received, shutting down');
    if (database) database.close();
    process.exit(0);
});
