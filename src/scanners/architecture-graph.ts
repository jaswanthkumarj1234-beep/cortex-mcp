/**
 * Architecture Graph — Deep project architecture understanding.
 *
 * Goes beyond "what imports what" to understand:
 * 1. Layers: UI → API → Service → Database (directional)
 * 2. Module boundaries: which directories are self-contained
 * 3. Circular dependencies (red flags)
 * 4. Entry points and leaf nodes
 * 5. API endpoints (Express/Next.js route scanning)
 *
 * This solves the "AI doesn't understand architecture" problem by giving
 * it a structural map that goes deeper than file listing.
 */
import * as fs from 'fs';
import * as path from 'path';
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

export interface ArchNode {
    file: string;            // relative path
    directory: string;       // parent directory
    imports: string[];       // files this imports
    importedBy: string[];    // files that import this
    isEntryPoint: boolean;
    isLeaf: boolean;         // imports nothing local
}

export interface ArchLayer {
    name: string;            // e.g., "UI", "API", "Services", "Database"
    directories: string[];
    fileCount: number;
}

export interface ArchGraph {
    nodes: Map<string, ArchNode>;
    layers: ArchLayer[];
    circularDeps: Array<[string, string]>;
    entryPoints: string[];
    leafNodes: string[];
    apiEndpoints: string[];
    totalFiles: number;
}

/** Build full architecture graph for the project */
export function buildArchitectureGraph(workspaceRoot: string): ArchGraph {
    const nodes = new Map<string, ArchNode>();
    const srcDirs = ['src', 'lib', 'app', 'pages', 'components', 'utils', 'services', 'api', 'routes', 'controllers', 'models', 'hooks'];
    const extensions = ['.ts', '.tsx', '.js', '.jsx'];

    // Phase 1: Collect all files and their imports
    for (const dir of srcDirs) {
        const dirPath = path.join(workspaceRoot, dir);
        if (!fs.existsSync(dirPath)) continue;
        collectNodes(dirPath, workspaceRoot, nodes, extensions, 0);
    }

    // Phase 2: Build reverse edges (importedBy)
    for (const [file, node] of nodes) {
        for (const imp of node.imports) {
            const target = nodes.get(imp);
            if (target) {
                target.importedBy.push(file);
            }
        }
    }

    // Phase 3: Detect entry points and leaf nodes
    const entryPoints: string[] = [];
    const leafNodes: string[] = [];
    for (const [file, node] of nodes) {
        if (node.importedBy.length === 0) {
            node.isEntryPoint = true;
            entryPoints.push(file);
        }
        if (node.imports.length === 0) {
            node.isLeaf = true;
            leafNodes.push(file);
        }
    }

    // Phase 4: Detect circular dependencies
    const circularDeps: Array<[string, string]> = [];
    for (const [file, node] of nodes) {
        for (const imp of node.imports) {
            const target = nodes.get(imp);
            if (target && target.imports.includes(file)) {
                const pair: [string, string] = [file, imp].sort() as [string, string];
                if (!circularDeps.some(c => c[0] === pair[0] && c[1] === pair[1])) {
                    circularDeps.push(pair);
                }
            }
        }
    }

    // Phase 5: Detect layers by directory naming patterns
    const layers = detectLayers(nodes);

    // Phase 6: Detect API endpoints
    const apiEndpoints = detectEndpoints(workspaceRoot, nodes);

    return {
        nodes,
        layers,
        circularDeps,
        entryPoints,
        leafNodes,
        apiEndpoints,
        totalFiles: nodes.size,
    };
}

/** Store architecture graph as memories */
export function storeArchitectureGraph(memoryStore: MemoryStore, graph: ArchGraph): number {
    if (graph.totalFiles === 0) return 0;

    // Remove old architecture memories
    const existing = memoryStore.getActive(500).filter(m => m.tags?.includes('architecture-graph'));
    for (const m of existing) {
        try { memoryStore.deactivate(m.id, 'arch-graph-refresh'); } catch { }
    }

    let stored = 0;

    // Store layer info
    if (graph.layers.length > 0) {
        const layerText = graph.layers
            .map(l => `${l.name}: ${l.directories.join(', ')} (${l.fileCount} files)`)
            .join('\n');
        memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: `Architecture layers: ${graph.layers.map(l => l.name).join(' → ')}`,
            action: layerText,
            tags: ['architecture-graph', 'layers'],
            confidence: 0.85, importance: 0.8,
            timestamp: Date.now(), isActive: true, accessCount: 0, createdAt: Date.now(), id: '',
        });
        stored++;
    }

    // Store circular deps (high importance — these are problems)
    if (graph.circularDeps.length > 0) {
        memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: `[WARN] Circular dependencies detected: ${graph.circularDeps.length} pairs`,
            action: graph.circularDeps.map(([a, b]) => `${a} ↔ ${b}`).slice(0, 10).join('\n'),
            tags: ['architecture-graph', 'circular-dep', 'warning'],
            confidence: 0.95, importance: 0.9,
            timestamp: Date.now(), isActive: true, accessCount: 0, createdAt: Date.now(), id: '',
        });
        stored++;
    }

    // Store API endpoints
    if (graph.apiEndpoints.length > 0) {
        memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: `API endpoints: ${graph.apiEndpoints.length} routes detected`,
            action: graph.apiEndpoints.slice(0, 20).join('\n'),
            tags: ['architecture-graph', 'api-endpoints'],
            confidence: 0.85, importance: 0.75,
            timestamp: Date.now(), isActive: true, accessCount: 0, createdAt: Date.now(), id: '',
        });
        stored++;
    }

    // Store entry points + leaf nodes
    memoryStore.add({
        type: MemoryType.INSIGHT,
        intent: `Architecture: ${graph.totalFiles} files, ${graph.entryPoints.length} entry points, ${graph.leafNodes.length} leaf nodes`,
        action: `Entry points: ${graph.entryPoints.slice(0, 5).join(', ')}\nLeaf nodes (no local imports): ${graph.leafNodes.slice(0, 10).join(', ')}`,
        tags: ['architecture-graph', 'structure'],
        confidence: 0.85, importance: 0.7,
        timestamp: Date.now(), isActive: true, accessCount: 0, createdAt: Date.now(), id: '',
    });
    stored++;

    return stored;
}

/** Format architecture graph for compact context injection */
export function formatArchitectureGraph(graph: ArchGraph): string {
    if (graph.totalFiles === 0) return '';

    const lines: string[] = [`## [ARCHITECTURE] Project Graph (${graph.totalFiles} files)`];

    // Layers
    if (graph.layers.length > 0) {
        lines.push(`**Layers:** ${graph.layers.map(l => `${l.name}(${l.fileCount})`).join(' → ')}`);
    }

    // Entry points
    if (graph.entryPoints.length > 0) {
        lines.push(`**Entry points:** ${graph.entryPoints.slice(0, 3).join(', ')}`);
    }

    // Circular deps (warnings)
    if (graph.circularDeps.length > 0) {
        lines.push(`**[WARN] Circular deps:** ${graph.circularDeps.slice(0, 3).map(([a, b]) => `${a}↔${b}`).join(', ')}`);
    }

    // API endpoints
    if (graph.apiEndpoints.length > 0) {
        lines.push(`**API:** ${graph.apiEndpoints.slice(0, 5).join(', ')}`);
    }

    return lines.join('\n');
}

// ─── Internal Helpers ─────────────────────────────────────────────────────────

function collectNodes(
    dir: string,
    root: string,
    nodes: Map<string, ArchNode>,
    extensions: string[],
    depth: number,
): void {
    if (depth > 5) return;

    try {
        const entries = fs.readdirSync(dir);
        for (const entry of entries) {
            if (entry.startsWith('.') || entry === 'node_modules' || entry === 'dist' || entry === 'build' || entry === '__tests__') continue;

            const fullPath = path.join(dir, entry);
            const stat = fs.statSync(fullPath);

            if (stat.isDirectory()) {
                collectNodes(fullPath, root, nodes, extensions, depth + 1);
            } else if (stat.isFile() && extensions.some(ext => entry.endsWith(ext)) && !entry.includes('.d.ts')) {
                const relative = path.relative(root, fullPath).replace(/\\/g, '/');
                const content = fs.readFileSync(fullPath, 'utf-8');
                const imports = extractLocalImports(content, relative);

                nodes.set(relative, {
                    file: relative,
                    directory: path.dirname(relative),
                    imports,
                    importedBy: [],
                    isEntryPoint: false,
                    isLeaf: false,
                });
            }
        }
    } catch { }
}

function extractLocalImports(content: string, currentFile: string): string[] {
    const imports: string[] = [];
    const patterns = [
        /from\s+['"](\.[^'"]+)['"]/g,         // import X from './foo'
        /require\(['"](\.[^'"]+)['"]\)/g,      // require('./foo')
    ];

    const currentDir = path.dirname(currentFile);

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(content)) !== null) {
            let importPath = match[1];
            // Resolve relative path
            let resolved = path.posix.join(currentDir, importPath);
            // Normalize extensions
            if (!resolved.match(/\.(ts|tsx|js|jsx|mjs)$/)) {
                resolved += '.ts'; // default assumption
            }
            imports.push(resolved);
        }
    }

    return imports;
}

function detectLayers(nodes: Map<string, ArchNode>): ArchLayer[] {
    const layerPatterns: Array<{ name: string; dirs: RegExp }> = [
        { name: 'UI', dirs: /^(components|pages|views|screens|ui)\// },
        { name: 'Hooks', dirs: /^(hooks|composables)\// },
        { name: 'API/Routes', dirs: /^(api|routes|controllers|pages\/api)\// },
        { name: 'Services', dirs: /^(services|server|handlers|resolvers)\// },
        { name: 'Data/Models', dirs: /^(models|db|database|prisma|entities)\// },
        { name: 'Utils', dirs: /^(utils|lib|helpers|shared|common)\// },
        { name: 'Config', dirs: /^(config|settings|constants)\// },
        { name: 'Types', dirs: /^(types|interfaces|typings)\// },
    ];

    const layers: ArchLayer[] = [];
    const dirCounts = new Map<string, number>();

    for (const [, node] of nodes) {
        dirCounts.set(node.directory, (dirCounts.get(node.directory) || 0) + 1);
    }

    for (const { name, dirs } of layerPatterns) {
        const matchingDirs: string[] = [];
        let fileCount = 0;

        for (const [dir, count] of dirCounts) {
            if (dirs.test(dir + '/')) {
                matchingDirs.push(dir);
                fileCount += count;
            }
        }

        if (matchingDirs.length > 0) {
            layers.push({ name, directories: matchingDirs, fileCount });
        }
    }

    return layers;
}

function detectEndpoints(workspaceRoot: string, nodes: Map<string, ArchNode>): string[] {
    const endpoints: string[] = [];

    for (const [file] of nodes) {
        if (!file.match(/(route|controller|api|endpoint|handler)/i)) continue;

        try {
            const content = fs.readFileSync(path.join(workspaceRoot, file), 'utf-8');

            // Express-style: app.get('/path', ...) or router.post('/path', ...)
            const expressPattern = /\.(get|post|put|delete|patch)\s*\(\s*['"](\/[^'"]*)['"]/g;
            let match;
            while ((match = expressPattern.exec(content)) !== null) {
                endpoints.push(`${match[1].toUpperCase()} ${match[2]}`);
            }

            // Next.js API route: export default/export async function
            if (file.includes('pages/api') || file.includes('app/api')) {
                const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
                for (const method of methods) {
                    if (content.includes(`export async function ${method}`) || content.includes(`export function ${method}`)) {
                        const routePath = '/' + file.replace(/\.(ts|js|tsx|jsx)$/, '').replace(/^(pages|app)\/api/, '/api').replace(/\/route$/, '');
                        endpoints.push(`${method} ${routePath}`);
                    }
                }
            }
        } catch { }
    }

    return [...new Set(endpoints)];
}
