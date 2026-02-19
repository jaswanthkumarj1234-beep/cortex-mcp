/**
 * Context Builder — Builds dynamic context for brain/context resource.
 *
 * Combines project info + top memories + relevant corrections
 * into a compressed context string that fits any model's context window.
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';
import { CONFIG } from '../config/config';

export class ContextBuilder {
    private memoryStore: MemoryStore;

    constructor(memoryStore: MemoryStore) {
        this.memoryStore = memoryStore;
    }

    /** Build the full context string for injection */
    build(options?: { currentFile?: string; maxChars?: number }): string {
        const maxChars = options?.maxChars || CONFIG.MAX_CONTEXT_CHARS;
        const parts: string[] = [];

        // 1. ALL Corrections (highest priority — prevent repeated mistakes)
        const corrections = this.memoryStore.getByType(MemoryType.CORRECTION, 500);
        if (corrections.length > 0) {
            parts.push('## Corrections (DO NOT repeat these mistakes)');
            for (const c of corrections) {
                parts.push(`- ${c.intent}${c.reason ? ` (${c.reason})` : ''}`);
            }
        }

        // 2. ALL Decisions (architectural choices)
        const decisions = this.memoryStore.getByType(MemoryType.DECISION, 500);
        if (decisions.length > 0) {
            parts.push('\n## Decisions');
            for (const d of decisions) {
                parts.push(`- ${d.intent}${d.reason ? ` — ${d.reason}` : ''}`);
            }
        }

        // 3. ALL Conventions (coding standards)
        const conventions = this.memoryStore.getByType(MemoryType.CONVENTION, 500);
        if (conventions.length > 0) {
            parts.push('\n## Conventions');
            for (const c of conventions) {
                parts.push(`- ${c.intent}`);
            }
        }

        // 4. ALL Bug Fixes (prevent re-introducing bugs)
        const bugFixes = this.memoryStore.getByType(MemoryType.BUG_FIX, 500);
        if (bugFixes.length > 0) {
            parts.push('\n## Bug Fixes (already solved — do not re-introduce)');
            for (const b of bugFixes) {
                parts.push(`- ${b.intent}${b.reason ? ` — ${b.reason}` : ''}`);
            }
        }

        // 5. Failed Suggestions (things that were tried and didn't work)
        const failed = this.memoryStore.getByType(MemoryType.FAILED_SUGGESTION, 50);
        if (failed.length > 0) {
            parts.push('\n## Failed Attempts (DO NOT suggest these again)');
            for (const f of failed.slice(0, 10)) {
                parts.push(`- ${f.intent}${f.reason ? ` — ${f.reason}` : ''}`);
            }
        }

        // 6. Proven Patterns (things that work well)
        const patterns = this.memoryStore.getByType(MemoryType.PROVEN_PATTERN, 50);
        if (patterns.length > 0) {
            parts.push('\n## Proven Patterns');
            for (const p of patterns.slice(0, 10)) {
                parts.push(`- ${p.intent}`);
            }
        }

        // 7. File-specific context (if a file is provided)
        if (options?.currentFile) {
            const fileMemories = this.memoryStore.getByFile(options.currentFile, 5);
            if (fileMemories.length > 0) {
                parts.push(`\n## Context for ${options.currentFile}`);
                for (const m of fileMemories) {
                    parts.push(`- [${m.type}] ${m.intent}`);
                }
            }
        }

        // 5. Dependencies (what the project uses)
        const deps = this.memoryStore.getByType(MemoryType.DEPENDENCY, 3);
        if (deps.length > 0) {
            parts.push('\n## Stack');
            for (const d of deps) {
                parts.push(`- ${d.intent}`);
            }
        }

        let context = parts.join('\n');

        // Compress if over budget
        if (context.length > maxChars) {
            context = this.compress(context, maxChars);
        }

        // Header
        return `# Brain Context (Auto-Injected)\n\n${context}\n\n> Always call \`recall_memory\` for specific queries.`;
    }

    /** Compress context to fit within character budget */
    private compress(text: string, maxChars: number): string {
        const lines = text.split('\n');
        let result = '';

        for (const line of lines) {
            if (result.length + line.length + 1 > maxChars) break;
            result += line + '\n';
        }

        return result.trimEnd();
    }
}
