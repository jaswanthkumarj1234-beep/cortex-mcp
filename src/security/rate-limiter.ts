/**
 * Rate Limiter — Prevents unbounded memory storage per session.
 * 
 * Limits:
 * - Max 30 memories stored per session (resets on server restart)
 * - Max 100 auto_learn calls per session
 * - Max 500 total tool calls per session
 */

interface RateLimitState {
    storeCount: number;
    autoLearnCount: number;
    totalCalls: number;
    sessionStart: number;
}

const LIMITS = {
    MAX_STORES_PER_SESSION: 30,
    MAX_AUTO_LEARN_PER_SESSION: 100,
    MAX_CALLS_PER_SESSION: 500,
};

let state: RateLimitState = {
    storeCount: 0,
    autoLearnCount: 0,
    totalCalls: 0,
    sessionStart: Date.now(),
};

export function checkRateLimit(operation: 'store' | 'auto_learn' | 'call'): { allowed: boolean; reason?: string } {
    state.totalCalls++;

    if (state.totalCalls > LIMITS.MAX_CALLS_PER_SESSION) {
        return { allowed: false, reason: `Session limit reached (${LIMITS.MAX_CALLS_PER_SESSION} total calls). Restart server to reset.` };
    }

    if (operation === 'store') {
        state.storeCount++;
        if (state.storeCount > LIMITS.MAX_STORES_PER_SESSION) {
            return { allowed: false, reason: `Memory store limit reached (${LIMITS.MAX_STORES_PER_SESSION}/session). Prevents DB bloat.` };
        }
    }

    if (operation === 'auto_learn') {
        state.autoLearnCount++;
        if (state.autoLearnCount > LIMITS.MAX_AUTO_LEARN_PER_SESSION) {
            return { allowed: false, reason: `Auto-learn limit reached (${LIMITS.MAX_AUTO_LEARN_PER_SESSION}/session).` };
        }
    }

    return { allowed: true };
}

export function getRateLimitStats(): { storeCount: number; autoLearnCount: number; totalCalls: number; uptime: number } {
    return {
        storeCount: state.storeCount,
        autoLearnCount: state.autoLearnCount,
        totalCalls: state.totalCalls,
        uptime: Math.floor((Date.now() - state.sessionStart) / 1000),
    };
}

export function resetRateLimits(): void {
    state = {
        storeCount: 0,
        autoLearnCount: 0,
        totalCalls: 0,
        sessionStart: Date.now(),
    };
}
