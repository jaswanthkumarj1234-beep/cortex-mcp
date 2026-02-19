#!/usr/bin/env node
/**
 * Cortex Run — Wraps any command and captures errors as memories.
 * 
 * Usage:
 *   cortex-run npm test
 *   cortex-run npm run build
 *   cortex-run python main.py
 * 
 * If the command fails, captures the error output as a BUG_FIX memory
 * so the AI knows about it in future conversations.
 * If the command succeeds, captures a brief success note.
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

function generateId(): string {
    return `cr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function findDbPath(): string | null {
    let dir = process.cwd();
    // Walk up to find .ai/brain-data/cortex.db
    for (let i = 0; i < 10; i++) {
        const dbPath = path.join(dir, '.ai', 'brain-data', 'cortex.db');
        if (fs.existsSync(dbPath)) return dbPath;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function extractErrorSummary(output: string): string {
    const lines = output.split('\n').filter(l => l.trim());

    // Look for common error patterns
    const errorLines = lines.filter(l =>
        /error|Error|ERROR|fail|FAIL|exception|Exception|TypeError|ReferenceError|SyntaxError/i.test(l)
    );

    if (errorLines.length > 0) {
        return errorLines.slice(0, 5).join('\n');
    }

    // Return last 10 lines if no specific error found
    return lines.slice(-10).join('\n');
}

function storeMemory(dbPath: string, type: string, intent: string, action: string, tags: string[]): void {
    try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');

        db.prepare(`
            INSERT INTO memory_units (id, type, intent, action, reason, tags, timestamp, confidence, importance, is_active)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
            generateId(), type, intent, action,
            'Auto-captured from cortex-run',
            JSON.stringify(tags), Date.now(), 0.7, 0.6
        );

        // Try FTS insert
        try {
            db.prepare(`INSERT INTO memory_fts (rowid, intent, action, tags) VALUES (
                (SELECT rowid FROM memory_units WHERE id = (SELECT id FROM memory_units ORDER BY timestamp DESC LIMIT 1)), ?, ?, ?
            )`).run(intent, action, tags.join(' '));
        } catch { }

        db.close();
    } catch { }
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.log('Usage: cortex-run <command> [args...]');
        console.log('Example: cortex-run npm test');
        console.log('         cortex-run npm run build');
        process.exit(1);
    }

    const command = args.join(' ');
    const dbPath = findDbPath();
    const startTime = Date.now();

    try {
        // Run the command, inheriting stdio for real-time output
        execSync(command, {
            stdio: 'inherit',
            cwd: process.cwd(),
            env: process.env,
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Success — store a brief note
        if (dbPath) {
            storeMemory(
                dbPath,
                'INSIGHT',
                `[OK] Command succeeded: ${command} (${duration}s)`,
                `Successfully ran "${command}" in ${duration} seconds`,
                ['cortex-run', 'success', command.split(' ')[0]]
            );
        }

    } catch (err: any) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        // Failure — capture error details
        if (dbPath) {
            let errorOutput = '';
            try {
                // Re-run to capture output
                execSync(command, {
                    cwd: process.cwd(),
                    env: process.env,
                    encoding: 'utf-8',
                    stdio: ['pipe', 'pipe', 'pipe'],
                });
            } catch (e: any) {
                errorOutput = (e.stderr || e.stdout || e.message || '').toString();
            }

            const errorSummary = extractErrorSummary(errorOutput);

            storeMemory(
                dbPath,
                'BUG_FIX',
                `[FAIL] Command failed: ${command}`,
                `Failed after ${duration}s.\n\nError:\n${errorSummary.slice(0, 500)}`,
                ['cortex-run', 'error', command.split(' ')[0], 'needs-fix']
            );
        }

        // Exit with the same error code
        process.exit(err.status || 1);
    }
}

main();
