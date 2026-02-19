/**
 * Cognitive Memory — Core Type Definitions
 * Every interface and enum the entire system uses.
 */
import type { Database as SqliteDatabase } from 'better-sqlite3';

// ═══════════════════════════════════════════════════════════
//  EVENTS — What the IDE tells the brain
// ═══════════════════════════════════════════════════════════

export enum EventType {
    CODE_EDIT = 'code_edit',
    FILE_OPEN = 'file_open',
    FILE_CREATE = 'file_create',
    FILE_DELETE = 'file_delete',
    FILE_RENAME = 'file_rename',
    FILE_SAVE = 'file_save',
    CHAT_MESSAGE = 'chat_message',
    CHAT_RESPONSE = 'chat_response',
    DEBUG_START = 'debug_start',
    DEBUG_END = 'debug_end',
    TERMINAL_COMMAND = 'terminal_command',
    TERMINAL_OUTPUT = 'terminal_output',
    ERROR_DIAGNOSTIC = 'error_diagnostic',
    GIT_COMMIT = 'git_commit',
}

export enum EventSource {
    EDITOR = 'editor',
    CHAT = 'chat',
    TERMINAL = 'terminal',
    DEBUG = 'debug',
    GIT = 'git',
    SYSTEM = 'system',
}

export interface BrainEvent {
    id?: number;
    eventType: EventType;
    source: EventSource;
    content: string;
    diff?: string;
    file?: string;
    metadata?: Record<string, unknown>;
    timestamp: number;
    processed?: boolean;
}

// ═══════════════════════════════════════════════════════════
//  MEMORY — What the brain remembers
// ═══════════════════════════════════════════════════════════

export enum MemoryType {
    DECISION = 'decision',
    CODE_CHANGE = 'code_change',
    BUG_FIX = 'bug_fix',
    INSIGHT = 'insight',
    CORRECTION = 'correction',
    CONVENTION = 'convention',
    FILE_SNAPSHOT = 'file_snapshot',
    DEPENDENCY = 'dependency',
    PROVEN_PATTERN = 'proven_pattern',
    FAILED_SUGGESTION = 'failed_suggestion',
    CONVERSATION = 'conversation',
}

export interface MemoryUnit {
    id: string;
    type: MemoryType;
    intent: string;         // WHAT happened
    action: string;         // WHAT was done
    reason?: string;        // WHY
    impact?: string;        // HOW it affects the project
    outcome?: string;       // RESULT (success/failure/unknown)
    relatedFiles?: string[];
    codeSnippet?: string;
    tags?: string[];
    timestamp: number;
    confidence: number;     // 0.0 – 1.0
    importance: number;     // 0.0 – 1.0
    accessCount: number;
    lastAccessed?: number;
    supersededBy?: string;
    isActive: boolean;
    sourceEventId?: number;
    createdAt: number;
}

// ═══════════════════════════════════════════════════════════
//  GRAPH — How memories connect
// ═══════════════════════════════════════════════════════════

export enum EdgeRelation {
    CAUSED_BY = 'CAUSED_BY',
    FIXED_BY = 'FIXED_BY',
    REPLACED_BY = 'REPLACED_BY',
    DEPENDS_ON = 'DEPENDS_ON',
    DECIDED_FOR = 'DECIDED_FOR',
    LED_TO = 'LED_TO',
    RELATED_TO = 'RELATED_TO',
}

export interface GraphEdge {
    sourceId: string;
    targetId: string;
    relation: EdgeRelation;
    weight: number;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════
//  RETRIEVAL — How the brain recalls
// ═══════════════════════════════════════════════════════════

export enum QueryType {
    SEMANTIC = 'semantic',       // "why does auth fail?"
    TEMPORAL = 'temporal',       // "what changed yesterday?"
    STRUCTURAL = 'structural',   // "what depends on this file?"
    CAUSAL = 'causal',           // "what caused this bug?"
    EXPLORATORY = 'exploratory', // "tell me about the auth system"
}

export interface RecallQuery {
    query: string;
    currentFile?: string;
    queryType?: QueryType;
    tokenBudget?: number;
    maxResults?: number;
    filters?: {
        types?: MemoryType[];
        files?: string[];
        since?: number;
        minImportance?: number;
    };
}

export interface RecallResult {
    memories: ScoredMemory[];
    totalFound: number;
    searchTimeMs: number;
    methods: string[];
}

export interface ScoredMemory {
    memory: MemoryUnit;
    score: number;
    matchMethod: string;
}

// ═══════════════════════════════════════════════════════════
//  FEEDBACK — How the brain learns
// ═══════════════════════════════════════════════════════════

export enum UserSignal {
    ACCEPTED = 'accepted',
    REJECTED = 'rejected',
    CORRECTED = 'corrected',
}

export interface FeedbackEntry {
    memoryId: string;
    queryHash: string;
    queryType?: string;
    searchMethod?: string;
    wasUseful: boolean;
    timestamp: number;
}

export interface UserSignalEntry {
    memoryId: string;
    signal: UserSignal;
    correction?: string;
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════
//  CONTEXT — What gets injected into the LLM
// ═══════════════════════════════════════════════════════════

export interface ComposedContext {
    text: string;          // formatted text to inject
    tokenCount: number;
    memoriesUsed: string[];  // IDs
    sections: ContextSection[];
}

export interface ContextSection {
    title: string;
    content: string;
    priority: number;      // higher = more important
    tokenCount: number;
}

// ═══════════════════════════════════════════════════════════
//  ATTENTION — What the developer is focused on
// ═══════════════════════════════════════════════════════════

export interface AttentionFrame {
    activeFile?: string;
    cursorFunction?: string;
    openTabs: string[];
    action: 'editing' | 'debugging' | 'reading' | 'chatting' | 'idle';
    taskType?: 'bug_fix' | 'feature' | 'refactor' | 'explore' | 'unknown';
    focusDepth: 'shallow' | 'medium' | 'deep';
    timestamp: number;
}

// ═══════════════════════════════════════════════════════════
//  STRATEGIES — Pluggable components
// ═══════════════════════════════════════════════════════════

export interface EmbedderStrategy {
    readonly name: string;
    embed(text: string): Promise<Float32Array>;
    embedBatch(texts: string[]): Promise<Float32Array[]>;
}

export interface ExtractorStrategy {
    readonly name: string;
    extract(event: BrainEvent, existingMemories?: MemoryUnit[]): Promise<ExtractionResult>;
}

export interface ExtractionResult {
    action: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
    memory?: Partial<MemoryUnit>;
    updateTargetId?: string;
    deleteTargetId?: string;
    edges?: GraphEdge[];
}

export interface RetrieverStrategy {
    readonly name: string;
    retrieve(query: RecallQuery, limit: number): Promise<ScoredMemory[]>;
}

export interface ScorerStrategy {
    readonly name: string;
    score(memory: MemoryUnit, query: RecallQuery, rawScore: number): number;
}

// ═══════════════════════════════════════════════════════════
//  KERNEL — Core orchestrator interfaces
// ═══════════════════════════════════════════════════════════

export interface BrainConfig {
    dbPath: string;
    tokenBudget: number;
    eventThrottleMs: number;
    enabled: boolean;
}

export interface BrainStats {
    totalMemories: number;
    activeMemories: number;
    totalEvents: number;
    dbSizeBytes: number;
    lastEventTime?: number;
    uptime: number;
}

export type EventHandler = (event: BrainEvent) => void | Promise<void>;

export interface EventBus {
    on(eventType: string, handler: EventHandler): void;
    off(eventType: string, handler: EventHandler): void;
    emit(eventType: string, event: BrainEvent): Promise<void>;
}

export { SqliteDatabase };
