#!/usr/bin/env node
/**
 * Cortex Git Capture — Auto-stores git commits as memories.
 * 
 * Called by the post-commit git hook after every commit.
 * Reads the latest commit info and stores it as a memory
 * so the AI remembers what code changes were made and why.
 * 
 * IMPORTANT: This script must be FAST (<500ms) since it runs
 * in a git hook. It uses direct SQLite inserts instead of the
 * full CognitiveDatabase/MemoryStore classes.
 * 
 * Usage (automatic via git hook):
 *   .git/hooks/post-commit → calls this script
 * 
 * Usage (manual):
 *   cortex-capture
 *   node dist/hooks/git-capture.js
 */

import { execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function gitCmd(cmd: string): string {
    try {
        return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim();
    } catch {
        return '';
    }
}

function generateId(): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 10);
    return `gc_${timestamp}_${random}`;
}

/**
 * Auto-classify commit into a memory type based on commit message.
 */
function classifyCommit(message: string): string {
    const lower = message.toLowerCase();
    if (/\b(fix|bug|patch|hotfix|resolve|repair|correct|issue)\b/.test(lower)) return 'BUG_FIX';
    if (/\b(refactor|clean|rename|restructure|reorganize|lint|format|style|convention)\b/.test(lower)) return 'CONVENTION';
    if (/\b(feat|add|implement|create|new|introduce|support|enable|integrate)\b/.test(lower)) return 'DECISION';
    if (/\b(doc|readme|comment|explain|note|changelog)\b/.test(lower)) return 'INSIGHT';
    if (/\b(test|spec|coverage|assert|verify)\b/.test(lower)) return 'CONVENTION';
    if (/\b(upgrade|downgrade|bump|deps?|dependency|package)\b/.test(lower)) return 'DECISION';
    if (/\b(revert|rollback|undo)\b/.test(lower)) return 'BUG_FIX';
    if (/\b(perf|optimize|speed|cache)\b/.test(lower)) return 'INSIGHT';
    if (/\b(security|auth|encrypt|permission|vulnerability)\b/.test(lower)) return 'BUG_FIX';
    return 'DECISION';
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function main(): void {
    // 1. Find git root
    const workspaceRoot = gitCmd('git rev-parse --show-toplevel');
    if (!workspaceRoot) process.exit(0);

    // 2. Check Cortex is initialized
    const dataDir = path.join(workspaceRoot, '.ai', 'brain-data');
    const dbPath = path.join(dataDir, 'cortex.db');
    if (!fs.existsSync(dbPath)) process.exit(0);

    // 3. Read commit info
    const subject = gitCmd('git log -1 --pretty=%s');
    if (!subject || subject.startsWith('Merge ')) process.exit(0);

    const hash = gitCmd('git log -1 --pretty=%H');
    const shortHash = hash.slice(0, 8);
    const body = gitCmd('git log -1 --pretty=%b');
    const filesRaw = gitCmd('git log -1 --name-only --pretty=');
    const files = filesRaw ? filesRaw.split('\n').filter(Boolean) : [];

    // Get stats
    const statLine = gitCmd('git log -1 --pretty= --shortstat');
    const insMatch = statLine.match(/(\d+) insertion/);
    const delMatch = statLine.match(/(\d+) deletion/);
    const insertions = insMatch ? insMatch[1] : '0';
    const deletions = delMatch ? delMatch[1] : '0';

    // 4. Build memory fields
    const type = classifyCommit(subject);
    const id = generateId();

    let intent = subject;
    if (files.length <= 3 && files.length > 0) {
        intent += ` (in ${files.map(f => path.basename(f)).join(', ')})`;
    } else if (files.length > 3) {
        intent += ` (${files.length} files)`;
    }

    let action = `[${shortHash}] +${insertions}/-${deletions} in ${files.length} file(s)`;
    if (body) action = body.slice(0, 200) + ' | ' + action;

    const tags: string[] = ['git-commit', shortHash];
    // Add top-level dirs
    const dirs = new Set<string>();
    for (const f of files) {
        const parts = f.split('/');
        if (parts.length > 1) dirs.add(parts[0]);
    }
    for (const d of dirs) tags.push(d);

    const relatedFiles = files.map(f => path.join(workspaceRoot, f));
    const now = Date.now();

    // 5. Direct SQLite insert (lightweight, no class init overhead)
    try {
        const Database = require('better-sqlite3');
        const db = new Database(dbPath);
        db.pragma('journal_mode = WAL');

        // Check if already captured
        const existing = db.prepare(
            `SELECT id FROM memory_units WHERE tags LIKE ? AND is_active = 1`
        ).get(`%${shortHash}%`);

        if (!existing) {
            db.prepare(`
                INSERT INTO memory_units (id, type, intent, action, reason, related_files, tags, timestamp, confidence, importance, is_active)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `).run(
                id,
                type,
                intent,
                action,
                `Auto-captured from git commit ${shortHash}`,
                JSON.stringify(relatedFiles),
                JSON.stringify(tags),
                now,
                0.6,
                0.5
            );

            // Also insert into FTS index if it exists
            try {
                db.prepare(`INSERT INTO memory_fts (rowid, intent, action, tags) VALUES (
                    (SELECT rowid FROM memory_units WHERE id = ?), ?, ?, ?
                )`).run(id, intent, action, tags.join(' '));
            } catch {
                // FTS table might not exist yet, that's OK
            }
        }

        db.close();
    } catch {
        // Database issues — fail silently, never block git
        process.exit(0);
    }
}

main();
