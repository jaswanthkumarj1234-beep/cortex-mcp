/**
 * Auto-Learner — Extracts memory-worthy patterns from text automatically.
 *
 * How it works:
 * 1. The AI passes its response text to `auto_learn` tool after every reply
 * 2. This module scans for decision/correction/convention/bug-fix patterns
 * 3. Matching patterns are stored automatically — zero manual effort
 *
 * Pattern detection uses keyword signals + sentence structure analysis.
 * No LLM needed — pure regex + heuristics, fast and reliable.
 */

export type MemoryType = 'DECISION' | 'CORRECTION' | 'CONVENTION' | 'BUG_FIX' | 'INSIGHT'
    | 'FAILED_ATTEMPT' | 'BUSINESS_RULE' | 'GOTCHA' | 'CURRENT_TASK';

export interface ExtractedMemory {
    type: MemoryType;
    content: string;
    confidence: number; // 0.0 - 1.0
    reason: string;
}

// ─── Signal Patterns ──────────────────────────────────────────────────────────

const PATTERNS: Array<{
    type: MemoryType;
    signals: RegExp[];
    confidence: number;
    reason: string;
}> = [
        // CORRECTION — "don't use X", "never do Y", "avoid Z", "wrong approach"
        {
            type: 'CORRECTION',
            signals: [
                /\b(don'?t|do not|never|avoid|stop using|instead of|rather than)\b.{5,80}/gi,
                /\b(wrong|incorrect|mistake|bug|error|issue|problem)\b.{5,60}(fix|correct|should|use|replace)/gi,
                /\b(fixed|corrected|resolved)\b.{5,60}/gi,
            ],
            confidence: 0.75,
            reason: 'Auto-detected correction pattern',
        },

        // DECISION — "we decided", "we'll use", "going with", "chosen"
        {
            type: 'DECISION',
            signals: [
                /\b(we('ll| will| are going to| decided to)?)\s+(use|adopt|switch|go with|choose|pick|implement)\b.{5,80}/gi,
                /\b(decided|chosen|selected|picked|going with|sticking with)\b.{5,80}/gi,
                /\b(use|using)\s+\w+\s+(instead of|over|rather than)\s+\w+/gi,
            ],
            confidence: 0.70,
            reason: 'Auto-detected decision pattern',
        },

        // CONVENTION — "always", "should always", "must", "standard", "convention"
        {
            type: 'CONVENTION',
            signals: [
                /\b(always|must|should always|make sure to|remember to|convention|standard|rule)\b.{5,80}/gi,
                /\b(format|naming|style|pattern|structure)\b.{5,60}(should|must|always|use)/gi,
                /\b(use\s+\w+\s+for\s+all|every\s+\w+\s+should|all\s+\w+\s+must)\b.{5,60}/gi,
            ],
            confidence: 0.65,
            reason: 'Auto-detected convention pattern',
        },

        // BUG_FIX — "the bug was", "root cause", "the fix is", "was causing"
        {
            type: 'BUG_FIX',
            signals: [
                /\b(bug|the (issue|problem|cause) was|root cause|was causing|the fix)\b.{5,80}/gi,
                /\b(fixed by|resolved by|the solution (is|was))\b.{5,80}/gi,
                /\b(crash|exception|error|fail(ed|ure)?)\b.{5,60}(because|due to|caused by|fixed)/gi,
            ],
            confidence: 0.80,
            reason: 'Auto-detected bug fix pattern',
        },

        // INSIGHT — "key insight", "important to note", "worth remembering"
        {
            type: 'INSIGHT',
            signals: [
                /\b(key insight|important(ly)?|worth (noting|remembering)|note that|keep in mind)\b.{5,80}/gi,
                /\b(the reason (is|why)|this (works|happens) because)\b.{5,80}/gi,
            ],
            confidence: 0.55,
            reason: 'Auto-detected insight pattern',
        },

        // ─── NEW PATTERNS ─────────────────────────────────────────────────

        // FAILED_ATTEMPT — "didn't work", "tried X but", "doesn't solve", "abandoned"
        {
            type: 'FAILED_ATTEMPT',
            signals: [
                /\b(didn'?t work|does(n'?t| not) work|failed|not working|broken)\b.{5,80}/gi,
                /\btried\b.{3,60}\b(but|however|didn'?t|failed|abandoned|gave up)\b/gi,
                /\b(abandoned|scrapped|reverted|rolled back|gave up on)\b.{5,80}/gi,
                /\b(doesn'?t solve|won'?t fix|not the (right|correct) approach)\b.{5,80}/gi,
            ],
            confidence: 0.75,
            reason: 'Auto-detected failed attempt — prevents repeating dead ends',
        },

        // BUSINESS_RULE — "users can", "admins have", "when X then Y", domain logic
        {
            type: 'BUSINESS_RULE',
            signals: [
                /\b(users?|admins?|editors?|viewers?|customers?|clients?|members?)\s+(can|cannot|must|should|have|are allowed|are not allowed)\b.{5,80}/gi,
                /\b(role|permission|access|authorization)\b.{5,60}\b(admin|editor|viewer|owner|manager|user)\b/gi,
                /\bwhen\s+.{5,40}\s+(then|must|should|always|never)\b.{5,60}/gi,
                /\b(business rule|domain rule|requirement|constraint)\b.{3,80}/gi,
                /\b(only\s+(admins?|owners?|managers?)\s+can)\b.{5,60}/gi,
            ],
            confidence: 0.70,
            reason: 'Auto-detected business rule / domain logic',
        },

        // GOTCHA — "be careful", "watch out", "NEVER do X on Y", "dangerous"
        {
            type: 'GOTCHA',
            signals: [
                /\b(be careful|watch out|careful with|danger(ous)?|warning|caution)\b.{5,80}/gi,
                /\bNEVER\b.{5,80}/g,  // uppercase NEVER = strong warning
                /\b(will (break|crash|delete|corrupt|destroy))\b.{5,60}/gi,
                /\b(cascad(e|ing) delete|data loss|side effect|race condition)\b.{5,60}/gi,
                /\b(gotcha|pitfall|trap|footgun|sharp edge)\b.{5,60}/gi,
            ],
            confidence: 0.80,
            reason: 'Auto-detected gotcha/warning — prevents dangerous operations',
        },

        // CURRENT_TASK — "working on", "current priority", "this week", "next step"
        {
            type: 'CURRENT_TASK',
            signals: [
                /\b(working on|building|implementing|focusing on)\b.{5,80}/gi,
                /\b(current(ly)?|right now|this (week|sprint|phase))\b.{5,60}\b(priority|focus|task|goal)\b/gi,
                /\b(priority is|main (goal|task|focus) is)\b.{5,80}/gi,
                /\b(next step|todo|to-do|need to (build|implement|fix|add))\b.{5,80}/gi,
            ],
            confidence: 0.60,
            reason: 'Auto-detected current task / priority',
        },
    ];

// ─── Sentence Splitter ────────────────────────────────────────────────────────

function splitSentences(text: string): string[] {
    // Split on sentence boundaries, keeping reasonable length
    return text
        .replace(/\n+/g, ' ')
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 20 && s.length < 300);
}

// ─── Dedup Filter ─────────────────────────────────────────────────────────────

function normalize(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

// ─── Main Extractor ───────────────────────────────────────────────────────────

export function extractMemories(text: string): ExtractedMemory[] {
    if (!text || text.length < 30) return [];

    const sentences = splitSentences(text);
    const results: ExtractedMemory[] = [];
    const seen = new Set<string>();

    for (const sentence of sentences) {
        for (const pattern of PATTERNS) {
            let matched = false;
            for (const signal of pattern.signals) {
                signal.lastIndex = 0; // reset regex state
                if (signal.test(sentence)) {
                    matched = true;
                    break;
                }
            }

            if (!matched) continue;

            // Clean up the sentence for storage
            const content = sentence
                .replace(/^(so|and|but|also|note that|remember that|keep in mind that)\s+/i, '')
                .replace(/\s+/g, ' ')
                .trim();

            if (content.length < 15) continue;

            // Dedup by normalized content
            const key = `${pattern.type}:${normalize(content).slice(0, 60)}`;
            if (seen.has(key)) continue;
            seen.add(key);

            results.push({
                type: pattern.type,
                content,
                confidence: pattern.confidence,
                reason: pattern.reason,
            });

            break; // One match per sentence is enough
        }
    }

    // Return only high-confidence matches (avoid noise)
    return results.filter(r => r.confidence >= 0.55);
}
