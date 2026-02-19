#!/usr/bin/env node
/**
 * cortex setup — Auto-configures Cortex MCP server for any AI client.
 * 
 * Usage:
 *   cortex-setup                      # auto-detect all clients
 *   cortex-setup --client antigravity
 *   cortex-setup --client claude
 *   cortex-setup --client cursor
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const HOME = os.homedir();

// ─── Supported Clients ────────────────────────────────────────────────────────

interface ClientConfig {
    name: string;
    configPath: string;
    configKey: string; // JSON path where mcpServers lives
}

const CLIENTS: Record<string, ClientConfig> = {
    antigravity: {
        name: 'Antigravity (Gemini)',
        configPath: path.join(HOME, '.gemini', 'antigravity', 'mcp_config.json'),
        configKey: 'mcpServers',
    },
    claude: {
        name: 'Claude Desktop',
        configPath: process.platform === 'win32'
            ? path.join(HOME, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json')
            : path.join(HOME, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        configKey: 'mcpServers',
    },
    cursor: {
        name: 'Cursor',
        configPath: path.join(HOME, '.cursor', 'mcp.json'),
        configKey: 'mcpServers',
    },
    copilot: {
        name: 'GitHub Copilot (VS Code)',
        configPath: path.join(HOME, '.vscode', 'settings.json'),
        configKey: 'github.copilot.chat.mcpServers',
    },
    windsurf: {
        name: 'Windsurf',
        configPath: path.join(HOME, '.codeium', 'windsurf', 'mcp_config.json'),
        configKey: 'mcpServers',
    },
    zed: {
        name: 'Zed',
        configPath: process.platform === 'win32'
            ? path.join(HOME, 'AppData', 'Roaming', 'Zed', 'settings.json')
            : path.join(HOME, '.config', 'zed', 'settings.json'),
        configKey: 'mcpServers',
    },
};

// ─── Server Entry ─────────────────────────────────────────────────────────────

const SERVER_ENTRY = {
    command: 'npx',
    args: ['-y', '@cortex-mcp/server'],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readJSON(filePath: string): any {
    try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function writeJSON(filePath: string, data: any): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function setNestedKey(obj: any, keyPath: string, value: any): any {
    const keys = keyPath.split('.');
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
    }
    const lastKey = keys[keys.length - 1];
    if (!current[lastKey]) current[lastKey] = {};
    current[lastKey]['cortex'] = value;
    return obj;
}

function configureClient(clientKey: string): boolean {
    const client = CLIENTS[clientKey];
    if (!client) {
        console.error(`Unknown client: ${clientKey}`);
        console.error(`Available: ${Object.keys(CLIENTS).join(', ')}`);
        return false;
    }

    const config = readJSON(client.configPath);
    const updated = setNestedKey(config, client.configKey, SERVER_ENTRY);
    writeJSON(client.configPath, updated);

    console.log(`[OK] ${client.name} configured!`);
    console.log(`   Config: ${client.configPath}`);
    return true;
}

function autoDetect(): string[] {
    const detected: string[] = [];
    for (const [key, client] of Object.entries(CLIENTS)) {
        if (fs.existsSync(path.dirname(client.configPath))) {
            detected.push(key);
        }
    }
    return detected;
}

// ─── Git Hook Installation ────────────────────────────────────────────────────

const HOOKS: Record<string, string> = {
    'post-commit': '#!/bin/sh\n# Cortex — Auto-capture commits\ncortex-capture 2>/dev/null || true\n',
    'post-checkout': '#!/bin/sh\n# Cortex — Track branch switches\ncortex-hooks checkout "$@" 2>/dev/null || true\n',
    'post-merge': '#!/bin/sh\n# Cortex — Track merges\ncortex-hooks merge "$@" 2>/dev/null || true\n',
};

function installGitHooks(workspaceRoot: string): number {
    const gitDir = path.join(workspaceRoot, '.git');
    if (!fs.existsSync(gitDir)) return 0;

    const hookDir = path.join(gitDir, 'hooks');
    fs.mkdirSync(hookDir, { recursive: true });

    let installed = 0;
    for (const [hookName, hookContent] of Object.entries(HOOKS)) {
        const hookPath = path.join(hookDir, hookName);
        const marker = hookName === 'post-commit' ? 'cortex-capture' : 'cortex-hooks';

        if (fs.existsSync(hookPath)) {
            const existing = fs.readFileSync(hookPath, 'utf-8');
            if (existing.includes(marker)) continue;  // Already installed
            // Append to existing hook
            const appendLine = hookContent.split('\n').filter(l => l.includes('cortex')).join('\n');
            fs.appendFileSync(hookPath, `\n# Cortex MCP\n${appendLine}\n`);
        } else {
            fs.writeFileSync(hookPath, hookContent, { mode: 0o755 });
        }
        installed++;
    }
    return installed;
}
// ─── Prompt Rules Installation ────────────────────────────────────────────────
// Each AI client has its own rules file. These tell the AI to auto-call
// force_recall at conversation start and auto_learn after every response.

const CORTEX_RULES = `# Cortex Memory Rules — MANDATORY

## At Conversation Start (ALWAYS)
1. ALWAYS call \`mcp_cortex_force_recall\` with the topic of the user's question
   - This returns ALL corrections, decisions, conventions, and bug fixes
   - Plus topic-specific search results
   - DO NOT skip this step. It is mandatory.

## After EVERY Response (ALWAYS)
2. ALWAYS call \`mcp_cortex_auto_learn\` with the text of your response
   - Cortex will automatically extract and store any decisions, corrections, conventions, or bug fixes
   - This is how Cortex learns passively — zero manual effort required
   - DO NOT skip this step. It is mandatory.

## When Decisions Are Made
ALSO call \`mcp_cortex_store_memory\` for high-importance items:
- A critical architectural decision (type: DECISION)
- A mistake that must never be repeated (type: CORRECTION)
- A project-wide coding convention (type: CONVENTION)
- A tricky bug that was hard to find (type: BUG_FIX)

## Before Suggesting Code
Call \`mcp_cortex_verify_code\` to check:
- Are import packages real (exist in package.json)?
- Are imported functions actually exported?
- Are env variables defined in .env?

## Before Referencing Files
Call \`mcp_cortex_verify_files\` to check if file paths are real.
`;

// Map of client → rules file path (relative to project root)
const RULES_FILES: Record<string, string> = {
    antigravity: path.join('.gemini', 'GEMINI.md'),
    cursor: '.cursorrules',
    copilot: path.join('.github', 'copilot-instructions.md'),
    windsurf: '.windsurfrules',
};

function installPromptRules(workspaceRoot: string, detectedClients: string[]): number {
    let installed = 0;
    for (const client of detectedClients) {
        const rulesFile = RULES_FILES[client];
        if (!rulesFile) continue;  // No rules file for this client (e.g. zed, claude)

        const fullPath = path.join(workspaceRoot, rulesFile);

        // Don't overwrite — check if Cortex rules already present
        if (fs.existsSync(fullPath)) {
            const existing = fs.readFileSync(fullPath, 'utf-8');
            if (existing.includes('mcp_cortex_force_recall')) continue;  // Already installed
            // Append to existing rules
            fs.appendFileSync(fullPath, '\n\n' + CORTEX_RULES);
            console.log(`[OK] Cortex rules appended to ${rulesFile}`);
        } else {
            fs.mkdirSync(path.dirname(fullPath), { recursive: true });
            fs.writeFileSync(fullPath, CORTEX_RULES, 'utf-8');
            console.log(`[OK] Created ${rulesFile} with Cortex memory rules`);
        }
        installed++;
    }
    return installed;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
    const args = process.argv.slice(2);
    const clientFlag = args.indexOf('--client');
    const clientArg = clientFlag !== -1 ? args[clientFlag + 1] : null;

    console.log('\nCortex MCP Setup\n');

    let detectedClients: string[] = [];

    if (clientArg) {
        configureClient(clientArg);
        detectedClients = [clientArg];
    } else {
        // Auto-detect installed clients
        detectedClients = autoDetect();
        if (detectedClients.length === 0) {
            console.log('No supported AI clients detected.');
            console.log('Supported clients:', Object.keys(CLIENTS).join(', '));
            console.log('\nManual setup:');
            console.log(JSON.stringify({ mcpServers: { cortex: SERVER_ENTRY } }, null, 2));
        } else {
            console.log(`Detected clients: ${detectedClients.map(k => CLIENTS[k].name).join(', ')}\n`);
            for (const key of detectedClients) {
                configureClient(key);
            }
        }
    }

    const cwd = process.cwd();

    // Install prompt rules (tells the AI to use Cortex automatically)
    if (detectedClients.length > 0) {
        console.log('');
        const rulesCount = installPromptRules(cwd, detectedClients);
        if (rulesCount > 0) {
            console.log(`   AI will now auto-recall context and auto-learn from every conversation!`);
        }
    }

    // Install git hooks in current directory (if it's a git repo)
    console.log('');
    if (fs.existsSync(path.join(cwd, '.git'))) {
        const count = installGitHooks(cwd);
        if (count > 0) {
            console.log(`[OK] ${count} git hook(s) installed (commits, branches, merges)`);
            console.log('   Every code change will now be auto-captured as a memory!');
        } else {
            console.log('[OK] Git hooks already installed');
        }
    } else {
        console.log('[INFO] No git repo detected in current directory.');
        console.log('   Run "cortex-setup" inside a git repo to enable auto-capture.');
    }

    console.log('\nDone! Restart your AI client to activate Cortex.\n');
}

main();

