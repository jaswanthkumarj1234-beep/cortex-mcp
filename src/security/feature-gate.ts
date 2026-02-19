/**
 * Feature Gate — Enforces free/trial/paid limits based on license.
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
 * TRIAL plan: Same as PRO for 7 days after sign-up.
 * PRO plan:   Everything unlocked, unlimited.
 */
import { getLicense, isPro, isFree, isTrial, getTrialStatus, Plan } from './license';

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

// Trial gets same limits as PRO
const TRIAL_LIMITS: FeatureLimits = { ...PRO_LIMITS };

/** Get current feature limits based on license */
export function getFeatureLimits(): FeatureLimits {
    const license = getLicense();
    if (license.plan === 'PRO') return PRO_LIMITS;
    if (license.plan === 'TRIAL') return TRIAL_LIMITS;
    return FREE_LIMITS;
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
            message: `[LOCKED] Free plan limit: ${limits.maxMemories} memories. Upgrade to PRO for unlimited. Visit https://cortex-ai-iota.vercel.app/dashboard`,
        };
    }
    return { allowed: true, message: '' };
}

/** Get upgrade message for gated features */
export function getUpgradeMessage(feature: string): string {
    return `[LOCKED] "${feature}" is a PRO feature. Upgrade at https://cortex-ai-iota.vercel.app/dashboard or set CORTEX_LICENSE_KEY to unlock.`;
}

/** Format plan status for display */
export function formatPlanStatus(): string {
    const license = getLicense();
    const limits = getFeatureLimits();

    if (license.plan === 'PRO') {
        return `[PRO] Cortex PRO — All features unlocked, unlimited memories.`;
    }

    if (license.plan === 'TRIAL') {
        const trialMsg = getTrialStatus();
        return `[TRIAL] Cortex Trial — All PRO features active. ${trialMsg || ''}`;
    }

    return `[FREE] Cortex Free — ${limits.maxMemories} memories, basic features. Upgrade: https://cortex-ai-iota.vercel.app/dashboard`;
}
