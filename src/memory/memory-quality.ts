/**
 * Memory Quality — Filters, contradiction detection, and quality gates.
 *
 * Prevents junk memories from polluting the database.
 * Detects contradictions between memories.
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

// --- Quality Gate ---
const TOO_GENERIC = new Set([
    'use best practices',
    'follow conventions',
    'write clean code',
    'be careful',
    'test your code',
    'read the docs',
    'check the documentation',
    'handle errors',
    'add error handling',
]);

/**
 * Check if a memory is worth storing.
 * Returns null if good, or a rejection reason if bad.
 */
export function qualityCheck(intent: string, type: string): string | null {
    // Too short
    if (!intent || intent.trim().length < 15) {
        return 'Too short (< 15 chars)';
    }

    // Too long (probably pasted a whole paragraph)
    if (intent.length > 500) {
        return 'Too long (> 500 chars)';
    }

    // Too generic
    const normalized = intent.toLowerCase().trim();
    if (TOO_GENERIC.has(normalized)) {
        return 'Too generic';
    }

    // All caps (yelling / noise)
    if (intent === intent.toUpperCase() && intent.length > 20) {
        return 'All caps noise';
    }

    // Repeated characters (spam)
    if (/(.)\1{5,}/.test(intent)) {
        return 'Repeated characters';
    }

    // Only URLs or paths
    if (/^https?:\/\/\S+$/.test(intent.trim())) {
        return 'Just a URL';
    }

    // Raw JSON blobs (artifact metadata, config objects, etc.)
    if (normalized.startsWith('{') || normalized.startsWith('[')) {
        return 'Raw JSON blob';
    }

    // Mostly JSON-like content (has lots of quotes and colons)
    const jsonIndicators = (intent.match(/[{}[\]:]/g) || []).length;
    if (jsonIndicators > 6 && jsonIndicators / intent.length > 0.05) {
        return 'JSON-like content';
    }

    // AI response artifacts ("AI response: { artifactType...}")
    if (normalized.startsWith('ai response:') || normalized.startsWith('ai correction:')) {
        return 'AI response artifact';
    }

    // Hallucination guard noise ("Hallucination detected: Referenced file not found:")
    if (normalized.startsWith('hallucination')) {
        return 'Hallucination guard noise';
    }

    // Document dumps (markdown headers — these are full documents, not memories)
    if (normalized.startsWith('# ') && intent.length > 100) {
        return 'Markdown document dump';
    }

    // Prefixed noise patterns from extractors
    const noisePrefixes = ['bug analysis:', 'self-test:', 'test memory', 'roundtrip-'];
    for (const prefix of noisePrefixes) {
        if (normalized.startsWith(prefix)) {
            return `Noise prefix: ${prefix}`;
        }
    }

    // Multi-line content (real memories are single ideas, not paragraphs)
    const lineCount = intent.split('\n').filter(l => l.trim().length > 0).length;
    if (lineCount > 3) {
        return 'Multi-line document (not a single memory)';
    }

    // File path dumps (just listing file references)
    if (normalized.startsWith('file ') && normalized.includes(' was reverted')) {
        return 'File revert notice';
    }

    return null; // Passes quality gate
}

// --- Contradiction Detection ---

/**
 * Check if a new memory contradicts existing ones.
 * Returns the contradicting memory if found.
 */
export function findContradiction(
    memoryStore: MemoryStore,
    newIntent: string,
    newType: MemoryType,
): { contradicts: string; existingId: string; existingIntent: string } | null {
    // Only check decisions, corrections, conventions against each other
    const typesToCheck = [MemoryType.DECISION, MemoryType.CORRECTION, MemoryType.CONVENTION];
    if (!typesToCheck.includes(newType)) return null;

    const newLower = newIntent.toLowerCase();

    // Strategy 1: Direct word-level contradiction
    // "use X" vs "don't use X", "always Y" vs "never Y"
    const useMatch = newLower.match(/\b(?:use|choose|pick|go with|switch to)\s+(\w+(?:\s+\w+)?)/);
    const dontUseMatch = newLower.match(/\b(?:don'?t|never|avoid|stop)\s+(?:use|using)\s+(\w+(?:\s+\w+)?)/);

    if (useMatch || dontUseMatch) {
        const keyword = (useMatch?.[1] || dontUseMatch?.[1] || '').toLowerCase();
        if (keyword.length < 3) return null;

        // Search existing memories for the opposite
        for (const type of typesToCheck) {
            const existing = memoryStore.getByType(type, 100);
            for (const m of existing) {
                const existLower = m.intent.toLowerCase();

                if (useMatch) {
                    // New says "use X", check if existing says "don't use X"
                    if (existLower.includes(keyword) &&
                        /\b(?:don'?t|never|avoid|stop)\s+(?:use|using)/i.test(existLower)) {
                        return {
                            contradicts: `New says "use ${keyword}" but existing says "${m.intent}"`,
                            existingId: m.id,
                            existingIntent: m.intent,
                        };
                    }
                }

                if (dontUseMatch) {
                    // New says "don't use X", check if existing says "use X"
                    if (existLower.includes(keyword) &&
                        /\b(?:use|choose|pick|go with)\b/i.test(existLower) &&
                        !/\b(?:don'?t|never|avoid)\b/i.test(existLower)) {
                        return {
                            contradicts: `New says "don't use ${keyword}" but existing says "${m.intent}"`,
                            existingId: m.id,
                            existingIntent: m.intent,
                        };
                    }
                }
            }
        }
    }

    // Strategy 2: Same topic, different conclusion
    // If two DECISION memories mention the same noun but have different verbs
    if (newType === MemoryType.DECISION) {
        const decisions = memoryStore.getByType(MemoryType.DECISION, 200);
        for (const existing of decisions) {
            const existLower = existing.intent.toLowerCase();
            // Extract key nouns (words > 4 chars, not stopwords)
            const stopwords = new Set(['should', 'would', 'could', 'about', 'their', 'these', 'those', 'which', 'there', 'where', 'while']);
            const newNouns = newLower.split(/\s+/).filter(w => w.length > 4 && !stopwords.has(w));
            const existNouns = existLower.split(/\s+/).filter(w => w.length > 4 && !stopwords.has(w));

            // Count overlapping nouns
            const overlap = newNouns.filter(w => existNouns.includes(w));
            if (overlap.length >= 2) {
                // Same topic detected. Check if conclusion differs.
                // Simple: if both are decisions about the same topic, flag it
                return {
                    contradicts: `Possible contradiction: both discuss "${overlap.join(', ')}"`,
                    existingId: existing.id,
                    existingIntent: existing.intent,
                };
            }
        }
    }

    return null;
}

/**
 * Store a memory with quality + contradiction checks.
 * Returns the stored memory or null if rejected.
 */
export function storeWithQuality(
    memoryStore: MemoryStore,
    params: {
        type: MemoryType;
        intent: string;
        action?: string;
        reason?: string;
        importance: number;
        confidence: number;
        tags: string[];
        relatedFiles?: string[];
    },
): any | null {
    // Quality gate
    const rejection = qualityCheck(params.intent, params.type);
    if (rejection) {
        console.log(`  [REJECT] Memory rejected: ${rejection} -- "${params.intent.slice(0, 60)}"`);
        return null;
    }

    // Contradiction check
    const contradiction = findContradiction(memoryStore, params.intent, params.type);
    if (contradiction) {
        console.log(`  [WARN] Contradiction: ${contradiction.contradicts}`);
        console.log(`  [WARN] Existing: "${contradiction.existingIntent.slice(0, 80)}"`);
        // Store the NEW one but mark the OLD as less important
        memoryStore.update(contradiction.existingId, {
            importance: 0.3, // Demote old contradicting memory
            tags: ['contradicted'],
        });
        console.log(`  [WARN] Demoted old memory, storing new one`);
    }

    // Store
    return memoryStore.add({
        type: params.type,
        intent: params.intent.slice(0, 300),
        action: params.action || `Stored: ${params.intent.slice(0, 200)}`,
        reason: params.reason || undefined,
        relatedFiles: params.relatedFiles || [],
        tags: params.tags,
        confidence: params.confidence,
        importance: params.importance,
        timestamp: Date.now(),
        isActive: true,
        accessCount: 0,
        createdAt: Date.now(),
        id: '',
    });
}
