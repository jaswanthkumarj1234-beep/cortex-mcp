/**
 * Git Memory — Auto-captures code changes from git history.
 *
 * On each session start (force_recall), this module:
 * 1. Reads recent git commits and stores them as memories
 * 2. Tracks file changes (new/deleted/modified) since last session
 * 3. Captures commit messages as DECISION/BUG_FIX based on keywords
 *
 * This solves the "what code changed and why?" gap that exists when
 * files change outside the AI conversation.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

interface GitCommit {
    hash: string;
    message: string;
    author: string;
    date: string;
    filesChanged: string[];
}

interface FileChangeReport {
    newFiles: string[];
    deletedFiles: string[];
    modifiedFiles: string[];
    totalChanges: number;
}

// Track the last processed commit hash to avoid duplicates
let lastProcessedCommit: string | null = null;

/** Capture recent git commits as memories */
export function captureGitCommits(memoryStore: MemoryStore, workspaceRoot: string, maxCommits: number = 5): number {
    if (!workspaceRoot) return 0;

    try {
        const { execSync } = require('child_process');

        // Get recent commits with file changes
        const gitLog = execSync(
            `git log --oneline --name-only -${maxCommits} --no-merges 2>nul`,
            { cwd: workspaceRoot, encoding: 'utf-8', timeout: 5000 }
        ).trim();

        if (!gitLog) return 0;

        const commits = parseGitLog(gitLog);
        let stored = 0;

        for (const commit of commits) {
            // Skip if already processed
            if (commit.hash === lastProcessedCommit) break;

            // Classify commit type based on message
            const type = classifyCommit(commit.message);

            // Check for duplicate — skip if already stored
            const existing = memoryStore.getActive(200).find(m =>
                m.tags?.includes(`commit:${commit.hash}`)
            );
            if (existing) continue;

            memoryStore.add({
                type,
                intent: `Git commit: ${commit.message}`,
                action: commit.filesChanged.length > 0
                    ? `Changed: ${commit.filesChanged.slice(0, 5).join(', ')}`
                    : commit.message,
                reason: 'Auto-captured from git history',
                tags: ['git-commit', `commit:${commit.hash}`, ...extractTopicTags(commit.message)],
                relatedFiles: commit.filesChanged.slice(0, 10),
                confidence: 0.8,
                importance: type === MemoryType.BUG_FIX ? 0.85 : 0.6,
                timestamp: Date.now(),
                isActive: true,
                accessCount: 0,
                createdAt: Date.now(),
                id: '',
            });
            stored++;
        }

        if (commits.length > 0) {
            lastProcessedCommit = commits[0].hash;
        }

        return stored;
    } catch {
        return 0;
    }
}

/** Detect file changes since last session */
export function detectFileChanges(workspaceRoot: string): FileChangeReport {
    const report: FileChangeReport = { newFiles: [], deletedFiles: [], modifiedFiles: [], totalChanges: 0 };
    if (!workspaceRoot) return report;

    try {
        const { execSync } = require('child_process');

        // Get uncommitted changes (working tree vs HEAD)
        const status = execSync('git status --porcelain 2>nul', {
            cwd: workspaceRoot,
            encoding: 'utf-8',
            timeout: 5000,
        }).trim();

        if (!status) return report;

        for (const line of status.split('\n')) {
            const code = line.slice(0, 2).trim();
            const file = line.slice(3).trim();
            if (!file) continue;

            switch (code) {
                case '??': case 'A': report.newFiles.push(file); break;
                case 'D': report.deletedFiles.push(file); break;
                case 'M': case 'MM': report.modifiedFiles.push(file); break;
                default: report.modifiedFiles.push(file); break;
            }
        }

        report.totalChanges = report.newFiles.length + report.deletedFiles.length + report.modifiedFiles.length;
        return report;
    } catch {
        return report;
    }
}

/** Format file changes for injection */
export function formatFileChanges(report: FileChangeReport): string {
    if (report.totalChanges === 0) return '';

    const lines: string[] = [`## 📝 Uncommitted Changes (${report.totalChanges} files)`];

    if (report.newFiles.length > 0) {
        lines.push(`**New:** ${report.newFiles.slice(0, 5).join(', ')}`);
    }
    if (report.deletedFiles.length > 0) {
        lines.push(`**Deleted:** ${report.deletedFiles.slice(0, 5).join(', ')}`);
    }
    if (report.modifiedFiles.length > 0) {
        lines.push(`**Modified:** ${report.modifiedFiles.slice(0, 5).join(', ')}`);
    }

    return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseGitLog(log: string): GitCommit[] {
    const commits: GitCommit[] = [];
    const lines = log.split('\n');
    let current: GitCommit | null = null;

    for (const line of lines) {
        // Commit line: "abc1234 Fix auth bug"
        const commitMatch = line.match(/^([a-f0-9]{7,12})\s+(.+)$/);
        if (commitMatch) {
            if (current) commits.push(current);
            current = {
                hash: commitMatch[1],
                message: commitMatch[2],
                author: '',
                date: '',
                filesChanged: [],
            };
        } else if (current && line.trim()) {
            // File change line
            current.filesChanged.push(line.trim());
        }
    }
    if (current) commits.push(current);

    return commits;
}

function classifyCommit(message: string): MemoryType {
    const lower = message.toLowerCase();
    if (/\b(fix|bug|patch|hotfix|resolve|crash|error|issue)\b/.test(lower)) return MemoryType.BUG_FIX;
    if (/\b(refactor|clean|lint|format|style|rename)\b/.test(lower)) return MemoryType.CONVENTION;
    if (/\b(add|feat|implement|create|support|enable)\b/.test(lower)) return MemoryType.DECISION;
    if (/\b(doc|readme|comment|note)\b/.test(lower)) return MemoryType.INSIGHT;
    return MemoryType.DECISION;
}

function extractTopicTags(message: string): string[] {
    const tags: string[] = [];
    const lower = message.toLowerCase();
    const patterns: [RegExp, string][] = [
        [/\b(auth|login|session|token|jwt)\b/, 'auth'],
        [/\b(database|sql|query|migration)\b/, 'database'],
        [/\b(api|endpoint|route)\b/, 'api'],
        [/\b(ui|component|style|css)\b/, 'ui'],
        [/\b(test|spec|coverage)\b/, 'testing'],
        [/\b(deploy|ci|docker)\b/, 'devops'],
        [/\b(security|permission)\b/, 'security'],
        [/\b(perf|cache|optimize)\b/, 'performance'],
    ];
    for (const [pattern, tag] of patterns) {
        if (pattern.test(lower)) tags.push(tag);
    }
    return tags;
}
