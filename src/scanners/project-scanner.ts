/**
 * Project Scanner — Scans project on first activation.
 * Solves the "Day 1 Empty Brain" problem.
 *
 * Pure Node.js — no VS Code dependency.
 * Captures: package.json, README, directory structure, git log, config files.
 */
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { MemoryStore } from '../db/memory-store';
import { MemoryType } from '../types';

export class ProjectScanner {
    private memoryStore: MemoryStore;
    private workspaceRoot: string;

    constructor(memoryStore: MemoryStore, workspaceRoot: string) {
        this.memoryStore = memoryStore;
        this.workspaceRoot = workspaceRoot;
    }

    /** Check if project was already scanned */
    isAlreadyScanned(): boolean {
        const existing = this.memoryStore.getByType(MemoryType.INSIGHT, 10);
        return existing.some(m => m.intent.startsWith('Project structure'));
    }

    /** Full project scan — returns number of memories created */
    async scan(): Promise<number> {
        if (this.isAlreadyScanned()) {
            return 0;
        }

        let count = 0;
        count += this.scanPackageJson();
        count += this.scanReadme();
        count += this.scanDirectoryStructure();
        count += this.scanConfigFiles();
        count += this.scanArchitecture();
        count += this.scanEnvironment();
        count += await this.scanGitLog();
        return count;
    }

    /** Scan package.json for stack info */
    private scanPackageJson(): number {
        const pkgPath = path.join(this.workspaceRoot, 'package.json');
        if (!fs.existsSync(pkgPath)) return 0;

        try {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const deps = Object.keys(pkg.dependencies || {}).slice(0, 15).join(', ');
            const devDeps = Object.keys(pkg.devDependencies || {}).slice(0, 10).join(', ');

            const intent = `Project dependencies: ${deps}`;
            this.memoryStore.add({
                type: MemoryType.DEPENDENCY,
                intent: intent.slice(0, 300),
                action: `Scanned package.json: ${pkg.name || 'unknown'}`,
                reason: devDeps ? `Dev deps: ${devDeps}` : undefined,
                tags: ['project-scan', 'dependencies'],
                confidence: 0.9,
                importance: 0.7,
                timestamp: Date.now(),
                isActive: true,
                accessCount: 0,
                createdAt: Date.now(),
                id: '',
            });
            return 1;
        } catch { return 0; }
    }

    /** Scan README for project purpose */
    private scanReadme(): number {
        const readmePaths = ['README.md', 'readme.md', 'README.txt'];
        for (const name of readmePaths) {
            const readmePath = path.join(this.workspaceRoot, name);
            if (!fs.existsSync(readmePath)) continue;

            try {
                const content = fs.readFileSync(readmePath, 'utf-8');
                // Get first 3 non-empty lines as summary
                const summary = content.split('\n')
                    .filter(l => l.trim().length > 0)
                    .slice(0, 3)
                    .join(' ')
                    .slice(0, 300);

                this.memoryStore.add({
                    type: MemoryType.INSIGHT,
                    intent: `Project README: ${summary}`,
                    action: `Scanned ${name}`,
                    tags: ['project-scan', 'readme'],
                    confidence: 0.8,
                    importance: 0.6,
                    timestamp: Date.now(),
                    isActive: true,
                    accessCount: 0,
                    createdAt: Date.now(),
                    id: '',
                });
                return 1;
            } catch { return 0; }
        }
        return 0;
    }

    /** Scan directory structure (top 3 levels) */
    private scanDirectoryStructure(): number {
        const tree = this.getDirectoryTree(this.workspaceRoot, 3);
        if (!tree) return 0;

        this.memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: `Project structure (top 3 levels)`,
            action: tree.slice(0, 300),
            tags: ['project-scan', 'structure'],
            confidence: 0.9,
            importance: 0.5,
            timestamp: Date.now(),
            isActive: true,
            accessCount: 0,
            createdAt: Date.now(),
            id: '',
        });
        return 1;
    }

    /** Build directory tree string */
    private getDirectoryTree(dir: string, maxDepth: number, depth: number = 0, prefix: string = ''): string {
        if (depth >= maxDepth) return '';
        const ignore = new Set(['node_modules', '.git', 'dist', '.ai', '.gemini', 'coverage', '.next']);

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true })
                .filter(e => !ignore.has(e.name) && !e.name.startsWith('.'))
                .sort((a, b) => {
                    if (a.isDirectory() && !b.isDirectory()) return -1;
                    if (!a.isDirectory() && b.isDirectory()) return 1;
                    return a.name.localeCompare(b.name);
                })
                .slice(0, 20);

            let result = '';
            for (const entry of entries) {
                result += `${prefix}${entry.isDirectory() ? '[DIR]' : '[FILE]'} ${entry.name}\n`;
                if (entry.isDirectory()) {
                    result += this.getDirectoryTree(
                        path.join(dir, entry.name), maxDepth, depth + 1, prefix + '  '
                    );
                }
            }
            return result;
        } catch { return ''; }
    }

    /** Scan config files for conventions */
    private scanConfigFiles(): number {
        const configs = ['tsconfig.json', '.eslintrc.json', '.prettierrc', 'next.config.js', 'vite.config.ts'];
        let count = 0;

        for (const name of configs) {
            const configPath = path.join(this.workspaceRoot, name);
            if (!fs.existsSync(configPath)) continue;

            this.memoryStore.add({
                type: MemoryType.CONVENTION,
                intent: `Project uses ${name}`,
                action: `Config file found: ${name}`,
                tags: ['project-scan', 'config'],
                confidence: 0.9,
                importance: 0.4,
                timestamp: Date.now(),
                isActive: true,
                accessCount: 0,
                createdAt: Date.now(),
                id: '',
            });
            count++;
        }
        return count;
    }

    /** Scan git log for recent history */
    private async scanGitLog(): Promise<number> {
        try {
            const log = execSync('git log --oneline -10', {
                cwd: this.workspaceRoot,
                encoding: 'utf-8',
                timeout: 5000,
            }).trim();

            if (!log) return 0;

            this.memoryStore.add({
                type: MemoryType.INSIGHT,
                intent: `Recent git history (last 10 commits)`,
                action: log.slice(0, 300),
                tags: ['project-scan', 'git'],
                confidence: 0.9,
                importance: 0.5,
                timestamp: Date.now(),
                isActive: true,
                accessCount: 0,
                createdAt: Date.now(),
                id: '',
            });
            return 1;
        } catch { return 0; }
    }

    /** Scan import chains to build architecture flow */
    private scanArchitecture(): number {
        const srcDirs = ['src', 'lib', 'app', 'pages', 'components'];
        const sourceFiles: Array<{ file: string; imports: string[] }> = [];

        for (const dir of srcDirs) {
            const dirPath = path.join(this.workspaceRoot, dir);
            if (!fs.existsSync(dirPath)) continue;
            this.collectImports(dirPath, sourceFiles, 0);
        }

        if (sourceFiles.length === 0) return 0;

        // Build architecture map: which files import which
        const flowLines: string[] = [];
        const entryPoints: string[] = [];
        const mostImported = new Map<string, number>();

        for (const { file, imports } of sourceFiles) {
            for (const imp of imports) {
                mostImported.set(imp, (mostImported.get(imp) || 0) + 1);
            }
            if (file.includes('index') || file.includes('main') || file.includes('app') || file.includes('server')) {
                entryPoints.push(file);
            }
        }

        // Top 10 most-imported files = core components
        const sorted = [...mostImported.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (sorted.length > 0) {
            flowLines.push('Core components (most imported):');
            for (const [file, count] of sorted) {
                flowLines.push(`  ${file} (imported by ${count} files)`);
            }
        }

        if (entryPoints.length > 0) {
            flowLines.push(`Entry points: ${entryPoints.join(', ')}`);
        }

        flowLines.push(`Total source files: ${sourceFiles.length}`);

        const flowText = flowLines.join('\n').slice(0, 500);

        this.memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: 'Architecture flow — component relationships',
            action: flowText,
            tags: ['project-scan', 'architecture'],
            confidence: 0.85,
            importance: 0.7,
            timestamp: Date.now(),
            isActive: true,
            accessCount: 0,
            createdAt: Date.now(),
            id: '',
        });
        return 1;
    }

    /** Collect imports from source files */
    private collectImports(dir: string, results: Array<{ file: string; imports: string[] }>, depth: number): void {
        if (depth > 4) return;
        const ignore = new Set(['node_modules', '.git', 'dist', 'coverage', '__tests__', '__mocks__']);

        try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (ignore.has(entry.name)) continue;
                const fullPath = path.join(dir, entry.name);

                if (entry.isDirectory()) {
                    this.collectImports(fullPath, results, depth + 1);
                } else if (/\.(ts|js|tsx|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                    try {
                        const content = fs.readFileSync(fullPath, 'utf-8').slice(0, 3000); // Only first 3KB
                        const imports: string[] = [];
                        const importRegex = /(?:import|require)\s*\(?['"]([^'"]+)['"]\)?/g;
                        let match;
                        while ((match = importRegex.exec(content)) !== null) {
                            const imp = match[1];
                            if (imp.startsWith('.') || imp.startsWith('/')) {
                                imports.push(imp);
                            }
                        }
                        const relPath = path.relative(this.workspaceRoot, fullPath).replace(/\\/g, '/');
                        if (imports.length > 0) {
                            results.push({ file: relPath, imports });
                        }
                    } catch { }
                }
            }
        } catch { }
    }

    /** Scan .env files for environment context */
    private scanEnvironment(): number {
        const envFiles = ['.env', '.env.local', '.env.development', '.env.production', '.env.staging', '.env.example'];
        const envVars: string[] = [];

        for (const name of envFiles) {
            const envPath = path.join(this.workspaceRoot, name);
            if (!fs.existsSync(envPath)) continue;

            try {
                const content = fs.readFileSync(envPath, 'utf-8');
                const keys = content.split('\n')
                    .filter(l => l.trim() && !l.startsWith('#'))
                    .map(l => l.split('=')[0].trim())
                    .filter(k => k.length > 0);

                if (keys.length > 0) {
                    envVars.push(`${name}: ${keys.slice(0, 10).join(', ')}`);
                }
            } catch { }
        }

        if (envVars.length === 0) return 0;

        this.memoryStore.add({
            type: MemoryType.INSIGHT,
            intent: `Environment config — ${envVars.length} env files found`,
            action: envVars.join('\n').slice(0, 400),
            tags: ['project-scan', 'environment'],
            confidence: 0.9,
            importance: 0.6,
            timestamp: Date.now(),
            isActive: true,
            accessCount: 0,
            createdAt: Date.now(),
            id: '',
        });
        return 1;
    }

    /** Get list of all source files (for file verification) */
    getSourceFiles(): string[] {
        const files: string[] = [];
        const ignore = new Set(['node_modules', '.git', 'dist', '.ai', '.gemini', 'coverage']);

        const walk = (dir: string, depth: number = 0): void => {
            if (depth > 5) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (ignore.has(entry.name)) continue;
                    const full = path.join(dir, entry.name);
                    if (entry.isDirectory()) {
                        walk(full, depth + 1);
                    } else {
                        files.push(path.relative(this.workspaceRoot, full));
                    }
                }
            } catch { }
        };

        walk(this.workspaceRoot);
        return files;
    }
}
