/**
 * Memory Export/Import — Backup, share, and transfer memories.
 * 
 * Export: Writes all active memories to a JSON file
 * Import: Reads a JSON file and merges memories (dedup-aware)
 */
import * as fs from 'fs';
import * as path from 'path';
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

export interface ExportedMemory {
    id: string;
    type: string;
    intent: string;
    action: string;
    reason: string | null;
    tags: string[];
    relatedFiles: string[];
    confidence: number;
    importance: number;
    accessCount: number;
    createdAt: number;
    timestamp: string;
}

export interface ExportBundle {
    version: 1;
    exportedAt: string;
    memoryCount: number;
    memories: ExportedMemory[];
}

/**
 * Export all active memories to a JSON bundle
 */
export function exportMemories(memoryStore: MemoryStore): ExportBundle {
    const active = memoryStore.getActive(5000);

    const memories: ExportedMemory[] = active.map(m => ({
        id: m.id,
        type: m.type,
        intent: m.intent,
        action: m.action,
        reason: m.reason || null,
        tags: m.tags || [],
        relatedFiles: m.relatedFiles || [],
        confidence: m.confidence,
        importance: m.importance,
        accessCount: m.accessCount,
        createdAt: m.createdAt,
        timestamp: new Date(m.createdAt).toISOString(),
    }));

    return {
        version: 1,
        exportedAt: new Date().toISOString(),
        memoryCount: memories.length,
        memories,
    };
}

/**
 * Export memories to a file
 */
export function exportToFile(memoryStore: MemoryStore, filePath: string): { count: number; path: string } {
    const bundle = exportMemories(memoryStore);
    const resolved = path.resolve(filePath);
    fs.writeFileSync(resolved, JSON.stringify(bundle, null, 2), 'utf-8');
    return { count: bundle.memoryCount, path: resolved };
}

/**
 * Import memories from a JSON bundle, skipping duplicates
 */
export function importMemories(
    memoryStore: MemoryStore,
    bundle: ExportBundle
): { imported: number; skipped: number; errors: number } {
    let imported = 0;
    let skipped = 0;
    let errors = 0;

    // Load active memories ONCE — O(n) instead of O(n²)
    const active = memoryStore.getActive(5000);
    const existingKeys = new Set(
        active.map(e => `${e.type}::${e.intent.toLowerCase().trim()}`)
    );

    for (const m of bundle.memories) {
        try {
            const key = `${m.type}::${m.intent.toLowerCase().trim()}`;
            if (existingKeys.has(key)) {
                skipped++;
                continue;
            }

            memoryStore.add({
                type: m.type as MemoryType,
                intent: m.intent,
                action: m.action,
                reason: m.reason || undefined,
                tags: m.tags,
                relatedFiles: m.relatedFiles,
                confidence: m.confidence,
                importance: m.importance,
            });
            existingKeys.add(key); // Prevent dupes within the same import batch
            imported++;
        } catch {
            errors++;
        }
    }

    return { imported, skipped, errors };
}

/**
 * Import memories from a file
 */
export function importFromFile(
    memoryStore: MemoryStore,
    filePath: string
): { imported: number; skipped: number; errors: number } {
    const resolved = path.resolve(filePath);
    const content = fs.readFileSync(resolved, 'utf-8');
    const bundle: ExportBundle = JSON.parse(content);

    if (bundle.version !== 1) {
        throw new Error(`Unsupported export version: ${bundle.version}`);
    }

    return importMemories(memoryStore, bundle);
}
