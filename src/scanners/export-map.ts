/**
 * Export Map — Builds a complete map of all exported functions/classes/types
 * across the entire project. This is the anti-hallucination weapon.
 *
 * When AI tries to use a function that doesn't exist, this module:
 * 1. Provides the full list of REAL exports per file
 * 2. Suggests the closest matching REAL function
 * 3. Stores the export map as memories so it's injected at conversation start
 *
 * This prevents the #1 hallucination: AI inventing functions that don't exist.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

export interface ExportEntry {
    file: string;           // relative file path
    name: string;           // exported name
    kind: 'function' | 'class' | 'const' | 'type' | 'interface' | 'enum' | 'default';
    signature?: string;     // function(a, b): return or class Foo extends Bar
}

export interface ExportMap {
    files: Map<string, ExportEntry[]>;  // file → exports
    allExports: ExportEntry[];          // flat list
    totalFiles: number;
    totalExports: number;
}

/** Build complete export map for the project */
export function buildExportMap(workspaceRoot: string): ExportMap {
    const files = new Map<string, ExportEntry[]>();
    const allExports: ExportEntry[] = [];

    const srcDirs = ['src', 'lib', 'app', 'pages', 'components', 'utils', 'services', 'hooks', 'api'];
    const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];

    for (const dir of srcDirs) {
        const dirPath = path.join(workspaceRoot, dir);
        if (!fs.existsSync(dirPath)) continue;
        scanDir(dirPath, workspaceRoot, files, allExports, extensions, 0);
    }

    // Also check root-level files
    try {
        const rootFiles = fs.readdirSync(workspaceRoot);
        for (const f of rootFiles) {
            if (extensions.some(ext => f.endsWith(ext)) && !f.includes('.d.ts') && !f.includes('node_modules')) {
                const fullPath = path.join(workspaceRoot, f);
                if (fs.statSync(fullPath).isFile()) {
                    extractFileExports(fullPath, workspaceRoot, files, allExports);
                }
            }
        }
    } catch { }

    return {
        files,
        allExports,
        totalFiles: files.size,
        totalExports: allExports.length,
    };
}

/** Store export map as memories for AI context injection */
export function storeExportMap(memoryStore: MemoryStore, exportMap: ExportMap): number {
    if (exportMap.totalExports === 0) return 0;

    // Remove previous export map memories
    const existing = memoryStore.getActive(500).filter(m => m.tags?.includes('export-map'));
    for (const m of existing) {
        try { memoryStore.deactivate(m.id, 'export-map-refresh'); } catch { }
    }

    // Group by directory for compact storage
    const byDir = new Map<string, string[]>();
    for (const entry of exportMap.allExports) {
        const dir = path.dirname(entry.file);
        if (!byDir.has(dir)) byDir.set(dir, []);
        const sig = entry.signature ? ` — ${entry.signature}` : '';
        byDir.get(dir)!.push(`${entry.name} (${entry.kind})${sig}`);
    }

    let stored = 0;
    for (const [dir, exports] of byDir) {
        const exportList = exports.slice(0, 30).join(', ');
        memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: `Available exports in ${dir}/: ${exports.length} items`,
            action: exportList,
            tags: ['export-map', 'anti-hallucination', dir],
            confidence: 0.9,
            importance: 0.6,
            timestamp: Date.now(),
            isActive: true,
            accessCount: 0,
            createdAt: Date.now(),
            id: '',
        });
        stored++;
    }

    return stored;
}

/** Format export map for compact context injection */
export function formatExportMap(exportMap: ExportMap): string {
    if (exportMap.totalExports === 0) return '';

    const lines: string[] = [`## [API] Project Exports (${exportMap.totalExports} exports across ${exportMap.totalFiles} files)`];

    // Group by directory, show top exports
    const byDir = new Map<string, ExportEntry[]>();
    for (const entry of exportMap.allExports) {
        const dir = path.dirname(entry.file);
        if (!byDir.has(dir)) byDir.set(dir, []);
        byDir.get(dir)!.push(entry);
    }

    for (const [dir, entries] of [...byDir.entries()].slice(0, 8)) {
        const names = entries.slice(0, 10).map(e => {
            if (e.kind === 'function') return `${e.name}()`;
            if (e.kind === 'class') return `class ${e.name}`;
            return e.name;
        });
        lines.push(`**${dir}/** → ${names.join(', ')}`);
    }

    return lines.join('\n');
}

/** Find closest matching real export for a hallucinated name */
export function suggestRealExport(exportMap: ExportMap, hallucinated: string): string[] {
    const lower = hallucinated.toLowerCase();
    const suggestions: { name: string; file: string; score: number }[] = [];

    for (const entry of exportMap.allExports) {
        const entryLower = entry.name.toLowerCase();

        // Exact substring match
        if (entryLower.includes(lower) || lower.includes(entryLower)) {
            suggestions.push({ name: entry.name, file: entry.file, score: 0.9 });
            continue;
        }

        // Check similar characters (basic similarity)
        const commonChars = [...lower].filter(c => entryLower.includes(c)).length;
        const similarity = commonChars / Math.max(lower.length, entryLower.length);
        if (similarity > 0.5) {
            suggestions.push({ name: entry.name, file: entry.file, score: similarity });
        }
    }

    return suggestions
        .sort((a, b) => b.score - a.score)
        .slice(0, 5)
        .map(s => `${s.name} (from ${s.file})`);
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function scanDir(
    dir: string,
    root: string,
    files: Map<string, ExportEntry[]>,
    all: ExportEntry[],
    extensions: string[],
    depth: number,
): void {
    if (depth > 5) return;

    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build') continue;

            const fullPath = path.join(dir, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                scanDir(fullPath, root, files, all, extensions, depth + 1);
            } else if (stat.isFile() && extensions.some(ext => entry.endsWith(ext)) && !entry.includes('.d.ts')) {
                extractFileExports(fullPath, root, files, all);
            }
        }
    } catch { }
}

function extractFileExports(
    fullPath: string,
    root: string,
    files: Map<string, ExportEntry[]>,
    all: ExportEntry[],
): void {
    try {
        const content = fs.readFileSync(fullPath, 'utf-8');
        const relativePath = path.relative(root, fullPath).replace(/\\/g, '/');
        const exports: ExportEntry[] = [];

        // Pattern → kind mapping
        const patterns: Array<{ regex: RegExp; kind: ExportEntry['kind']; sigExtract?: boolean }> = [
            { regex: /export\s+(?:async\s+)?function\s+(\w+)\s*(\([^)]*\))/g, kind: 'function', sigExtract: true },
            { regex: /export\s+(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g, kind: 'class', sigExtract: true },
            { regex: /export\s+const\s+(\w+)/g, kind: 'const' },
            { regex: /export\s+let\s+(\w+)/g, kind: 'const' },
            { regex: /export\s+enum\s+(\w+)/g, kind: 'enum' },
            { regex: /export\s+interface\s+(\w+)/g, kind: 'interface' },
            { regex: /export\s+type\s+(\w+)/g, kind: 'type' },
            { regex: /export\s+default\s+(?:class|function)\s+(\w+)/g, kind: 'default' },
        ];

        for (const { regex, kind, sigExtract } of patterns) {
            let match;
            while ((match = regex.exec(content)) !== null) {
                const entry: ExportEntry = {
                    file: relativePath,
                    name: match[1],
                    kind,
                };
                if (sigExtract && match[2]) {
                    entry.signature = kind === 'function'
                        ? `${match[1]}${match[2]}`
                        : `class ${match[1]} extends ${match[2]}`;
                }
                exports.push(entry);
            }
        }

        // Handle export { foo, bar }
        const reExport = /export\s*\{\s*([^}]+)\s*\}/g;
        let match;
        while ((match = reExport.exec(content)) !== null) {
            const names = match[1].split(',').map(n => {
                const parts = n.trim().split(/\s+as\s+/);
                return parts[parts.length - 1].trim();
            });
            for (const name of names) {
                if (name && /^\w+$/.test(name)) {
                    exports.push({ file: relativePath, name, kind: 'const' });
                }
            }
        }

        if (exports.length > 0) {
            files.set(relativePath, exports);
            all.push(...exports);
        }
    } catch { }
}
