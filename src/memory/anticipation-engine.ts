/**
 * Anticipation Engine — Proactive memory surfacing.
 *
 * Instead of waiting to be asked, this module predicts what memories
 * are relevant based on the current file, directory, and recent activity.
 *
 * Like how walking into your kitchen makes you remember you need milk.
 */
import { MemoryStore } from '../db/memory-store';
import { MemoryType, ScoredMemory } from '../types';

export interface AnticipationResult {
    fileMemories: ScoredMemory[];
    directoryMemories: ScoredMemory[];
    relatedTypeMemories: ScoredMemory[];
}

export function anticipate(
    memoryStore: MemoryStore,
    currentFile?: string,
): AnticipationResult {
    const result: AnticipationResult = {
        fileMemories: [],
        directoryMemories: [],
        relatedTypeMemories: [],
    };

    if (!currentFile) return result;

    // 1. Direct file memories — exact file match
    const fileMemories = memoryStore.getByFile(currentFile, 10);
    result.fileMemories = fileMemories.map((m, i) => ({
        memory: m,
        score: 1.0 - (i * 0.05),
        matchMethod: 'anticipation:file',
    }));

    // 2. Directory memories — same folder = likely related
    const dir = currentFile.replace(/[\\/][^\\/]+$/, '');
    if (dir && dir !== currentFile) {
        const allActive = memoryStore.getActive(200);
        const dirMemories = allActive.filter(m =>
            m.relatedFiles?.some(f => f.startsWith(dir) || f.includes(dir))
        );
        result.directoryMemories = dirMemories.slice(0, 5).map((m, i) => ({
            memory: m,
            score: 0.7 - (i * 0.05),
            matchMethod: 'anticipation:directory',
        }));
    }

    // 3. File type memories — .ts file? surface TS-related conventions
    const ext = currentFile.split('.').pop()?.toLowerCase();
    if (ext) {
        const typeKeywords: Record<string, string[]> = {
            ts: ['typescript', 'type', 'interface', 'enum'],
            tsx: ['react', 'component', 'jsx', 'hook', 'state'],
            css: ['style', 'css', 'theme', 'color', 'font'],
            py: ['python', 'pip', 'def', 'class'],
            js: ['javascript', 'node', 'require', 'module'],
            sql: ['database', 'query', 'table', 'migration'],
            json: ['config', 'package', 'settings'],
        };
        const keywords = typeKeywords[ext];
        if (keywords) {
            const conventions = memoryStore.getByType(MemoryType.CONVENTION, 50);
            const matched = conventions.filter(c =>
                keywords.some(k => c.intent.toLowerCase().includes(k))
            );
            result.relatedTypeMemories = matched.slice(0, 3).map((m, i) => ({
                memory: m,
                score: 0.5 - (i * 0.05),
                matchMethod: 'anticipation:filetype',
            }));
        }
    }

    return result;
}

/** Format anticipation results for injection */
export function formatAnticipation(result: AnticipationResult): string {
    const all = [
        ...result.fileMemories,
        ...result.directoryMemories,
        ...result.relatedTypeMemories,
    ];

    if (all.length === 0) return '';

    const lines: string[] = ['## 🔮 Anticipated Context (for current file)'];
    const seen = new Set<string>();
    for (const m of all.slice(0, 8)) {
        if (seen.has(m.memory.id)) continue;
        seen.add(m.memory.id);
        lines.push(`- [${m.memory.type}] ${m.memory.intent}${m.memory.reason ? ` — ${m.memory.reason}` : ''}`);
    }
    return lines.join('\n');
}
