/**
 * Local MiniLM Embedder — Uses transformers.js for local embeddings.
 * Falls back to a TF-IDF inspired n-gram hasher if model fails to load.
 *
 * The fallback is significantly improved over simple word hashing:
 * - Uses bigrams and trigrams (not just unigrams)
 * - Applies IDF-like weighting (rare words matter more)
 * - Handles code-specific tokens (camelCase splitting, snake_case)
 */
import type { EmbedderStrategy } from '../../types';

let pipeline: any = null;
let extractor: any = null;

export class LocalMiniLMEmbedder implements EmbedderStrategy {
    readonly name = 'local-minilm';
    private initialized = false;
    private initPromise: Promise<void> | null = null;
    private useFallback = false;
    private readonly DIMS = 384;

    // IDF-like frequency tracking for fallback
    private wordFrequency: Map<string, number> = new Map();
    private totalDocuments = 0;

    async embed(text: string): Promise<Float32Array> {
        if (this.useFallback) return this.fallbackEmbed(text);

        await this.ensureInitialized();

        if (this.useFallback) return this.fallbackEmbed(text);

        try {
            const output = await extractor(text, { pooling: 'mean', normalize: true });
            return new Float32Array(output.data);
        } catch (err) {
            console.error('[CognitiveMemory] Embedding error, using fallback:', err);
            this.useFallback = true;
            return this.fallbackEmbed(text);
        }
    }

    async embedBatch(texts: string[]): Promise<Float32Array[]> {
        return Promise.all(texts.map((t) => this.embed(t)));
    }

    private async ensureInitialized(): Promise<void> {
        if (this.initialized) return;
        if (this.initPromise) {
            await this.initPromise;
            return;
        }

        this.initPromise = (async () => {
            try {
                const { pipeline: createPipeline } = await import('@xenova/transformers');
                pipeline = createPipeline;
                extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
                    quantized: true,
                });
                this.initialized = true;
                console.log('[CognitiveMemory] MiniLM model loaded successfully');
            } catch (err) {
                console.warn('[CognitiveMemory] MiniLM model unavailable, using TF-IDF fallback:', err);
                this.useFallback = true;
                this.initialized = true;
            }
        })();

        await this.initPromise;
    }

    /**
     * Improved fallback: TF-IDF inspired n-gram hasher.
     * Produces embeddings that capture word meaning through:
     * 1. Unigrams, bigrams, and trigrams
     * 2. camelCase and snake_case token splitting
     * 3. IDF-like weighting (rare terms get higher weight)
     */
    private fallbackEmbed(text: string): Float32Array {
        const embedding = new Float32Array(this.DIMS).fill(0);
        const tokens = this.tokenize(text);

        if (tokens.length === 0) return embedding;

        this.totalDocuments++;

        // Generate n-grams
        const features: string[] = [];

        // Unigrams
        for (const token of tokens) {
            features.push(token);
            // Track frequency for IDF
            this.wordFrequency.set(token, (this.wordFrequency.get(token) || 0) + 1);
        }

        // Bigrams
        for (let i = 0; i < tokens.length - 1; i++) {
            features.push(`${tokens[i]}_${tokens[i + 1]}`);
        }

        // Trigrams (for longer texts)
        if (tokens.length > 5) {
            for (let i = 0; i < tokens.length - 2; i++) {
                features.push(`${tokens[i]}_${tokens[i + 1]}_${tokens[i + 2]}`);
            }
        }

        // Hash features into embedding dimensions with IDF weighting
        for (const feature of features) {
            const freq = this.wordFrequency.get(feature) || 1;
            const idf = Math.log(1 + this.totalDocuments / freq);
            const tf = 1.0 / features.length;
            const weight = tf * idf;

            // Multi-hash for better distribution
            const h1 = this.djb2Hash(feature) % this.DIMS;
            const h2 = this.fnv1aHash(feature) % this.DIMS;
            const sign = (this.djb2Hash(feature + '_sign') % 2 === 0) ? 1 : -1;

            embedding[h1] += weight * sign;
            embedding[h2] += weight * 0.5 * sign;
        }

        // L2 normalize
        let mag = 0;
        for (let i = 0; i < this.DIMS; i++) mag += embedding[i] * embedding[i];
        mag = Math.sqrt(mag);
        if (mag > 0) {
            for (let i = 0; i < this.DIMS; i++) embedding[i] /= mag;
        }

        return embedding;
    }

    /** Split text into tokens, handling code-specific patterns */
    private tokenize(text: string): string[] {
        // Convert camelCase and PascalCase to separate tokens
        const expanded = text
            .replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase → camel Case
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');  // XMLParser → XML Parser

        // Split on non-alphanumeric, underscores, etc.
        const raw = expanded.toLowerCase().split(/[\s_\-./\\:;,!?()[\]{}'"<>@#$%^&*+=|~`]+/);

        // Filter out noise
        return raw.filter((w) => w.length >= 2 && w.length <= 30 && !/^\d+$/.test(w));
    }

    private djb2Hash(str: string): number {
        let hash = 5381;
        for (let i = 0; i < str.length; i++) {
            hash = ((hash << 5) + hash) + str.charCodeAt(i);
            hash = hash & hash;
        }
        return Math.abs(hash);
    }

    private fnv1aHash(str: string): number {
        let hash = 0x811c9dc5;
        for (let i = 0; i < str.length; i++) {
            hash ^= str.charCodeAt(i);
            hash = (hash * 0x01000193) & 0xFFFFFFFF;
        }
        return Math.abs(hash);
    }
}
