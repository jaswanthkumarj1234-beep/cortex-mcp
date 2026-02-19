/**
 * Temporal Engine — Time-aware memory retrieval.
 *
 * Answers: "What changed today?", "What did we do this week?"
 * Auto-injects a "Recent Activity" section at conversation start.
 *
 * Like how your brain naturally groups events by "today", "yesterday", "last week".
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryUnit } from '../types';

export interface TemporalBucket {
    label: string;
    memories: MemoryUnit[];
    start: number;
    end: number;
}

/** Get memories bucketed by time period */
export function getTemporalBuckets(memoryStore: MemoryStore): TemporalBucket[] {
    const now = Date.now();
    const HOUR = 3600000;
    const DAY = 86400000;

    const buckets: TemporalBucket[] = [
        { label: 'Last hour', memories: [], start: now - HOUR, end: now },
        { label: 'Today', memories: [], start: now - DAY, end: now - HOUR },
        { label: 'Yesterday', memories: [], start: now - 2 * DAY, end: now - DAY },
        { label: 'This week', memories: [], start: now - 7 * DAY, end: now - 2 * DAY },
    ];

    const active = memoryStore.getActive(200);
    for (const m of active) {
        for (const bucket of buckets) {
            if (m.timestamp >= bucket.start && m.timestamp < bucket.end) {
                bucket.memories.push(m);
                break;
            }
        }
    }

    return buckets.filter(b => b.memories.length > 0);
}

/** Get only recent changes (last N hours) */
export function getRecentChanges(memoryStore: MemoryStore, hours: number = 24): MemoryUnit[] {
    const since = Date.now() - (hours * 3600000);
    return memoryStore.getActive(200).filter(m => m.timestamp >= since);
}

/** Format temporal context for injection into force_recall */
export function formatTemporalContext(memoryStore: MemoryStore): string {
    const buckets = getTemporalBuckets(memoryStore);
    if (buckets.length === 0) return '';

    const lines: string[] = ['## ⏰ Recent Activity'];

    for (const bucket of buckets) {
        if (bucket.memories.length === 0) continue;
        lines.push(`\n**${bucket.label}** (${bucket.memories.length} memories):`);
        // Show top 5 per bucket, sorted by importance
        const sorted = bucket.memories.sort((a, b) => b.importance - a.importance);
        for (const m of sorted.slice(0, 5)) {
            lines.push(`- [${m.type}] ${m.intent.slice(0, 100)}`);
        }
    }

    return lines.join('\n');
}

/** Get workspace changes since last session */
export function getWorkspaceDiff(workspaceRoot: string): string {
    try {
        const { execSync } = require('child_process');

        // Recent commits
        let commits = '';
        try {
            commits = execSync('git log --oneline -5', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                timeout: 3000,
            }).trim();
        } catch { }

        // Files changed recently
        let diffStat = '';
        try {
            diffStat = execSync('git diff --stat HEAD~3 2>nul || echo "no git history"', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                timeout: 3000,
            }).trim();
        } catch { }

        // Current branch
        let branch = '';
        try {
            branch = execSync('git branch --show-current', {
                cwd: workspaceRoot,
                encoding: 'utf-8',
                timeout: 2000,
            }).trim();
        } catch { }

        if (!commits && !diffStat) return '';

        const parts: string[] = ['## 📂 Workspace State'];
        if (branch) parts.push(`Branch: \`${branch}\``);
        if (commits) {
            parts.push('\nRecent commits:');
            for (const line of commits.split('\n').slice(0, 5)) {
                parts.push(`- ${line}`);
            }
        }
        if (diffStat && diffStat !== 'no git history') {
            parts.push(`\nRecent changes:\n\`\`\`\n${diffStat.slice(0, 300)}\n\`\`\``);
        }
        return parts.join('\n');
    } catch {
        return '';
    }
}
