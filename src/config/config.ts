/**
 * Cortex Configuration — Minimal, focused config for MCP mode.
 */
import { MemoryType } from '../types';

export const CONFIG = {
    // Memory ranking boosts by type
    TYPE_BOOST: {
        [MemoryType.CORRECTION]: 1.5,
        [MemoryType.DECISION]: 1.3,
        [MemoryType.CONVENTION]: 1.2,
        [MemoryType.BUG_FIX]: 1.1,
        [MemoryType.INSIGHT]: 1.0,
        [MemoryType.DEPENDENCY]: 0.8,
    } as Record<string, number>,

    // Memory decay
    INSIGHT_MAX_AGE_DAYS: 30,
    UNUSED_MAX_AGE_DAYS: 60,
    MEMORY_CAP: 500,

    // Cache
    CACHE_TTL: 60_000,     // 1 minute
    CACHE_MAX: 50,

    // Embeddings
    EMBEDDING_TIMEOUT: 30_000, // 30 seconds

    // Context
    MAX_CONTEXT_CHARS: 3000,
    MAX_RECALL_RESULTS: 10,

    // Server
    DASHBOARD_PORT: 3456,
};
