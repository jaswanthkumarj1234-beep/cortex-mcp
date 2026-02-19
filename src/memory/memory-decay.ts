/**
 * Memory Decay — Cleanup stale and low-value memories.
 * Extracted from standalone.ts L668-711.
 *
 * NEW: Duplicate detection — merges identical memories instead of keeping copies.
 * NEW: Memory strengthening — repeated patterns increase importance.
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';
import { CONFIG } from '../config/config';
import { invalidateCache } from './memory-cache';

export function cleanupMemories(memoryStore: MemoryStore): void {
    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;

    try {
        let cleaned = 0;

        // 1. Deactivate INSIGHT memories > 14 days with 0 access
        const insights = memoryStore.getByType(MemoryType.INSIGHT, 5000);
        for (const m of insights) {
            if (m.accessCount === 0 && now - m.createdAt > CONFIG.INSIGHT_MAX_AGE_DAYS * DAY) {
                memoryStore.deactivate(m.id);
                cleaned++;
            }
        }

        // 2. Deactivate any memory > 30 days with 0 access
        const all = memoryStore.getActive(5000);
        for (const m of all) {
            if (m.accessCount === 0 && now - m.createdAt > CONFIG.UNUSED_MAX_AGE_DAYS * DAY) {
                memoryStore.deactivate(m.id);
                cleaned++;
            }
        }

        // 3. Cap at MEMORY_CAP active memories
        const active = memoryStore.getActive(5000);
        if (active.length > CONFIG.MEMORY_CAP) {
            const sorted = active.sort((a, b) => a.importance - b.importance);
            const toRemove = sorted.slice(0, active.length - CONFIG.MEMORY_CAP);
            for (const m of toRemove) {
                memoryStore.deactivate(m.id);
                cleaned++;
            }
        }

        // 4. NEW: Duplicate detection — find memories with identical intents
        const activeAfterClean = memoryStore.getActive(5000);
        const intentMap = new Map<string, typeof activeAfterClean>();
        for (const m of activeAfterClean) {
            const key = m.intent.toLowerCase().trim();
            const existing = intentMap.get(key);
            if (existing) {
                existing.push(m);
            } else {
                intentMap.set(key, [m]);
            }
        }

        // Merge duplicates — keep highest importance, boost it
        for (const [, dupes] of intentMap) {
            if (dupes.length <= 1) continue;

            // Sort by importance desc, keep the first
            dupes.sort((a, b) => b.importance - a.importance);
            const keeper = dupes[0];

            // Strengthen the keeper (repeated = more important)
            const strengthBoost = Math.min(dupes.length * 0.05, 0.3);
            memoryStore.update(keeper.id, {
                importance: Math.min(keeper.importance + strengthBoost, 1.0),
                accessCount: keeper.accessCount + dupes.length - 1,
            });

            // Deactivate the rest
            for (let i = 1; i < dupes.length; i++) {
                memoryStore.deactivate(dupes[i].id, keeper.id);
                cleaned++;
            }
        }

        if (cleaned > 0) {
            console.log(`  🧹 Decay: cleaned ${cleaned} stale/duplicate memories`);
            invalidateCache();
        }
    } catch (err: any) {
        console.error('  [ERROR] Cleanup error:', err.message);
    }
}
