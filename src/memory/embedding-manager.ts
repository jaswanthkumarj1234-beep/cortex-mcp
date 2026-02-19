/**
 * Embedding Manager — Worker thread lifecycle for MiniLM embeddings.
 * Extracted from standalone.ts L591-643.
 */
import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';
import { CONFIG } from '../config/config';

let embeddingWorker: Worker | null = null;
let workerReady = false;
const pendingEmbeddings = new Map<string, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

export function startEmbeddingWorker(): void {
    try {
        // Worker compiles to dist/embedding-worker.js, manager is in dist/memory/
        const workerPath = path.join(__dirname, '..', 'embedding-worker.js');
        if (!fs.existsSync(workerPath)) {
            console.log('  [cortex-mcp] Embedding worker not found, running FTS-only mode');
            return;
        }
        embeddingWorker = new Worker(workerPath);
        embeddingWorker.on('message', (msg: any) => {
            if (msg.type === 'ready') {
                workerReady = true;
                console.log('  [cortex-mcp] Embedding model loaded (worker thread)');
            } else if (msg.type === 'result') {
                const pending = pendingEmbeddings.get(msg.id);
                if (pending) { pending.resolve(msg.vector); pendingEmbeddings.delete(msg.id); }
            } else if (msg.type === 'error') {
                const pending = pendingEmbeddings.get(msg.id);
                if (pending) { pending.reject(new Error(msg.message)); pendingEmbeddings.delete(msg.id); }
            }
        });
        embeddingWorker.on('error', (err) => {
            console.error('  [cortex-mcp] Embedding worker error:', err.message);
            workerReady = false;
        });
        console.log('  [cortex-mcp] Loading embedding model in background...');
    } catch (err: any) {
        console.log('  [cortex-mcp] Could not start embedding worker:', err.message);
    }
}

export function embedText(text: string): Promise<number[]> {
    return new Promise((resolve, reject) => {
        if (!embeddingWorker || !workerReady) {
            reject(new Error('Worker not ready'));
            return;
        }
        const id = `embed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const timeout = setTimeout(() => {
            pendingEmbeddings.delete(id);
            reject(new Error('Embedding timeout'));
        }, CONFIG.EMBEDDING_TIMEOUT);
        pendingEmbeddings.set(id, {
            resolve: (v) => { clearTimeout(timeout); resolve(v); },
            reject: (e) => { clearTimeout(timeout); reject(e); },
        });
        embeddingWorker.postMessage({ type: 'embed', id, text });
    });
}

export function isWorkerReady(): boolean {
    return workerReady;
}

export function terminateWorker(): void {
    if (embeddingWorker) {
        embeddingWorker.terminate();
        embeddingWorker = null;
        workerReady = false;
    }
}
