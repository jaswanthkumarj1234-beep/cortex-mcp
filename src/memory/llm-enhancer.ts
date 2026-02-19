/**
 * LLM Enhancer — Optional LLM-powered memory enrichment.
 * 
 * When the user provides an API key (OPENAI_API_KEY or CORTEX_LLM_KEY),
 * this module uses an LLM to:
 *   1. Better classify memories (vs. keyword matching)
 *   2. Extract richer insights from commit messages
 *   3. Generate smart tags and connections
 *   4. Summarize and merge related memories
 * 
 * When no API key is available, falls back to keyword-based classification.
 * This ensures Cortex works for EVERYONE — free without an API key,
 * but smarter WITH one.
 */

import * as https from 'https';
import * as http from 'http';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface LLMEnhancedMemory {
    type: string;
    intent: string;
    action: string;
    tags: string[];
    reason?: string;
    connections?: string[];  // Related concepts/files
}

export interface LLMConfig {
    apiKey: string;
    model: string;
    baseUrl: string;
    maxTokens: number;
}

// ─── Config Detection ─────────────────────────────────────────────────────────

function detectLLMConfig(): LLMConfig | null {
    // Check multiple API key sources
    const apiKey = process.env.OPENAI_API_KEY
        || process.env.CORTEX_LLM_KEY
        || process.env.ANTHROPIC_API_KEY
        || null;

    if (!apiKey) return null;

    // Detect which provider based on key prefix
    if (apiKey.startsWith('sk-ant-')) {
        return {
            apiKey,
            model: process.env.CORTEX_LLM_MODEL || 'claude-3-haiku-20240307',
            baseUrl: 'https://api.anthropic.com',
            maxTokens: 200,
        };
    }

    // Default to OpenAI-compatible (works with OpenAI, OpenRouter, local)
    return {
        apiKey,
        model: process.env.CORTEX_LLM_MODEL || 'gpt-4o-mini',
        baseUrl: process.env.CORTEX_LLM_BASE_URL || 'https://api.openai.com',
        maxTokens: 200,
    };
}

// ─── LLM Call ─────────────────────────────────────────────────────────────────

function callOpenAI(config: LLMConfig, prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = new URL('/v1/chat/completions', config.baseUrl);
        const body = JSON.stringify({
            model: config.model,
            messages: [{ role: 'user', content: prompt }],
            max_tokens: config.maxTokens,
            temperature: 0.1,
        });

        const options = {
            hostname: url.hostname,
            port: url.port || 443,
            path: url.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${config.apiKey}`,
                'Content-Length': Buffer.byteLength(body),
            },
        };

        const transport = url.protocol === 'https:' ? https : http;
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', (chunk: string) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const content = json.choices?.[0]?.message?.content || '';
                    resolve(content.trim());
                } catch {
                    reject(new Error('Failed to parse LLM response'));
                }
            });
        });

        req.on('error', reject);
        req.setTimeout(10000, () => {
            req.destroy();
            reject(new Error('LLM request timeout'));
        });
        req.write(body);
        req.end();
    });
}

// ─── Keyword Fallback (No API Key) ────────────────────────────────────────────

function classifyByKeywords(text: string): string {
    const lower = text.toLowerCase();
    if (/\b(fix|bug|patch|hotfix|resolve|repair|correct|issue|crash|error)\b/.test(lower)) return 'BUG_FIX';
    if (/\b(refactor|clean|rename|restructure|reorganize|lint|format|style|convention)\b/.test(lower)) return 'CONVENTION';
    if (/\b(feat|add|implement|create|new|introduce|support|enable|integrate|decide)\b/.test(lower)) return 'DECISION';
    if (/\b(doc|readme|comment|explain|note|changelog|learn|discover|insight)\b/.test(lower)) return 'INSIGHT';
    if (/\b(test|spec|coverage|assert|verify)\b/.test(lower)) return 'CONVENTION';
    if (/\b(revert|rollback|undo)\b/.test(lower)) return 'BUG_FIX';
    return 'DECISION';
}

function extractKeywordTags(text: string): string[] {
    const tags: string[] = [];
    const lower = text.toLowerCase();
    const patterns: [RegExp, string][] = [
        [/\b(auth|login|session|token|jwt|oauth)\b/, 'auth'],
        [/\b(database|sql|query|migration|schema)\b/, 'database'],
        [/\b(api|endpoint|route|rest|graphql)\b/, 'api'],
        [/\b(ui|component|render|style|css|html)\b/, 'ui'],
        [/\b(test|spec|mock|assert|coverage)\b/, 'testing'],
        [/\b(deploy|ci|cd|pipeline|docker|k8s)\b/, 'devops'],
        [/\b(security|encrypt|permission|vulnerability)\b/, 'security'],
        [/\b(perf|optimize|cache|speed|memory)\b/, 'performance'],
        [/\b(config|env|setting|option)\b/, 'config'],
        [/\b(error|exception|crash|debug|log)\b/, 'error-handling'],
    ];
    for (const [pattern, tag] of patterns) {
        if (pattern.test(lower)) tags.push(tag);
    }
    return tags;
}

// ─── Public API ───────────────────────────────────────────────────────────────

let _config: LLMConfig | null | undefined = undefined;
let _available: boolean | undefined = undefined;

/**
 * Check if LLM enhancement is available (API key configured).
 */
export function isLLMAvailable(): boolean {
    if (_available === undefined) {
        _config = detectLLMConfig();
        _available = _config !== null;
    }
    return _available;
}

/**
 * Get which LLM provider is configured.
 */
export function getLLMProvider(): string {
    if (!isLLMAvailable() || !_config) return 'none';
    if (_config.baseUrl.includes('anthropic')) return `anthropic/${_config.model}`;
    return `openai/${_config.model}`;
}

/**
 * Enhance a memory with LLM intelligence.
 * Falls back to keyword-based classification if no API key.
 */
export async function enhanceMemory(
    text: string,
    context?: { files?: string[], commitHash?: string }
): Promise<LLMEnhancedMemory> {
    // Keyword fallback (always works, free)
    const fallback: LLMEnhancedMemory = {
        type: classifyByKeywords(text),
        intent: text.length > 200 ? text.slice(0, 200) + '...' : text,
        action: text,
        tags: extractKeywordTags(text),
    };

    if (!isLLMAvailable() || !_config) {
        return fallback;
    }

    // LLM enhancement
    try {
        const filesContext = context?.files?.length
            ? `\nFiles involved: ${context.files.slice(0, 5).join(', ')}`
            : '';

        const prompt = `Analyze this developer activity and return JSON only (no markdown):
{
  "type": "BUG_FIX" | "DECISION" | "CONVENTION" | "INSIGHT" | "CORRECTION",
  "intent": "one-line summary of what happened",
  "action": "what was done and why (2-3 sentences max)",
  "tags": ["relevant", "topic", "tags"],
  "connections": ["related concepts or patterns"]
}

Activity: ${text}${filesContext}

Rules:
- BUG_FIX = fixed a bug or error
- DECISION = chose a technology, approach, or architecture
- CONVENTION = established or followed a coding pattern
- INSIGHT = learned something useful
- CORRECTION = corrected a previous mistake
- Keep intent under 100 chars
- Max 5 tags, max 3 connections`;

        const response = await callOpenAI(_config, prompt);

        // Parse JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            return {
                type: parsed.type || fallback.type,
                intent: parsed.intent || fallback.intent,
                action: parsed.action || fallback.action,
                tags: Array.isArray(parsed.tags) ? parsed.tags.slice(0, 5) : fallback.tags,
                connections: Array.isArray(parsed.connections) ? parsed.connections.slice(0, 3) : undefined,
            };
        }
    } catch (err: any) {
        // LLM failed — fall back silently
        console.log(`[cortex] LLM enhancement failed (using keywords): ${err.message}`);
    }

    return fallback;
}

/**
 * Summarize multiple related memories into one.
 * Only works with LLM, returns null without API key.
 */
export async function summarizeMemories(
    memories: Array<{ intent: string; type: string; timestamp: number }>
): Promise<string | null> {
    if (!isLLMAvailable() || !_config || memories.length < 2) return null;

    try {
        const items = memories
            .slice(0, 10)
            .map((m, i) => `${i + 1}. [${m.type}] ${m.intent}`)
            .join('\n');

        const prompt = `Summarize these related developer memories into one concise statement (1-2 sentences):

${items}

Return ONLY the summary text, nothing else.`;

        return await callOpenAI(_config, prompt);
    } catch {
        return null;
    }
}
