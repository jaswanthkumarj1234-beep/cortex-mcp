/**
 * MCP Handler — JSON-RPC 2.0 request handler for the MCP protocol.
 *
 * Tools: recall_memory, store_memory, get_stats, scan_project, verify_files, get_context
 * Resources: brain/context (dynamic, auto-injected)
 */
import { MemoryStore } from '../db/memory-store';
import { EventLog } from '../db/event-log';
import { MemoryType, ScoredMemory } from '../types';
import { CONFIG } from '../config/config';
import { getCached, setCache, invalidateCache, cacheSize } from '../memory/memory-cache';
import { rankResults, formatResults } from '../memory/memory-ranker';
import { embedText, isWorkerReady } from '../memory/embedding-manager';
import { storeWithQuality, qualityCheck, findContradiction } from '../memory/memory-quality';
import { ProjectScanner } from '../scanners/project-scanner';
import { FileVerifier } from '../scanners/file-verifier';
import { ContextBuilder } from '../scanners/context-builder';
import { verifyCode } from '../scanners/code-verifier';
import { extractMemories } from '../memory/auto-learner';
import { startSession, feedSession, endSession, getRecentSessions, getSession } from '../memory/session-tracker';
import { anticipate, formatAnticipation } from '../memory/anticipation-engine';
import { consolidateMemories, shouldConsolidate } from '../memory/memory-consolidator';
import { detectActionContext, rankByAttention, formatAttentionContext } from '../memory/attention-ranker';
import { formatTemporalContext, getWorkspaceDiff } from '../memory/temporal-engine';
import { boostFrequentCorrections, formatHotCorrections } from '../memory/learning-rate';
import { detectKnowledgeGaps, formatKnowledgeGaps } from '../memory/meta-memory';
import { applyConfidenceDecay, runDecayMaintenance } from '../memory/confidence-decay';
import { captureGitCommits, detectFileChanges, formatFileChanges } from '../memory/git-memory';
import { buildExportMap, formatExportMap, storeExportMap } from '../scanners/export-map';
import { buildArchitectureGraph, formatArchitectureGraph, storeArchitectureGraph } from '../scanners/architecture-graph';
import { checkRateLimit, getRateLimitStats } from '../security/rate-limiter';
import { getLicense, isPro, refreshLicense, saveKey } from '../security/license';
import { getFeatureLimits, canStoreMemory, isFeatureAllowed, getUpgradeMessage, formatPlanStatus } from '../security/feature-gate';
import { exportMemories } from '../memory/export-import';
import { isLLMAvailable, getLLMProvider, enhanceMemory } from '../memory/llm-enhancer';

// --- Query Expansion (Synonym Map) ---
const SYNONYMS: Record<string, string[]> = {
    auth: ['authentication', 'login', 'signin', 'sign-in', 'credentials'],
    login: ['auth', 'authentication', 'signin', 'sign-in'],
    db: ['database', 'sql', 'postgresql', 'postgres', 'mongodb', 'sqlite'],
    database: ['db', 'sql', 'postgresql', 'postgres', 'mongodb', 'sqlite'],
    api: ['endpoint', 'route', 'rest', 'graphql', 'http'],
    error: ['bug', 'fix', 'issue', 'problem', 'crash', 'fail'],
    bug: ['error', 'fix', 'issue', 'problem', 'crash'],
    style: ['css', 'design', 'theme', 'color', 'font', 'layout'],
    test: ['testing', 'jest', 'vitest', 'spec', 'unittest'],
    deploy: ['deployment', 'ci', 'cd', 'pipeline', 'docker', 'build'],
};

function expandQuery(query: string): string {
    const words = query.toLowerCase().split(/\s+/).filter(w => w.length > 2);
    const expanded = new Set(words);

    for (const word of words) {
        if (expanded.size >= 8) break; // Cap expansion to prevent FTS hang
        const syns = SYNONYMS[word];
        if (syns) {
            for (const s of syns.slice(0, 2)) {
                if (expanded.size >= 8) break;
                expanded.add(s);
            }
        }
    }

    return Array.from(expanded).join(' OR ');
}

// --- MCP Tool Definitions ---
const MCP_TOOLS = [
    {
        name: 'recall_memory',
        description: 'Search the persistent memory database for relevant past decisions, corrections, bugs, conventions, and insights from previous coding sessions. ALWAYS call this before answering user questions to check for relevant context.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'What to search for in memory (e.g. "authentication bug fix", "database decision")' },
                maxResults: { type: 'number', description: 'Maximum results to return (default 10)' },
                currentFile: { type: 'string', description: 'Currently active file path (for relevance boosting)' },
            },
            required: ['query'],
        },
    },
    {
        name: 'store_memory',
        description: 'Actively store an important decision, correction, bug fix, convention, or insight into the persistent memory database so it is remembered across sessions.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['DECISION', 'CORRECTION', 'BUG_FIX', 'CONVENTION', 'INSIGHT'], description: 'Type of memory' },
                content: { type: 'string', description: 'What to remember — be concise and specific' },
                reason: { type: 'string', description: 'Why this matters (optional)' },
                files: { type: 'array', items: { type: 'string' }, description: 'Related file paths (optional)' },
                tags: { type: 'array', items: { type: 'string' }, description: 'Tags for categorization (optional)' },
            },
            required: ['type', 'content'],
        },
    },
    {
        name: 'get_stats',
        description: 'Get statistics about the memory database (active memories, total events, etc).',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'scan_project',
        description: 'Scan the project to capture its stack, structure, config, and recent git history. Run once per project to solve the "Day 1 Empty Brain" problem.',
        inputSchema: {
            type: 'object',
            properties: {
                workspaceRoot: { type: 'string', description: 'Root directory of the project to scan' },
            },
            required: ['workspaceRoot'],
        },
    },
    {
        name: 'verify_files',
        description: 'Verify file paths against the real file system to catch hallucinated paths. Pass AI-generated text and get back which file paths are valid and which are hallucinated.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'Text containing file paths to verify (e.g. AI response)' },
                workspaceRoot: { type: 'string', description: 'Root directory of the project' },
            },
            required: ['text', 'workspaceRoot'],
        },
    },
    {
        name: 'get_context',
        description: 'Get dynamic context based on the current file and project. Returns compressed context with corrections, decisions, conventions, and file-specific history.',
        inputSchema: {
            type: 'object',
            properties: {
                currentFile: { type: 'string', description: 'Currently active file path' },
                maxChars: { type: 'number', description: 'Maximum characters for context (default 3000)' },
            },
        },
    },
    {
        name: 'verify_code',
        description: 'Verify AI-generated code for hallucinations: checks if imported packages exist in package.json, if imported functions are actually exported from source files, and if referenced env variables exist in .env files.',
        inputSchema: {
            type: 'object',
            properties: {
                code: { type: 'string', description: 'The code to verify for hallucinated imports, exports, and env variables' },
                workspaceRoot: { type: 'string', description: 'Root directory of the project' },
            },
            required: ['code'],
        },
    },
    {
        name: 'force_recall',
        description: 'MANDATORY: Call this at the START of every conversation. Returns ALL corrections, decisions, conventions, and bug fixes. Also searches for topic-specific memories. This is the single entry point for complete context injection.',
        inputSchema: {
            type: 'object',
            properties: {
                topic: { type: 'string', description: 'What the user is asking about (used to search for relevant memories)' },
                currentFile: { type: 'string', description: 'Currently active file path (optional)' },
            },
            required: ['topic'],
        },
    },
    {
        name: 'quick_store',
        description: 'Quick-store a memory with just one sentence. Auto-classifies as CORRECTION, DECISION, CONVENTION, or BUG_FIX. Use this whenever you make or learn something worth remembering. Example: "Never use var, always use const in this project"',
        inputSchema: {
            type: 'object',
            properties: {
                memory: { type: 'string', description: 'One sentence describing the decision, correction, convention, or bug fix' },
            },
            required: ['memory'],
        },
    },
    {
        name: 'update_memory',
        description: 'Update or supersede an existing memory when a decision changes. Use this when you previously stored something that is now outdated or incorrect. The old memory will be deactivated and replaced with the new content.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'ID of the memory to update (from recall_memory results)' },
                content: { type: 'string', description: 'New content to replace the old memory with' },
                reason: { type: 'string', description: 'Why the memory is being updated (e.g. "switched from PostgreSQL to MongoDB")' },
            },
            required: ['id', 'content'],
        },
    },
    {
        name: 'list_memories',
        description: 'List all stored memories grouped by type (DECISION, CORRECTION, CONVENTION, BUG_FIX, INSIGHT). Use this to browse what Cortex knows, or to find a memory ID for update_memory or delete_memory.',
        inputSchema: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['DECISION', 'CORRECTION', 'CONVENTION', 'BUG_FIX', 'INSIGHT', 'ALL'], description: 'Filter by type (default: ALL)' },
                limit: { type: 'number', description: 'Max memories to return per type (default: 20)' },
            },
        },
    },
    {
        name: 'delete_memory',
        description: 'Permanently deactivate a specific memory by ID. Use this to remove outdated or incorrect memories. The memory is soft-deleted (history preserved). Get the ID from list_memories or recall_memory.',
        inputSchema: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'ID of the memory to delete' },
                reason: { type: 'string', description: 'Why this memory is being deleted (optional)' },
            },
            required: ['id'],
        },
    },
    {
        name: 'auto_learn',
        description: 'CALL THIS AFTER EVERY RESPONSE. Pass the text of your response and Cortex will automatically extract and store any decisions, corrections, conventions, or bug fixes — with zero manual effort. This is how Cortex learns passively.',
        inputSchema: {
            type: 'object',
            properties: {
                text: { type: 'string', description: 'The text of your response to scan for memory-worthy patterns' },
                context: { type: 'string', description: 'Optional: what the user was asking about (helps with categorization)' },
            },
            required: ['text'],
        },
    },
    {
        name: 'export_memories',
        description: 'Export all active memories to a JSON bundle. Returns the full backup data that can be saved or transferred to another machine.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
    {
        name: 'import_memories',
        description: 'Import memories from a previously exported JSON bundle. Duplicates are automatically skipped.',
        inputSchema: {
            type: 'object',
            properties: {
                data: { type: 'string', description: 'The JSON string of an exported memory bundle' },
            },
            required: ['data'],
        },
    },
    {
        name: 'health_check',
        description: 'Check the health and status of the Cortex server. Returns memory count, DB size, rate limit status, and uptime.',
        inputSchema: {
            type: 'object',
            properties: {},
        },
    },
];

// --- Dynamic Context via ContextBuilder ---
let cachedContextBuilder: ContextBuilder | null = null;

function getContextBuilder(memoryStore: MemoryStore): ContextBuilder {
    if (!cachedContextBuilder) {
        cachedContextBuilder = new ContextBuilder(memoryStore);
    }
    return cachedContextBuilder;
}

// --- Core Handler ---
export function createMCPHandler(memoryStore: MemoryStore, eventLog: EventLog, workspaceRoot?: string) {
    async function handleMCPRequest(rpc: any): Promise<any> {
        const id = rpc.id;

        switch (rpc.method) {
            case 'initialize':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        protocolVersion: '2024-11-05',
                        capabilities: { tools: {}, resources: {} },
                        serverInfo: { name: 'cortex', version: '2.0.0' },
                    },
                };

            case 'notifications/initialized':
                return null;

            case 'tools/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: { tools: MCP_TOOLS },
                };

            case 'resources/list':
                return {
                    jsonrpc: '2.0',
                    id,
                    result: {
                        resources: [{
                            uri: 'memory://brain/context',
                            name: 'Brain Context',
                            description: 'Top memories — corrections, decisions, conventions. Read this before every response.',
                            mimeType: 'text/plain',
                        }],
                    },
                };

            case 'resources/read': {
                const uri = rpc.params?.uri;
                if (uri === 'memory://brain/context') {
                    return {
                        jsonrpc: '2.0',
                        id,
                        result: {
                            contents: [{
                                uri: 'memory://brain/context',
                                mimeType: 'text/plain',
                                text: getContextBuilder(memoryStore).build(),
                            }],
                        },
                    };
                }
                return {
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: `Unknown resource: ${uri}` },
                };
            }

            case 'tools/call': {
                const toolName = rpc.params?.name;
                const args = rpc.params?.arguments || {};

                // Input validation
                if (args.query && typeof args.query === 'string' && args.query.length > 1000) {
                    return {
                        jsonrpc: '2.0', id,
                        result: { content: [{ type: 'text', text: 'Error: query too long (max 1000 chars)' }], isError: true },
                    };
                }
                if (args.content && typeof args.content === 'string' && args.content.length > 5000) {
                    return {
                        jsonrpc: '2.0', id,
                        result: { content: [{ type: 'text', text: 'Error: content too long (max 5000 chars)' }], isError: true },
                    };
                }

                if (toolName === 'recall_memory') {
                    return await handleRecallMemory(id, args);
                } else if (toolName === 'store_memory') {
                    return await handleStoreMemory(id, args);
                } else if (toolName === 'get_stats') {
                    return handleGetStats(id);
                } else if (toolName === 'scan_project') {
                    return await handleScanProject(id, args);
                } else if (toolName === 'verify_files') {
                    return handleVerifyFiles(id, args);
                } else if (toolName === 'get_context') {
                    return handleGetContext(id, args);
                } else if (toolName === 'verify_code') {
                    return handleVerifyCode(id, args);
                } else if (toolName === 'force_recall') {
                    return await handleForceRecall(id, args);
                } else if (toolName === 'quick_store') {
                    return handleQuickStore(id, args);
                } else if (toolName === 'update_memory') {
                    return handleUpdateMemory(id, args);
                } else if (toolName === 'list_memories') {
                    return handleListMemories(id, args);
                } else if (toolName === 'delete_memory') {
                    return handleDeleteMemory(id, args);
                } else if (toolName === 'auto_learn') {
                    return handleAutoLearn(id, args);
                } else if (toolName === 'export_memories') {
                    return handleExportMemories(id);
                } else if (toolName === 'import_memories') {
                    return handleImportMemories(id, args);
                } else if (toolName === 'health_check') {
                    return handleHealthCheck(id);
                } else {
                    return {
                        jsonrpc: '2.0', id,
                        result: { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true },
                    };
                }
            }

            // Backward compatibility
            case 'recall_memory':
                return await handleRecallMemory(id, rpc.params || {});
            case 'store_memory':
                return await handleStoreMemory(id, rpc.params || {});
            case 'get_stats':
                return handleGetStats(id);

            default:
                return {
                    jsonrpc: '2.0', id,
                    error: { code: -32601, message: `Method not found: ${rpc.method}` },
                };
        }
    }

    async function handleRecallMemory(id: any, args: any): Promise<any> {
        const queryText = args.query || '';
        const maxResults = Math.min(args.maxResults || 10, 50);
        const currentFile = args.currentFile;

        console.log(`  [SEARCH] recall: "${queryText}" (max ${maxResults})`);

        let ranked: ScoredMemory[] = [];
        const t0 = Date.now();

        // 0. Check cache
        const cacheKey = `recall:${queryText}:${maxResults}`;
        const cached = getCached(cacheKey);
        if (cached) {
            console.log(`  [CACHE] Hit in ${Date.now() - t0}ms`);
            // Parse cached JSON string back to object if needed, or if cached is already ScoredMemory[]
            // Assuming getCached returns the object directly
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: formatResults(cached, queryText) }] } };
        }

        try {
            // 1. FTS — try expanded query first, fall back to raw
            let ftsResults: ScoredMemory[] = [];
            try {
                const expanded = expandQuery(queryText);
                if (expanded !== queryText) {
                    // console.log(`  Expansion: ${queryText} -> ${expanded}`);
                    ftsResults = memoryStore.searchFTS(expanded, maxResults * 2);
                }
            } catch (e) { /* non-fatal */ }

            if (ftsResults.length === 0) {
                ftsResults = memoryStore.searchFTS(queryText, maxResults * 2);
            }
            console.log(`  [FTS] ${ftsResults.length} results`);

            // 2. Vector Search (if worker ready)
            let vectorResults: ScoredMemory[] = [];
            if (isWorkerReady()) {
                const embedding = await embedText(queryText);
                vectorResults = memoryStore.searchVector(new Float32Array(embedding), maxResults * 2);
                if (vectorResults.length > 0) {
                    console.log(`  [VECTOR] ${vectorResults.length} results`);
                }
            }

            // 3. Hybrid Ranking
            const rawRanked = rankResults(ftsResults, vectorResults, maxResults * 2, currentFile);

            // Map RankedResult to ScoredMemory
            ranked = rawRanked.map(r => ({
                ...r,
                matchMethod: 'hybrid' as const
            }));

            // 3b. Context-based boost (if current file provided)
            if (args.currentFile) {
                // Boost memories related to this file or its directory
                // Implementation in memory-ranker.ts (pending)
            }

            // 3c. Apply attention-based re-ranking (debugging→bugs, coding→conventions)
            const recallContext = detectActionContext(queryText, currentFile);
            ranked = rankByAttention(ranked, recallContext);

            // 3d. Causal chain enrichment — follow graph edges from top results
            const enriched: ScoredMemory[] = [];
            const seenIds = new Set<string>();
            for (const r of ranked.slice(0, maxResults)) {
                if (seenIds.has(r.memory.id)) continue;
                seenIds.add(r.memory.id);
                enriched.push(r);

                // Follow 1-hop causal links for top 5 results
                if (enriched.length <= 5) {
                    try {
                        const related = memoryStore.getRelated(r.memory.id, 1, 2);
                        for (const rel of related) {
                            if (!seenIds.has(rel.memory.id)) {
                                seenIds.add(rel.memory.id);
                                enriched.push({ ...rel, score: rel.score * 0.6 });
                            }
                        }
                    } catch { /* non-fatal */ }
                }
            }

            // 3b. Apply confidence decay (old unused memories rank lower)
            ranked = applyConfidenceDecay(
                enriched.map(r => ({ memory: r.memory, score: r.score, matchMethod: 'hybrid' as const }))
            );

            // Limit to requested count
            ranked = ranked.slice(0, maxResults);

            // 4. Touch for access tracking (reinforcement — used memories get stronger)
            if (ranked.length > 0) {
                await Promise.all(ranked.map(m => {
                    try { return memoryStore.touch(m.memory.id); } catch { return Promise.resolve(); }
                }));
                runDecayMaintenance(memoryStore); // Opportunistic decay
            }

            setCache(cacheKey, ranked);
            console.log(`  [OK] ${ranked.length} results in ${Date.now() - t0}ms`);

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: formatResults(ranked, queryText) }] },
            };
        } catch (err: any) {
            console.error(`  [ERROR] recall failed:`, err.message);
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Brain has ${memoryStore.activeCount()} memories but search failed: ${err.message}` }], isError: true },
            };
        }
    }

    async function handleStoreMemory(id: any, args: any): Promise<any> {
        const { type, content, reason, files, tags } = args;

        // Rate limit check
        const rateCheck = checkRateLimit('store');
        if (!rateCheck.allowed) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `[WARN] Rate limited: ${rateCheck.reason}` }], isError: true },
            };
        }

        if (!type || !content) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: 'Error: "type" and "content" are required' }], isError: true },
            };
        }

        const validTypes: Record<string, MemoryType> = {
            DECISION: MemoryType.DECISION,
            CORRECTION: MemoryType.CORRECTION,
            BUG_FIX: MemoryType.BUG_FIX,
            CONVENTION: MemoryType.CONVENTION,
            INSIGHT: MemoryType.INSIGHT,
            FAILED_SUGGESTION: MemoryType.FAILED_SUGGESTION,
            CONVERSATION: MemoryType.CONVERSATION,
            PROVEN_PATTERN: MemoryType.PROVEN_PATTERN,
        };

        const memType = validTypes[type];
        if (!memType) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Error: Invalid type "${type}". Use: DECISION, CORRECTION, BUG_FIX, CONVENTION, INSIGHT` }], isError: true },
            };
        }

        try {
            // License check — gate memory storage
            const activeCount = memoryStore.getActive(9999).length;
            const storeCheck = canStoreMemory(activeCount);
            if (!storeCheck.allowed) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: storeCheck.message }], isError: true },
                };
            }

            // Input sanitization — strip control chars
            const sanitized = content.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');

            // Optional LLM enhancement (if API key configured)
            let enhancedTags = tags || [type.toLowerCase()];
            let enhancedAction = `Stored via MCP: ${sanitized.slice(0, 200)}`;
            if (isLLMAvailable()) {
                try {
                    const enhanced = await enhanceMemory(sanitized, { files });
                    if (enhanced.tags?.length) enhancedTags = [...new Set([...enhancedTags, ...enhanced.tags])];
                    if (enhanced.action) enhancedAction = enhanced.action;
                } catch { /* LLM failed, use defaults */ }
            }

            // Quality gate + contradiction detection
            const memory = storeWithQuality(memoryStore, {
                type: memType,
                intent: sanitized.slice(0, 300),
                action: enhancedAction,
                reason: reason || undefined,
                importance: type === 'CORRECTION' ? 0.95 : type === 'DECISION' ? 0.85 : 0.7,
                confidence: 1.0,
                tags: enhancedTags,
                relatedFiles: files || [],
            });

            if (!memory) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `Memory rejected by quality check: "${sanitized.slice(0, 100)}" — too short, too generic, or duplicate` }], isError: true },
                };
            }

            // Active contradiction detection — find and resolve conflicts
            let contradictionNote = '';
            try {
                const contradiction = findContradiction(memoryStore, memType, sanitized);
                if (contradiction) {
                    memoryStore.deactivate(contradiction.existingId, memory.id);
                    memoryStore.addEdge({
                        sourceId: contradiction.existingId,
                        targetId: memory.id,
                        relation: 'superseded_by' as any,
                        weight: 0.95,
                        timestamp: Date.now(),
                    });
                    contradictionNote = ` [WARN] Superseded conflicting memory: "${contradiction.existingIntent.slice(0, 60)}"`;
                }
            } catch { /* non-fatal */ }

            // Auto-edge creation — link to recent memories of same type/files
            try {
                const recent = memoryStore.getByType(memType, 5);
                for (const r of recent) {
                    if (r.id !== memory.id) {
                        memoryStore.addEdge({
                            sourceId: memory.id,
                            targetId: r.id,
                            relation: 'related_to' as any,
                            weight: 0.5,
                            timestamp: Date.now(),
                        });
                        break; // Link to most recent only
                    }
                }
            } catch { /* non-fatal */ }

            // Feed session tracker
            feedSession({ decision: `[${type}] ${sanitized.slice(0, 60)}` });

            // Queue background embedding
            if (isWorkerReady()) {
                const embedText_ = [sanitized, reason || ''].join(' ').trim();
                embedText(embedText_).then((vector) => {
                    memoryStore.storeVector(memory.id, new Float32Array(vector));
                }).catch(() => { });
            }

            invalidateCache();
            console.log(`  [STORE] ${type}: "${args.content.slice(0, 50)}..."`);
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `[OK] Created memory: ${memory.id}\n(Active: ${memoryStore.activeCount()})${contradictionNote}` }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Failed to store memory: ${err.message}` }], isError: true },
            };
        }
    }

    function handleGetStats(id: any): any {
        return {
            jsonrpc: '2.0', id,
            result: {
                content: [{
                    type: 'text',
                    text: JSON.stringify({
                        activeMemories: memoryStore.activeCount(),
                        totalMemories: memoryStore.totalCount(),
                        totalEvents: eventLog.count(),
                        vectorSearchReady: isWorkerReady(),
                        cacheSize: cacheSize(),
                    }, null, 2),
                }],
            },
        };
    }

    // --- New Tool Handlers ---

    async function handleScanProject(id: any, args: any): Promise<any> {
        const root = args.workspaceRoot || workspaceRoot;
        if (!root) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: 'Error: workspaceRoot is required' }], isError: true },
            };
        }

        try {
            const scanner = new ProjectScanner(memoryStore, root);
            const count = await scanner.scan();

            // Deep scan: Export Map (anti-hallucination) + Architecture Graph
            let extraMemories = 0;
            try {
                const exportMap = buildExportMap(root);
                extraMemories += storeExportMap(memoryStore, exportMap);
            } catch { /* non-fatal */ }
            try {
                const archGraph = buildArchitectureGraph(root);
                extraMemories += storeArchitectureGraph(memoryStore, archGraph);
            } catch { /* non-fatal */ }

            invalidateCache();
            const total = count + extraMemories;
            return {
                jsonrpc: '2.0', id,
                result: {
                    content: [{
                        type: 'text',
                        text: total > 0
                            ? `Project scanned successfully. ${total} memories created (stack, structure, config, git history, export map, architecture graph).`
                            : 'Project was already scanned. No new memories created.',
                    }],
                },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Scan error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleVerifyFiles(id: any, args: any): any {
        const root = args.workspaceRoot || workspaceRoot;
        if (!root || !args.text) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: 'Error: text and workspaceRoot are required' }], isError: true },
            };
        }

        try {
            const verifier = new FileVerifier(root);
            const result = verifier.verifyText(args.text);

            const lines: string[] = [];
            if (result.valid.length > 0) {
                lines.push(`[OK] Valid paths (${result.valid.length}): ${result.valid.join(', ')}`);
            }
            if (result.invalid.length > 0) {
                lines.push(`[FAIL] Hallucinated paths (${result.invalid.length}): ${result.invalid.join(', ')}`);
                for (const [bad, suggestions] of Object.entries(result.suggestions)) {
                    lines.push(`   ${bad} → did you mean: ${suggestions.join(' or ')}?`);
                }
            }
            if (result.valid.length === 0 && result.invalid.length === 0) {
                lines.push('No file paths detected in the text.');
            }

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: lines.join('\n') }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Verify error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleGetContext(id: any, args: any): any {
        try {
            const builder = getContextBuilder(memoryStore);
            const context = builder.build({
                currentFile: args.currentFile,
                maxChars: args.maxChars,
            });
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: context }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Context error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleVerifyCode(id: any, args: any): any {
        const root = args.workspaceRoot || workspaceRoot;
        if (!root || !args.code) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: 'Error: code and workspaceRoot are required' }], isError: true },
            };
        }

        try {
            const result = verifyCode(args.code, root);
            const lines: string[] = [];

            // Imports
            if (result.imports.valid.length > 0 || result.imports.invalid.length > 0) {
                lines.push('## Package Imports');
                if (result.imports.valid.length > 0) {
                    lines.push(`[OK] Valid: ${result.imports.valid.join(', ')}`);
                }
                if (result.imports.invalid.length > 0) {
                    lines.push(`[FAIL] NOT IN package.json: ${result.imports.invalid.join(', ')}`);
                    for (const [bad, suggestions] of Object.entries(result.imports.suggestions)) {
                        lines.push(`   ${bad} → did you mean: ${suggestions.join(' or ')}?`);
                    }
                }
            }

            // Exports
            if (result.exports.valid.length > 0 || result.exports.invalid.length > 0) {
                lines.push('\n## Function/Class Exports');
                if (result.exports.valid.length > 0) {
                    lines.push(`[OK] Valid: ${result.exports.valid.join(', ')}`);
                }
                if (result.exports.invalid.length > 0) {
                    lines.push(`[FAIL] NOT EXPORTED: ${result.exports.invalid.join(', ')}`);
                    for (const [file, available] of Object.entries(result.exports.available)) {
                        lines.push(`   ${file} exports: ${available.join(', ')}`);
                    }
                }
            }

            // Env vars
            if (result.envVars.valid.length > 0 || result.envVars.invalid.length > 0) {
                lines.push('\n## Environment Variables');
                if (result.envVars.valid.length > 0) {
                    lines.push(`[OK] Valid: ${result.envVars.valid.join(', ')}`);
                }
                if (result.envVars.invalid.length > 0) {
                    lines.push(`[FAIL] NOT IN .env: ${result.envVars.invalid.join(', ')}`);
                    if (result.envVars.available.length > 0) {
                        lines.push(`   Available vars: ${result.envVars.available.join(', ')}`);
                    }
                }
            }

            if (lines.length === 0) {
                lines.push('No imports, exports, or env vars detected in the code.');
            }

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: lines.join('\n') }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Verify error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleQuickStore(id: any, args: any): any {
        // Rate limit check
        const rateCheck = checkRateLimit('store');
        if (!rateCheck.allowed) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `[WARN] Rate limited: ${rateCheck.reason}` }], isError: true },
            };
        }

        const text = args.memory?.trim();
        if (!text || text.length < 5) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: 'Error: provide a memory sentence (min 5 chars)' }], isError: true },
            };
        }

        // Auto-classify based on keywords
        const lower = text.toLowerCase();
        let type: MemoryType;
        let label: string;

        if (/\b(don'?t|never|wrong|instead|not|avoid|stop|incorrect)\b/.test(lower)) {
            type = MemoryType.CORRECTION;
            label = 'CORRECTION';
        } else if (/\b(fix|bug|broke|crash|error|patch|regression)\b/.test(lower)) {
            type = MemoryType.BUG_FIX;
            label = 'BUG_FIX';
        } else if (/\b(always|convention|style|format|standard|rule|must)\b/.test(lower)) {
            type = MemoryType.CONVENTION;
            label = 'CONVENTION';
        } else if (/\b(use|chose|decided|pick|select|go with|switch to|migrate)\b/.test(lower)) {
            type = MemoryType.DECISION;
            label = 'DECISION';
        } else {
            type = MemoryType.INSIGHT;
            label = 'INSIGHT';
        }

        try {
            const sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
            const memory = storeWithQuality(memoryStore, {
                type,
                intent: sanitized.slice(0, 300),
                action: `Quick-stored: ${sanitized.slice(0, 200)}`,
                importance: type === MemoryType.CORRECTION ? 0.95 : type === MemoryType.DECISION ? 0.85 : 0.7,
                confidence: 1.0,
                tags: [label.toLowerCase()],
                relatedFiles: [],
            });

            if (!memory) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `Rejected: too short, generic, or duplicate` }], isError: true },
                };
            }

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Memory stored as ${label}: "${sanitized.slice(0, 100)}"` }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Store error: ${err.message}` }], isError: true },
            };
        }
    }

    async function handleForceRecall(id: any, args: any): Promise<any> {
        try {
            const parts: string[] = [];

            // ─── BRAIN LAYER 0: End previous session + start new one ─────────
            endSession(memoryStore); // Save previous session summary
            startSession();
            if (args.topic) feedSession({ topic: args.topic });

            // ─── BRAIN LAYER 1: Maintenance (runs in background) ─────────────
            try {
                // Decay old unused memories
                runDecayMaintenance(memoryStore);
                // Boost frequently corrected topics
                boostFrequentCorrections(memoryStore);
                // Consolidate similar memories if needed
                if (shouldConsolidate(memoryStore)) {
                    consolidateMemories(memoryStore);
                }
            } catch { /* maintenance errors are non-fatal */ }

            // ─── BRAIN LAYER 2: Attention Context ────────────────────────────
            const actionContext = isPro() ? detectActionContext(args.topic, args.currentFile) : {} as any;
            const attentionLabel = isPro() ? formatAttentionContext(actionContext) : '';
            if (attentionLabel) parts.push(attentionLabel);

            // ─── BRAIN LAYER 3: Session Continuity ───────────────────────────
            const sessions = getRecentSessions(memoryStore, 3);
            if (sessions.length > 0) {
                parts.push('\n## 🧵 Recent Sessions (where we left off)');
                for (const s of sessions) parts.push(s);
            }

            // ─── BRAIN LAYER 4: Hot Corrections (learning rate) ──────────────
            const hotCorrections = formatHotCorrections(memoryStore);
            if (hotCorrections) parts.push('\n' + hotCorrections);

            // ─── BRAIN LAYER 5: Core Context (corrections, decisions, etc) ───
            const builder = getContextBuilder(memoryStore);
            const fullContext = builder.build({
                currentFile: args.currentFile,
                maxChars: 8000, // leave room for brain layers
            });
            parts.push(fullContext);

            // ─── BRAIN LAYER 6: Anticipation (file-aware proactive recall) ───
            if (args.currentFile && isPro()) {
                const anticipated = formatAnticipation(
                    anticipate(memoryStore, args.currentFile)
                );
                if (anticipated) parts.push('\n' + anticipated);
            }

            // ─── BRAIN LAYER 7: Temporal Context (what changed recently) ─────
            if (isPro()) {
                const temporal = formatTemporalContext(memoryStore);
                if (temporal) parts.push('\n' + temporal);
            }

            // ─── BRAIN LAYER 8: Workspace State (git changes) ────────────────
            try {
                const workspace = getWorkspaceDiff(workspaceRoot || '');
                if (workspace) parts.push('\n' + workspace);
            } catch { /* git not available */ }

            // ─── BRAIN LAYER 8.5: Git Memory (commit capture + file changes) ───
            if (isPro()) {
                try {
                    // Capture recent commits as memories
                    const commitsCaptured = captureGitCommits(memoryStore, workspaceRoot || '', 5);
                    if (commitsCaptured > 0) {
                        parts.push(`\n> Captured ${commitsCaptured} new git commit(s) as memories`);
                    }

                    // Show uncommitted file changes
                    const fileChanges = detectFileChanges(workspaceRoot || '');
                    const fileChangeText = formatFileChanges(fileChanges);
                    if (fileChangeText) parts.push('\n' + fileChangeText);
                } catch { /* git not available */ }
            } // end isPro() for git memory

            // ─── BRAIN LAYER 9: Topic-Specific Search ────────────────────────
            if (args.topic) {
                try {
                    let ftsResults = memoryStore.searchFTS(args.topic, 15);

                    // Apply confidence decay + attention ranking
                    ftsResults = applyConfidenceDecay(ftsResults);
                    ftsResults = rankByAttention(ftsResults, actionContext);

                    // Causal chain: follow graph edges for top results
                    const seen = new Set<string>();
                    const enriched: any[] = [];
                    for (const r of ftsResults) {
                        if (seen.has(r.memory.id)) continue;
                        seen.add(r.memory.id);
                        enriched.push(r);

                        // Follow causal links (1 hop)
                        try {
                            const related = memoryStore.getRelated(r.memory.id, 1, 3);
                            for (const rel of related) {
                                if (!seen.has(rel.memory.id)) {
                                    seen.add(rel.memory.id);
                                    enriched.push({ ...rel, score: rel.score * 0.7 });
                                }
                            }
                        } catch { }
                    }

                    if (enriched.length > 0) {
                        parts.push('\n## Topic: "' + args.topic + '"');
                        for (const m of enriched.slice(0, 15)) {
                            parts.push(`- [${m.memory.type}] ${m.memory.intent}${m.memory.reason ? ` — ${m.memory.reason}` : ''}`);
                        }
                    }
                } catch {
                    parts.push('\n> Note: Topic search unavailable (FTS index needs rebuild).');
                }
            }

            // ─── BRAIN LAYER 10: Knowledge Gaps (meta-memory) ────────────────
            try {
                const gaps = detectKnowledgeGaps(memoryStore, workspaceRoot || '');
                const gapText = formatKnowledgeGaps(gaps);
                if (gapText) parts.push('\n' + gapText);
            } catch { /* non-fatal */ }

            // ─── BRAIN LAYER 11: Export Map (anti-hallucination) ──────────────
            if (workspaceRoot && isPro()) {
                try {
                    const exportMap = buildExportMap(workspaceRoot);
                    if (exportMap.totalExports > 0) {
                        const exportText = formatExportMap(exportMap);
                        if (exportText) parts.push('\n' + exportText);
                    }
                } catch { /* non-fatal */ }
            }

            // ─── BRAIN LAYER 12: Architecture Graph (deep understanding) ──────
            if (workspaceRoot && isPro()) {
                try {
                    const archGraph = buildArchitectureGraph(workspaceRoot);
                    if (archGraph.totalFiles > 0) {
                        const archText = formatArchitectureGraph(archGraph);
                        if (archText) parts.push('\n' + archText);
                    }
                } catch { /* non-fatal */ }
            }

            // ─── SMART CONTEXT SELECTION: Trim to token budget ───────────────
            let output = parts.join('\n');
            const MAX_CHARS = 12000; // ~3000 tokens — fits any model
            if (output.length > MAX_CHARS) {
                // Keep critical sections, trim lower-priority ones
                output = output.slice(0, MAX_CHARS) + '\n\n> (Context trimmed to fit token budget. Use `recall_memory` for specific queries.)';
            }

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: output }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Force recall error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleUpdateMemory(id: number | string, args: any) {
        try {
            const memoryId: string = args.id;
            const newContent: string = args.content;
            const reason: string = args.reason || 'Updated by AI';

            if (!memoryId || !newContent) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: 'Error: id and content are required' }], isError: true },
                };
            }

            // Get the existing memory
            const existing = memoryStore.get(memoryId);
            if (!existing) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `Error: Memory ${memoryId} not found` }], isError: true },
                };
            }

            // Create the new (replacement) memory
            const newMemory = memoryStore.add({
                type: existing.type,
                intent: newContent,
                action: newContent,
                reason,
                tags: existing.tags,
                relatedFiles: existing.relatedFiles,
                confidence: existing.confidence,
                importance: existing.importance,
            });

            // Deactivate the old memory, pointing to the new one
            memoryStore.deactivate(memoryId, newMemory.id);
            invalidateCache();

            return {
                jsonrpc: '2.0', id,
                result: {
                    content: [{
                        type: 'text',
                        text: `Memory updated.\n\nOld: "${existing.intent}"\nNew: "${newContent}"\nReason: ${reason}\n\nOld memory deactivated (ID: ${memoryId})\nNew memory ID: ${newMemory.id}`,
                    }],
                },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Update error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleListMemories(id: number | string, args: any) {
        try {
            const filterType = args?.type && args.type !== 'ALL' ? args.type : null;
            const limit = args?.limit || 20;

            const TYPES = ['CORRECTION', 'DECISION', 'CONVENTION', 'BUG_FIX', 'INSIGHT'];
            const typesToShow = filterType ? [filterType] : TYPES;

            const parts: string[] = ['# Cortex Memory Bank\n'];
            let totalCount = 0;

            for (const type of typesToShow) {
                const memories = memoryStore.getByType(type as any, limit);
                if (memories.length === 0) continue;

                const emoji: Record<string, string> = {
                    CORRECTION: '[COR]', DECISION: '[DEC]', CONVENTION: '[CON]',
                    BUG_FIX: '[BUG]', INSIGHT: '[INS]',
                };
                parts.push(`## ${emoji[type] || '[---]'} ${type} (${memories.length})\n`);

                for (const m of memories) {
                    const age = Math.floor((Date.now() - m.createdAt) / (24 * 60 * 60 * 1000));
                    const accessed = m.accessCount > 0 ? ` · accessed ${m.accessCount}x` : '';
                    parts.push(`- **${m.intent}**`);
                    parts.push(`  \`id: ${m.id}\` · ${age}d old${accessed}`);
                    if (m.reason) parts.push(`  _${m.reason}_`);
                }
                parts.push('');
                totalCount += memories.length;
            }

            if (totalCount === 0) {
                parts.push('_No memories stored yet. Use `quick_store` to add some._');
            } else {
                parts.push(`\n_Total: ${totalCount} active memories. Use \`update_memory\` or \`delete_memory\` with the ID shown._`);
            }

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: parts.join('\n') }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `List error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleDeleteMemory(id: number | string, args: any) {
        try {
            const memoryId: string = args.id;
            const reason: string = args.reason || 'Deleted by AI';

            if (!memoryId) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: 'Error: id is required' }], isError: true },
                };
            }

            const existing = memoryStore.get(memoryId);
            if (!existing) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `Error: Memory ${memoryId} not found` }], isError: true },
                };
            }

            if (!existing.isActive) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `Memory ${memoryId} is already inactive` }], isError: true },
                };
            }

            memoryStore.deactivate(memoryId);
            invalidateCache();

            return {
                jsonrpc: '2.0', id,
                result: {
                    content: [{
                        type: 'text',
                        text: `Memory deleted.\n\nContent: "${existing.intent}"\nType: ${existing.type}\nReason: ${reason}\n\nMemory ID ${memoryId} has been deactivated.`,
                    }],
                },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Delete error: ${err.message}` }], isError: true },
            };
        }
    }

    async function handleAutoLearn(id: number | string, args: any) {
        try {
            // PRO feature gate
            if (!isPro()) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: getUpgradeMessage('auto_learn') }] },
                };
            }

            // Rate limit check
            const rateCheck = checkRateLimit('auto_learn');
            if (!rateCheck.allowed) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `(auto_learn rate limited: ${rateCheck.reason})` }] },
                };
            }

            const text: string = args.text;
            if (!text || text.length < 20) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: '(auto_learn: text too short, nothing extracted)' }] },
                };
            }

            // Extract memory-worthy patterns (regex-based)
            const extracted = extractMemories(text);

            // LLM enhancement: when API key is available and regex found nothing,
            // use LLM to catch implicit patterns that keywords miss
            if (extracted.length === 0 && isLLMAvailable() && text.length > 50) {
                try {
                    const llmResult = await enhanceMemory(text);
                    if (llmResult && llmResult.intent && llmResult.intent.length > 10) {
                        extracted.push({
                            type: (llmResult.type || 'INSIGHT') as any,
                            content: llmResult.intent,
                            confidence: 0.7,
                            reason: 'LLM-extracted (regex missed this)',
                        });
                    }
                } catch { /* LLM failed, fall through to no-patterns path */ }
            }

            if (extracted.length === 0) {
                // Still feed session even if no patterns extracted (for topic tracking)
                if (text.length > 50) {
                    feedSession({ topic: text.slice(0, 80) });
                }
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: '(auto_learn: no memory-worthy patterns detected)' }] },
                };
            }

            // Store each extracted memory + feed session tracker
            const stored: string[] = [];
            const skipped: string[] = [];

            for (const item of extracted) {
                try {
                    // Feed the session tracker with extracted patterns
                    switch (item.type) {
                        case 'DECISION':
                            feedSession({ decision: item.content }); break;
                        case 'FAILED_ATTEMPT':
                            feedSession({ failedAttempt: item.content }); break;
                        case 'BUSINESS_RULE':
                            feedSession({ businessRule: item.content }); break;
                        case 'GOTCHA':
                            feedSession({ gotcha: item.content }); break;
                        case 'CURRENT_TASK':
                            feedSession({ currentTask: item.content }); break;
                        default:
                            feedSession({ topic: item.content.slice(0, 60) }); break;
                    }

                    const result = storeWithQuality(memoryStore, {
                        type: item.type as any,
                        intent: item.content,
                        action: item.content,
                        reason: item.reason,
                        confidence: item.confidence,
                        importance: item.confidence,
                        tags: [item.type.toLowerCase()],
                    });

                    if (result.stored) {
                        stored.push(`[${item.type}] ${item.content.slice(0, 60)}${item.content.length > 60 ? '…' : ''}`);
                    } else {
                        skipped.push(`[${item.type}] ${item.content.slice(0, 40)}… (duplicate)`);
                    }
                } catch {
                    // Skip individual failures silently
                }
            }

            if (stored.length > 0) {
                invalidateCache();
            }

            const lines: string[] = ['**Auto-Learn Results:**'];
            if (stored.length > 0) {
                lines.push(`\nStored ${stored.length} new memory${stored.length > 1 ? 'ies' : 'y'}:`);
                stored.forEach(s => lines.push(`  • ${s}`));
            }
            if (skipped.length > 0) {
                lines.push(`\nSkipped ${skipped.length} duplicate${skipped.length > 1 ? 's' : ''}:`);
                skipped.forEach(s => lines.push(`  • ${s}`));
            }

            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: lines.join('\n') }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `auto_learn error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleExportMemories(id: number | string) {
        try {
            const bundle = exportMemories(memoryStore);
            return {
                jsonrpc: '2.0', id,
                result: {
                    content: [{
                        type: 'text',
                        text: `**Exported ${bundle.memoryCount} memories**\n\nSave this JSON to transfer to another machine:\n\n\`\`\`json\n${JSON.stringify(bundle, null, 2)}\n\`\`\``,
                    }],
                },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Export error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleImportMemories(id: number | string, args: any) {
        try {
            const data = args.data;
            if (!data) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: 'Error: data is required (JSON string of exported bundle)' }], isError: true },
                };
            }

            const bundle = JSON.parse(data);
            if (bundle.version !== 1) {
                return {
                    jsonrpc: '2.0', id,
                    result: { content: [{ type: 'text', text: `Error: Unsupported export version: ${bundle.version}` }], isError: true },
                };
            }

            // Use the shared importMemories module (dedup-aware, O(n) not O(n²))
            const { importMemories } = require('../memory/export-import');
            const result = importMemories(memoryStore, bundle);

            invalidateCache();
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Import complete.\n\nImported: ${result.imported}\nSkipped (duplicates): ${result.skipped}\nErrors: ${result.errors}` }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Import error: ${err.message}` }], isError: true },
            };
        }
    }

    function handleHealthCheck(id: number | string) {
        try {
            const stats = getRateLimitStats();
            const activeCount = memoryStore.activeCount();
            const parts = [
                '# Cortex Health Check\n',
                `| Metric | Value |`,
                `|--------|-------|`,
                `| Active Memories | ${activeCount} |`,
                `| Session Store Count | ${stats.storeCount}/30 |`,
                `| Session Auto-Learn Count | ${stats.autoLearnCount}/100 |`,
                `| Session Total Calls | ${stats.totalCalls}/500 |`,
                `| Uptime | ${Math.floor(stats.uptime / 60)}m ${stats.uptime % 60}s |`,
                `| Status | Healthy |`,
            ];
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: parts.join('\n') }] },
            };
        } catch (err: any) {
            return {
                jsonrpc: '2.0', id,
                result: { content: [{ type: 'text', text: `Health check error: ${err.message}` }], isError: true },
            };
        }
    }

    return { handleMCPRequest };
}
