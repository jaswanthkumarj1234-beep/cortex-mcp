/**
 * Attention Ranker — Re-ranks memories based on what you're doing RIGHT NOW.
 *
 * Debugging? Bug fixes and corrections rise to the top.
 * Coding? Conventions and decisions become priority.
 * Reviewing? Insights and architecture matter most.
 *
 * This is like how your brain filters: at a restaurant, food memories are
 * strong; at a library, book memories are strong. Same data, different priority.
 */
import { MemoryType, ScoredMemory } from '../types';

export type ActionContext = 'debugging' | 'coding' | 'reviewing' | 'chatting' | 'exploring' | 'unknown';

/** Multiplier map: action → memory type → boost factor */
const ATTENTION_WEIGHTS: Record<ActionContext, Partial<Record<string, number>>> = {
    debugging: {
        [MemoryType.BUG_FIX]: 2.0,
        [MemoryType.CORRECTION]: 1.8,
        [MemoryType.FAILED_SUGGESTION]: 1.5,
        [MemoryType.INSIGHT]: 1.2,
        [MemoryType.DECISION]: 1.0,
        [MemoryType.CONVENTION]: 0.8,
    },
    coding: {
        [MemoryType.CONVENTION]: 2.0,
        [MemoryType.DECISION]: 1.8,
        [MemoryType.PROVEN_PATTERN]: 1.5,
        [MemoryType.CORRECTION]: 1.3,
        [MemoryType.BUG_FIX]: 1.0,
        [MemoryType.INSIGHT]: 0.9,
    },
    reviewing: {
        [MemoryType.INSIGHT]: 2.0,
        [MemoryType.DECISION]: 1.5,
        [MemoryType.CONVENTION]: 1.3,
        [MemoryType.CORRECTION]: 1.2,
        [MemoryType.BUG_FIX]: 1.0,
    },
    chatting: {
        // Balanced for general conversation
        [MemoryType.DECISION]: 1.3,
        [MemoryType.CORRECTION]: 1.3,
        [MemoryType.CONVENTION]: 1.2,
        [MemoryType.BUG_FIX]: 1.2,
        [MemoryType.INSIGHT]: 1.1,
    },
    exploring: {
        [MemoryType.INSIGHT]: 1.8,
        [MemoryType.DEPENDENCY]: 1.5,
        [MemoryType.DECISION]: 1.3,
        [MemoryType.CONVENTION]: 1.0,
    },
    unknown: {}, // No boost — use raw scores
};

/** Detect action context from topic/file keywords */
export function detectActionContext(topic?: string, currentFile?: string): ActionContext {
    const text = `${topic || ''} ${currentFile || ''}`.toLowerCase();

    if (/\b(bug|fix|error|crash|fail|debug|issue|broken|not working)\b/.test(text)) {
        return 'debugging';
    }
    if (/\b(implement|build|add|create|feature|code|function|class)\b/.test(text)) {
        return 'coding';
    }
    if (/\b(review|check|audit|examine|look at|analyze)\b/.test(text)) {
        return 'reviewing';
    }
    if (/\b(explore|understand|how|what|why|explain|learn)\b/.test(text)) {
        return 'exploring';
    }

    return 'chatting'; // default
}

/** Re-rank memories based on current action context */
export function rankByAttention(
    memories: ScoredMemory[],
    context: ActionContext,
): ScoredMemory[] {
    const weights = ATTENTION_WEIGHTS[context];

    return memories
        .map(m => ({
            ...m,
            score: m.score * (weights[m.memory.type] || 1.0),
        }))
        .sort((a, b) => b.score - a.score);
}

/** Format the context indicator for injection */
export function formatAttentionContext(context: ActionContext): string {
    const labels: Record<ActionContext, string> = {
        debugging: '[DEBUG] Debug mode -- bug fixes and corrections prioritized',
        coding: '[CODE] Coding mode -- conventions and decisions prioritized',
        reviewing: '[REVIEW] Review mode -- insights and architecture prioritized',
        chatting: '[CHAT] Chat mode -- balanced context',
        exploring: '[EXPLORE] Explore mode -- insights and stack info prioritized',
        unknown: '',
    };
    return labels[context];
}
