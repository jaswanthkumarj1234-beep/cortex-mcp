/**
 * Learning Rate Adjuster — Tracks correction frequency and auto-boosts importance.
 *
 * If the AI gets corrected 3 times about "auth", auth corrections become
 * ultra-priority and surface at the very top of every recall.
 *
 * Like how your brain learns faster from repeated mistakes:
 * burn your hand once = careful. Burn it 3 times = NEVER touch stove.
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryType, MemoryUnit } from '../types';

interface CorrectionFrequency {
    topic: string;
    count: number;
    lastCorrected: number;
    memoryIds: string[];
}

/** Analyze correction frequency across all memories */
export function analyzeCorrectionFrequency(memoryStore: MemoryStore): CorrectionFrequency[] {
    const corrections = memoryStore.getByType(MemoryType.CORRECTION, 200);
    if (corrections.length < 2) return [];

    // Extract topic keywords from each correction
    const topicMap = new Map<string, CorrectionFrequency>();

    for (const c of corrections) {
        const words = extractTopicWords(c.intent);
        for (const word of words) {
            const existing = topicMap.get(word);
            if (existing) {
                existing.count++;
                existing.lastCorrected = Math.max(existing.lastCorrected, c.timestamp);
                if (!existing.memoryIds.includes(c.id)) {
                    existing.memoryIds.push(c.id);
                }
            } else {
                topicMap.set(word, {
                    topic: word,
                    count: 1,
                    lastCorrected: c.timestamp,
                    memoryIds: [c.id],
                });
            }
        }
    }

    // Only return topics with 2+ corrections
    return [...topicMap.values()]
        .filter(t => t.count >= 2)
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);
}

/** Auto-boost importance of frequently corrected topics */
export function boostFrequentCorrections(memoryStore: MemoryStore): number {
    const freqs = analyzeCorrectionFrequency(memoryStore);
    let boosted = 0;

    for (const freq of freqs) {
        if (freq.count >= 3) {
            // 3+ corrections = ultra-priority
            for (const id of freq.memoryIds) {
                const m = memoryStore.get(id);
                if (m && m.importance < 0.95) {
                    memoryStore.update(id, { importance: 0.95 });
                    boosted++;
                }
            }
        } else if (freq.count >= 2) {
            // 2 corrections = high priority
            for (const id of freq.memoryIds) {
                const m = memoryStore.get(id);
                if (m && m.importance < 0.85) {
                    memoryStore.update(id, { importance: 0.85 });
                    boosted++;
                }
            }
        }
    }

    return boosted;
}

/** Format hot corrections for injection */
export function formatHotCorrections(memoryStore: MemoryStore): string {
    const freqs = analyzeCorrectionFrequency(memoryStore);
    const hot = freqs.filter(f => f.count >= 2);

    if (hot.length === 0) return '';

    const lines: string[] = ['## Hot Corrections (repeatedly corrected -- CRITICAL)'];
    for (const h of hot.slice(0, 5)) {
        const emoji = h.count >= 3 ? '[CRITICAL]' : '[WARN]';
        lines.push(`${emoji} "${h.topic}" — corrected ${h.count}x`);
    }
    return lines.join('\n');
}

/** Extract meaningful topic words from correction text */
function extractTopicWords(text: string): string[] {
    const stopWords = new Set([
        'the', 'a', 'an', 'is', 'was', 'are', 'were', 'to', 'of', 'in', 'for',
        'on', 'with', 'at', 'by', 'from', 'it', 'this', 'that', 'and', 'or',
        'but', 'not', 'do', 'does', 'did', 'don', 'dont', 'use', 'using',
        'should', 'must', 'never', 'always', 'avoid', 'instead',
    ]);

    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(w => w.length > 3 && !stopWords.has(w));
}
