/**
 * Session Tracker — Automatically builds session summaries.
 *
 * Tracks what was discussed, what files were changed, what decisions were made,
 * and what's unfinished. Stores a compressed session summary when the session ends.
 *
 * This is the key missing piece that prevents "where did we leave off?" re-explanation.
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

export interface SessionData {
    startTime: number;
    topics: Set<string>;
    decisions: string[];
    filesChanged: Set<string>;
    failedAttempts: string[];
    businessRules: string[];
    gotchas: string[];
    currentTasks: string[];
    autoLearnCount: number;
    lastUpdateTime: number;
}

let currentSession: SessionData | null = null;

// ─── Session Lifecycle ────────────────────────────────────────────────────────

export function startSession(): void {
    currentSession = {
        startTime: Date.now(),
        topics: new Set(),
        decisions: [],
        filesChanged: new Set(),
        failedAttempts: [],
        businessRules: [],
        gotchas: [],
        currentTasks: [],
        autoLearnCount: 0,
        lastUpdateTime: Date.now(),
    };
}

export function getSession(): SessionData | null {
    return currentSession;
}

/** Feed data into the running session — called by auto_learn and other tools */
export function feedSession(data: {
    topic?: string;
    decision?: string;
    fileChanged?: string;
    failedAttempt?: string;
    businessRule?: string;
    gotcha?: string;
    currentTask?: string;
    type?: string;
}): void {
    if (!currentSession) startSession();
    const s = currentSession!;

    if (data.topic) s.topics.add(data.topic.toLowerCase().slice(0, 80));
    if (data.decision) s.decisions.push(data.decision.slice(0, 150));
    if (data.fileChanged) s.filesChanged.add(data.fileChanged);
    if (data.failedAttempt) s.failedAttempts.push(data.failedAttempt.slice(0, 150));
    if (data.businessRule) s.businessRules.push(data.businessRule.slice(0, 150));
    if (data.gotcha) s.gotchas.push(data.gotcha.slice(0, 150));
    if (data.currentTask) s.currentTasks.push(data.currentTask.slice(0, 150));
    s.autoLearnCount++;
    s.lastUpdateTime = Date.now();
}

/** Build and store the session summary */
export function endSession(memoryStore: MemoryStore): string | null {
    if (!currentSession) return null;
    const s = currentSession;

    const durationMin = Math.round((Date.now() - s.startTime) / 60000);
    if (durationMin < 1 && s.autoLearnCount < 3) {
        currentSession = null;
        return null; // Too short — nothing worth storing
    }

    const parts: string[] = [];
    parts.push(`Session duration: ${durationMin} minutes`);

    if (s.topics.size > 0) {
        parts.push(`Topics discussed: ${[...s.topics].slice(0, 5).join(', ')}`);
    }

    if (s.decisions.length > 0) {
        parts.push(`Decisions made: ${s.decisions.slice(0, 5).join('; ')}`);
    }

    if (s.filesChanged.size > 0) {
        parts.push(`Files changed: ${[...s.filesChanged].slice(0, 10).join(', ')}`);
    }

    if (s.failedAttempts.length > 0) {
        parts.push(`Failed attempts: ${s.failedAttempts.slice(0, 3).join('; ')}`);
    }

    if (s.businessRules.length > 0) {
        parts.push(`Business rules captured: ${s.businessRules.slice(0, 3).join('; ')}`);
    }

    if (s.gotchas.length > 0) {
        parts.push(`Gotchas/warnings: ${s.gotchas.slice(0, 3).join('; ')}`);
    }

    if (s.currentTasks.length > 0) {
        const lastTask = s.currentTasks[s.currentTasks.length - 1];
        parts.push(`Current focus: ${lastTask}`);
    }

    const summary = parts.join('\n');

    // Store as a SESSION memory
    const timeStr = new Date(s.startTime).toISOString().slice(0, 16).replace('T', ' ');
    memoryStore.add({
        type: MemoryType.CONVERSATION,
        intent: `Session summary (${timeStr}): ${[...s.topics].slice(0, 3).join(', ') || 'general development'}`,
        action: summary,
        reason: `Auto-captured session with ${s.autoLearnCount} interactions over ${durationMin} min`,
        tags: ['session-summary', ...([...s.topics].slice(0, 3))],
        confidence: 0.85,
        importance: 0.80,
        timestamp: Date.now(),
        isActive: true,
        accessCount: 0,
        createdAt: Date.now(),
        id: '',
    });

    currentSession = null;
    return summary;
}

/** Get the last N session summaries for injection at conversation start */
export function getRecentSessions(memoryStore: MemoryStore, count: number = 3): string[] {
    const sessions = memoryStore.getByType(MemoryType.CONVERSATION, count * 2)
        .filter(m => m.tags?.includes('session-summary'))
        .slice(0, count);

    // Cross-session threading — detect topic overlap with current session
    const currentTopics = currentSession ? [...currentSession.topics] : [];

    return sessions.map(s => {
        const age = Date.now() - s.timestamp;
        const ageStr = age < 3600000 ? `${Math.round(age / 60000)} min ago`
            : age < 86400000 ? `${Math.round(age / 3600000)} hours ago`
                : `${Math.round(age / 86400000)} days ago`;

        // Cross-session threading — highlight shared topics
        let continuityTag = '';
        if (currentTopics.length > 0 && s.tags) {
            const shared = s.tags.filter(t =>
                t !== 'session-summary' && currentTopics.some(ct => ct.includes(t) || t.includes(ct))
            );
            if (shared.length > 0) {
                continuityTag = ` [CONT] Continuing: ${shared.join(', ')}`;
            }
        }

        return `[${ageStr}] ${s.action || s.intent}${continuityTag}`;
    });
}
