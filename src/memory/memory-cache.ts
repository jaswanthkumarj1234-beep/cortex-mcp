/**
 * Memory Cache — LRU result cache for fast repeat queries.
 * Extracted from standalone.ts L645-666.
 */
import { CONFIG } from '../config/config';

const recallCache = new Map<string, { result: any; time: number }>();

export function getCached(key: string): any | null {
    const entry = recallCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.time > CONFIG.CACHE_TTL) {
        recallCache.delete(key);
        return null;
    }
    return entry.result;
}

export function setCache(key: string, result: any): void {
    if (recallCache.size >= CONFIG.CACHE_MAX) {
        const oldest = recallCache.keys().next().value;
        if (oldest) recallCache.delete(oldest);
    }
    recallCache.set(key, { result, time: Date.now() });
}

export function invalidateCache(): void {
    recallCache.clear();
}

export function cacheSize(): number {
    return recallCache.size;
}
