/**
 * Code Verifier — Catches hallucinated imports, exports, and config keys.
 *
 * Three verification modes:
 * 1. Import Verifier — checks if npm packages exist in package.json / node_modules
 * 2. Export Verifier — checks if imported functions actually exist in source files
 * 3. Config Verifier — checks if env variables exist in .env / .env.example
 */
import * as fs from 'fs';
import * as path from 'path';

// ─── Types ───

export interface CodeVerificationResult {
    imports: {
        valid: string[];
        invalid: string[];
        suggestions: Record<string, string[]>;
    };
    exports: {
        valid: string[];
        invalid: string[];
        available: Record<string, string[]>; // file → actual exports
    };
    envVars: {
        valid: string[];
        invalid: string[];
        available: string[];
    };
}

// ─── Import Verifier ───

export class ImportVerifier {
    private installedPackages: Set<string> = new Set();
    private declaredDeps: Set<string> = new Set();

    constructor(private workspaceRoot: string) {
        this.loadPackageJson();
        this.scanNodeModules();
    }

    private loadPackageJson(): void {
        try {
            const pkgPath = path.join(this.workspaceRoot, 'package.json');
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
            const allDeps = {
                ...pkg.dependencies,
                ...pkg.devDependencies,
                ...pkg.peerDependencies,
            };
            for (const name of Object.keys(allDeps || {})) {
                this.declaredDeps.add(name);
            }
        } catch { }
    }

    private scanNodeModules(): void {
        try {
            const nmPath = path.join(this.workspaceRoot, 'node_modules');
            const entries = fs.readdirSync(nmPath, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isDirectory() && !entry.name.startsWith('.')) {
                    if (entry.name.startsWith('@')) {
                        // Scoped packages like @types/node
                        try {
                            const scoped = fs.readdirSync(path.join(nmPath, entry.name));
                            for (const sub of scoped) {
                                this.installedPackages.add(`${entry.name}/${sub}`);
                            }
                        } catch { }
                    } else {
                        this.installedPackages.add(entry.name);
                    }
                }
            }
        } catch { }
    }

    /** Verify a list of package names */
    verify(packages: string[]): { valid: string[]; invalid: string[]; suggestions: Record<string, string[]> } {
        const result = { valid: [] as string[], invalid: [] as string[], suggestions: {} as Record<string, string[]> };

        for (const pkg of packages) {
            // Skip relative imports and node builtins
            if (pkg.startsWith('.') || pkg.startsWith('/')) continue;
            if (this.isNodeBuiltin(pkg)) continue;

            // Get the package name (handle subpath like 'lodash/merge')
            const pkgName = pkg.startsWith('@')
                ? pkg.split('/').slice(0, 2).join('/')
                : pkg.split('/')[0];

            if (this.declaredDeps.has(pkgName) || this.installedPackages.has(pkgName)) {
                result.valid.push(pkgName);
            } else {
                result.invalid.push(pkgName);
                // Find similar packages
                const suggestions = this.findSimilar(pkgName);
                if (suggestions.length > 0) {
                    result.suggestions[pkgName] = suggestions;
                }
            }
        }

        return result;
    }

    /** Extract import package names from code text */
    extractImports(text: string): string[] {
        const packages = new Set<string>();
        const patterns = [
            /(?:from\s+['"])([^'"]+)(?:['"])/g,          // import ... from 'pkg'
            /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,      // require('pkg')
            /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g,       // dynamic import('pkg')
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const pkg = match[1];
                if (!pkg.startsWith('.') && !pkg.startsWith('/')) {
                    packages.add(pkg);
                }
            }
        }

        return Array.from(packages);
    }

    private isNodeBuiltin(name: string): boolean {
        const builtins = new Set([
            'assert', 'buffer', 'child_process', 'cluster', 'console', 'constants',
            'crypto', 'dgram', 'dns', 'domain', 'events', 'fs', 'http', 'http2',
            'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
            'querystring', 'readline', 'repl', 'stream', 'string_decoder', 'sys',
            'timers', 'tls', 'tty', 'url', 'util', 'v8', 'vm', 'worker_threads',
            'zlib', 'diagnostics_channel', 'inspector', 'trace_events',
            'node:assert', 'node:buffer', 'node:child_process', 'node:crypto',
            'node:events', 'node:fs', 'node:http', 'node:https', 'node:net',
            'node:os', 'node:path', 'node:process', 'node:readline', 'node:stream',
            'node:url', 'node:util', 'node:worker_threads', 'node:zlib',
            'node:diagnostics_channel', 'node:test',
        ]);
        return builtins.has(name);
    }

    private findSimilar(name: string): string[] {
        const allPkgs = Array.from(this.declaredDeps);
        return allPkgs
            .filter(p => {
                // Simple similarity: shared prefix or contains
                return p.includes(name) || name.includes(p) ||
                    this.levenshteinClose(p, name);
            })
            .slice(0, 3);
    }

    private levenshteinClose(a: string, b: string): boolean {
        if (Math.abs(a.length - b.length) > 3) return false;
        let diff = 0;
        const minLen = Math.min(a.length, b.length);
        for (let i = 0; i < minLen; i++) {
            if (a[i] !== b[i]) diff++;
        }
        return diff + Math.abs(a.length - b.length) <= 2;
    }
}

// ─── Export Verifier ───

export class ExportVerifier {
    constructor(private workspaceRoot: string) { }

    /** Check if specific named exports exist in a source file */
    verifyExports(filePath: string, names: string[]): { valid: string[]; invalid: string[]; available: string[] } {
        const result = { valid: [] as string[], invalid: [] as string[], available: [] as string[] };

        // Resolve the file path
        const resolved = this.resolveFile(filePath);
        if (!resolved) {
            return { valid: [], invalid: names, available: [] };
        }

        // Extract actual exports from the file
        try {
            const content = fs.readFileSync(resolved, 'utf-8');
            const actualExports = this.extractExports(content);
            result.available = actualExports;

            for (const name of names) {
                if (actualExports.includes(name)) {
                    result.valid.push(name);
                } else {
                    result.invalid.push(name);
                }
            }
        } catch {
            result.invalid = names;
        }

        return result;
    }

    /** Extract all exported names from a TypeScript/JavaScript file */
    extractExports(content: string): string[] {
        const exports = new Set<string>();
        const patterns = [
            /export\s+(?:async\s+)?function\s+(\w+)/g,       // export function foo
            /export\s+(?:abstract\s+)?class\s+(\w+)/g,       // export class Foo
            /export\s+const\s+(\w+)/g,                        // export const foo
            /export\s+let\s+(\w+)/g,                           // export let foo
            /export\s+var\s+(\w+)/g,                           // export var foo
            /export\s+enum\s+(\w+)/g,                          // export enum Foo
            /export\s+interface\s+(\w+)/g,                     // export interface Foo
            /export\s+type\s+(\w+)/g,                          // export type Foo
            /export\s+default\s+(?:class|function)\s+(\w+)/g, // export default class Foo
            /export\s*\{\s*([^}]+)\s*\}/g,                     // export { foo, bar }
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(content)) !== null) {
                const capture = match[1];
                // Handle export { foo, bar, baz as qux }
                if (pattern.source.includes('\\{')) {
                    const names = capture.split(',').map(n => {
                        const parts = n.trim().split(/\s+as\s+/);
                        return parts[parts.length - 1].trim();
                    });
                    names.forEach(n => { if (n && /^\w+$/.test(n)) exports.add(n); });
                } else {
                    exports.add(capture);
                }
            }
        }

        return Array.from(exports);
    }

    /** Extract import-from-file statements from text */
    extractLocalImports(text: string): Array<{ names: string[]; file: string }> {
        const results: Array<{ names: string[]; file: string }> = [];
        // import { foo, bar } from './services/auth'
        const pattern = /import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const names = match[1].split(',').map(n => {
                const parts = n.trim().split(/\s+as\s+/);
                return parts[0].trim(); // use the original name, not alias
            }).filter(n => n.length > 0);
            results.push({ names, file: match[2] });
        }
        return results;
    }

    private resolveFile(filePath: string): string | null {
        const abs = path.isAbsolute(filePath)
            ? filePath
            : path.join(this.workspaceRoot, filePath);

        // Try exact, then with extensions
        const tries = [abs, abs + '.ts', abs + '.tsx', abs + '.js', abs + '.jsx'];
        // Also try /index variants
        tries.push(
            path.join(abs, 'index.ts'),
            path.join(abs, 'index.tsx'),
            path.join(abs, 'index.js'),
        );

        for (const p of tries) {
            if (fs.existsSync(p) && fs.statSync(p).isFile()) {
                return p;
            }
        }
        return null;
    }
}

// ─── Config Verifier ───

export class ConfigVerifier {
    private envVars: Set<string> = new Set();

    constructor(private workspaceRoot: string) {
        this.loadEnvFiles();
    }

    private loadEnvFiles(): void {
        const envFiles = ['.env', '.env.example', '.env.local', '.env.development', '.env.template'];
        for (const file of envFiles) {
            try {
                const content = fs.readFileSync(path.join(this.workspaceRoot, file), 'utf-8');
                const lines = content.split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (trimmed && !trimmed.startsWith('#')) {
                        const eqIndex = trimmed.indexOf('=');
                        if (eqIndex > 0) {
                            this.envVars.add(trimmed.substring(0, eqIndex).trim());
                        }
                    }
                }
            } catch { }
        }
    }

    /** Extract env variable references from code */
    extractEnvRefs(text: string): string[] {
        const vars = new Set<string>();
        const patterns = [
            /process\.env\.(\w+)/g,              // process.env.FOO
            /process\.env\[['"](\w+)['"]\]/g,    // process.env['FOO']
            /import\.meta\.env\.(\w+)/g,          // Vite: import.meta.env.FOO
            /env\(['"](\w+)['"]\)/g,              // Laravel-style env('FOO')
            /getenv\(['"](\w+)['"]\)/g,           // getenv('FOO')
        ];

        for (const pattern of patterns) {
            let match;
            while ((match = pattern.exec(text)) !== null) {
                const varName = match[1];
                // Skip common well-known ones
                if (!['NODE_ENV', 'HOME', 'PATH', 'USER', 'SHELL', 'TERM', 'PWD'].includes(varName)) {
                    vars.add(varName);
                }
            }
        }

        return Array.from(vars);
    }

    /** Verify env variable references */
    verify(varNames: string[]): { valid: string[]; invalid: string[]; available: string[] } {
        const result = {
            valid: [] as string[],
            invalid: [] as string[],
            available: Array.from(this.envVars),
        };

        for (const name of varNames) {
            if (this.envVars.has(name)) {
                result.valid.push(name);
            } else {
                result.invalid.push(name);
            }
        }

        return result;
    }
}

// ─── Combined Verifier ───

export function verifyCode(text: string, workspaceRoot: string): CodeVerificationResult {
    const importVerifier = new ImportVerifier(workspaceRoot);
    const exportVerifier = new ExportVerifier(workspaceRoot);
    const configVerifier = new ConfigVerifier(workspaceRoot);

    // 1. Verify imports
    const importNames = importVerifier.extractImports(text);
    const imports = importVerifier.verify(importNames);

    // 2. Verify exports (local imports only)
    const localImports = exportVerifier.extractLocalImports(text);
    const exportResult = { valid: [] as string[], invalid: [] as string[], available: {} as Record<string, string[]> };
    for (const li of localImports) {
        const result = exportVerifier.verifyExports(li.file, li.names);
        exportResult.valid.push(...result.valid);
        exportResult.invalid.push(...result.invalid);
        if (result.available.length > 0) {
            exportResult.available[li.file] = result.available;
        }
    }

    // 3. Verify env vars
    const envRefs = configVerifier.extractEnvRefs(text);
    const envVars = configVerifier.verify(envRefs);

    return { imports, exports: exportResult, envVars };
}
