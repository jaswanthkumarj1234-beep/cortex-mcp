/**
 * Confidence Decay + Reinforcement — Time-based memory aging.
 *
 * Memories that are never accessed gradually lose importance.
 * Memories that are frequently accessed get stronger.
 *
 * Like how the brain strengthens neural pathways that are used often
 * and prunes connections that are never activated.
 *
 * Formula: effective_importance = base_importance * decay_factor * access_boost
 * - decay_factor = 1 / (1 + age_in_days * 0.02) — slow exponential decay
 * - access_boost = 1 + (accessCount * 0.1) — capped at 2x
 */
import { MemoryStore } from '../db/memory-store';
import { ScoredMemory } from '../types';

const DECAY_RATE = 0.02; // 2% per day
const ACCESS_BOOST_RATE = 0.1; // 10% per access
const MAX_ACCESS_BOOST = 2.0;
const MIN_IMPORTANCE = 0.1; // Never fully forget

/** Calculate effective importance with decay and reinforcement */
export function effectiveImportance(
    baseImportance: number,
    timestamp: number,
    accessCount: number,
    lastAccessed?: number,
): number {
    const ageInDays = (Date.now() - timestamp) / 86400000;

    // Decay: older memories lose importance (but slowly)
    const decayFactor = 1 / (1 + ageInDays * DECAY_RATE);

    // Reinforcement: frequently accessed memories get stronger
    const accessBoost = Math.min(MAX_ACCESS_BOOST, 1 + (accessCount * ACCESS_BOOST_RATE));

    // Recent access counteracts decay
    let recencyBoost = 1.0;
    if (lastAccessed) {
        const daysSinceAccess = (Date.now() - lastAccessed) / 86400000;
        if (daysSinceAccess < 1) recencyBoost = 1.3; // accessed today
        else if (daysSinceAccess < 7) recencyBoost = 1.1; // accessed this week
    }

    const effective = baseImportance * decayFactor * accessBoost * recencyBoost;
    return Math.max(MIN_IMPORTANCE, Math.min(1.0, effective));
}

/** Apply decay + reinforcement scoring to search results */
export function applyConfidenceDecay(memories: ScoredMemory[]): ScoredMemory[] {
    return memories.map(m => {
        const boost = effectiveImportance(
            m.memory.importance,
            m.memory.timestamp,
            m.memory.accessCount,
            m.memory.lastAccessed,
        );

        return {
            ...m,
            score: m.score * boost,
        };
    }).sort((a, b) => b.score - a.score);
}

/** Run periodic maintenance — decay old, unused memories */
export function runDecayMaintenance(memoryStore: MemoryStore): number {
    const active = memoryStore.getActive(500);
    let decayed = 0;

    for (const m of active) {
        const current = m.importance;
        const effective = effectiveImportance(
            current,
            m.timestamp,
            m.accessCount,
            m.lastAccessed,
        );

        // Only update if significant change (>5% difference)
        if (Math.abs(current - effective) > 0.05) {
            memoryStore.update(m.id, { importance: effective });
            decayed++;
        }
    }

    return decayed;
}
