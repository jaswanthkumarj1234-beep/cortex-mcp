/**
 * File Verifier — Catches hallucinated file paths.
 *
 * Pure Node.js — no VS Code dependency.
 * Verifies file paths mentioned in AI responses against the real file system.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface VerificationResult {
    valid: string[];
    invalid: string[];
    suggestions: Record<string, string[]>; // invalid path → possible correct paths
}

export class FileVerifier {
    private workspaceRoot: string;
    private fileIndex: Set<string> = new Set();
    private lastIndexTime: number = 0;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.buildIndex();
    }

    /** Build file index (cached, rebuilt every 60s) */
    private buildIndex(): void {
        if (Date.now() - this.lastIndexTime < 60_000 && this.fileIndex.size > 0) return;

        this.fileIndex.clear();
        const ignore = new Set(['node_modules', '.git', 'dist', '.ai', '.gemini', 'coverage']);

        const walk = (dir: string, depth: number = 0): void => {
            if (depth > 6) return;
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });
                for (const entry of entries) {
                    if (ignore.has(entry.name)) continue;
                    const rel = path.relative(this.workspaceRoot, path.join(dir, entry.name));
                    if (entry.isDirectory()) {
                        this.fileIndex.add(rel.replace(/\\/g, '/') + '/');
                        walk(path.join(dir, entry.name), depth + 1);
                    } else {
                        this.fileIndex.add(rel.replace(/\\/g, '/'));
                    }
                }
            } catch { }
        };

        walk(this.workspaceRoot);
        this.lastIndexTime = Date.now();
    }

    /** Verify a list of file paths */
    verify(filePaths: string[]): VerificationResult {
        this.buildIndex(); // refresh if stale

        const result: VerificationResult = { valid: [], invalid: [], suggestions: {} };

        for (const filePath of filePaths) {
            const normalized = filePath.replace(/\\/g, '/');

            // Check exact match
            if (this.fileIndex.has(normalized)) {
                result.valid.push(filePath);
                continue;
            }

            // Check absolute path
            const abs = path.resolve(this.workspaceRoot, filePath);
            if (fs.existsSync(abs)) {
                result.valid.push(filePath);
                continue;
            }

            // Invalid — find suggestions
            result.invalid.push(filePath);
            const basename = path.basename(filePath);
            const suggestions = Array.from(this.fileIndex)
                .filter(f => f.endsWith(basename))
                .slice(0, 3);
            if (suggestions.length > 0) {
                result.suggestions[filePath] = suggestions;
            }
        }

        return result;
    }

    /** Extract file paths from text (AI response) */
    extractPaths(text: string): string[] {
        const patterns = [
            /(?:src|lib|app|pages|components|utils|hooks|services|server|api)\/[\w/.-]+\.\w+/g,
            /[\w-]+\.(?:ts|tsx|js|jsx|py|rs|go|java|css|html|json|md|yaml|yml|toml)/g,
        ];

        const paths = new Set<string>();
        for (const pattern of patterns) {
            const matches = text.match(pattern) || [];
            for (const m of matches) {
                if (m.length > 3 && m.length < 200) {
                    paths.add(m);
                }
            }
        }

        return Array.from(paths);
    }

    /** Full verification: extract paths from text and verify all */
    verifyText(text: string): VerificationResult {
        const paths = this.extractPaths(text);
        return this.verify(paths);
    }

    /** Get all indexed files (for context injection) */
    getAllFiles(): string[] {
        this.buildIndex();
        return Array.from(this.fileIndex).filter(f => !f.endsWith('/'));
    }
}
