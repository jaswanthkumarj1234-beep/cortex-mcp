/**
 * Feature Gate — Enforces free/paid limits based on license.
 *
 * FREE plan limits:
 *   - Max 20 active memories
 *   - Basic recall only (no brain layers)
 *   - No auto-learn
 *   - No export map / architecture graph
 *   - No git memory
 *   - No contradiction detection
 *   - No confidence decay
 *
 * PRO plan: Everything unlocked, unlimited.
 */
import { getLicense, isPro, isFree, Plan } from './license';

export interface FeatureLimits {
    maxMemories: number;
    brainLayers: boolean;       // 14-layer force_recall
    autoLearn: boolean;
    exportMap: boolean;
    architectureGraph: boolean;
    gitMemory: boolean;
    contradictionDetection: boolean;
    confidenceDecay: boolean;
    memoryConsolidation: boolean;
    attentionRanking: boolean;
    anticipation: boolean;
    knowledgeGaps: boolean;
    temporalContext: boolean;
    crossSessionThreading: boolean;
}

const FREE_LIMITS: FeatureLimits = {
    maxMemories: 20,
    brainLayers: false,
    autoLearn: false,
    exportMap: false,
    architectureGraph: false,
    gitMemory: false,
    contradictionDetection: false,
    confidenceDecay: false,
    memoryConsolidation: false,
    attentionRanking: false,
    anticipation: false,
    knowledgeGaps: false,
    temporalContext: false,
    crossSessionThreading: false,
};

const PRO_LIMITS: FeatureLimits = {
    maxMemories: Infinity,
    brainLayers: true,
    autoLearn: true,
    exportMap: true,
    architectureGraph: true,
    gitMemory: true,
    contradictionDetection: true,
    confidenceDecay: true,
    memoryConsolidation: true,
    attentionRanking: true,
    anticipation: true,
    knowledgeGaps: true,
    temporalContext: true,
    crossSessionThreading: true,
};

/** Get current feature limits based on license */
export function getFeatureLimits(): FeatureLimits {
    return isPro() ? PRO_LIMITS : FREE_LIMITS;
}

/** Check if a specific feature is allowed */
export function isFeatureAllowed(feature: keyof FeatureLimits): boolean {
    const limits = getFeatureLimits();
    const value = limits[feature];
    if (typeof value === 'boolean') return value;
    return true; // numeric limits are checked separately
}

/** Check if user can store more memories */
export function canStoreMemory(currentCount: number): { allowed: boolean; message: string } {
    const limits = getFeatureLimits();
    if (currentCount >= limits.maxMemories) {
        return {
            allowed: false,
            message: `[LOCKED] Free plan limit: ${limits.maxMemories} memories. Upgrade to PRO for unlimited. Set CORTEX_LICENSE_KEY or visit cortex-mcp.org`,
        };
    }
    return { allowed: true, message: '' };
}

/** Get upgrade message for gated features */
export function getUpgradeMessage(feature: string): string {
    return `[LOCKED] "${feature}" is a PRO feature. Upgrade at cortex-mcp.org or set CORTEX_LICENSE_KEY to unlock.`;
}

/** Format plan status for display */
export function formatPlanStatus(): string {
    const license = getLicense();
    const limits = getFeatureLimits();

    if (license.plan === 'PRO') {
        return `[PRO] Cortex PRO — All features unlocked, unlimited memories.`;
    }

    return `[FREE] Cortex Free — ${limits.maxMemories} memories, basic features. Upgrade: set CORTEX_LICENSE_KEY`;
}
