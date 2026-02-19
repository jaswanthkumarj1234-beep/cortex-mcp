#!/usr/bin/env node
/**
 * Embedding Worker Thread — Runs MiniLM in a separate thread.
 * 
 * Never blocks the main event loop. Main thread sends text,
 * worker returns Float32Array embeddings asynchronously.
 */
// SILENCE WORKER THREAD (prevent protocol corruption)
console.log = () => { };
console.warn = () => { };
console.error = () => { };

import { parentPort } from 'worker_threads';

let pipeline: any = null;
let modelReady = false;

interface EmbedRequest {
    type: 'embed';
    id: string;
    text: string;
}

interface EmbedResponse {
    type: 'result';
    id: string;
    vector: number[];
}

interface ErrorResponse {
    type: 'error';
    id: string;
    message: string;
}

interface ReadyResponse {
    type: 'ready';
}

async function loadModel(): Promise<void> {
    try {
        const { pipeline: createPipeline } = await import('@xenova/transformers');

        pipeline = await createPipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
            quantized: true,
            progress_callback: (x: any) => { }, // SILENCE PROGRESS BARS
        });
        modelReady = true;
        parentPort?.postMessage({ type: 'ready' } as ReadyResponse);
    } catch (err: any) {
        parentPort?.postMessage({ type: 'error', id: '__init__', message: err.message } as ErrorResponse);
    }
}

parentPort?.on('message', async (msg: EmbedRequest) => {
    if (msg.type !== 'embed') return;

    if (!modelReady) {
        parentPort?.postMessage({
            type: 'error',
            id: msg.id,
            message: 'Model not ready yet',
        } as ErrorResponse);
        return;
    }

    try {
        const output = await pipeline(msg.text, { pooling: 'mean', normalize: true });
        const vector = Array.from(output.data as Float32Array);
        parentPort?.postMessage({
            type: 'result',
            id: msg.id,
            vector,
        } as EmbedResponse);
    } catch (err: any) {
        parentPort?.postMessage({
            type: 'error',
            id: msg.id,
            message: err.message,
        } as ErrorResponse);
    }
});

// Start loading immediately
loadModel();
