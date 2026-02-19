/**
 * License System — Gates features behind free/paid plans.
 *
 * Key format: CORTEX-XXXX-XXXX-XXXX-XXXX (20 chars + dashes)
 * Keys are validated with a simple hash check (offline-first).
 *
 * Environment: CORTEX_LICENSE_KEY or ~/.cortex/license file
 *
 * Plans:
 *   FREE:  20 memories, basic recall, no brain layers
 *   PRO:   Unlimited memories, all 14 brain layers, all features
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

export type Plan = 'FREE' | 'PRO';

export interface LicenseInfo {
    plan: Plan;
    key: string | null;
    valid: boolean;
    message: string;
}

// Secret salt for key validation (change this before publishing)
const KEY_SALT = 'cortex-mcp-2024-salt';

let cachedLicense: LicenseInfo | null = null;

/** Get current license status (cached after first check) */
export function getLicense(): LicenseInfo {
    if (cachedLicense) return cachedLicense;
    cachedLicense = detectLicense();
    return cachedLicense;
}

/** Force re-check license (after user enters a new key) */
export function refreshLicense(): LicenseInfo {
    cachedLicense = null;
    return getLicense();
}

/** Check if current plan is PRO */
export function isPro(): boolean {
    return getLicense().plan === 'PRO';
}

/** Check if current plan is FREE */
export function isFree(): boolean {
    return getLicense().plan === 'FREE';
}

/** Generate a valid license key (for your use when selling) */
export function generateKey(email: string): string {
    const raw = crypto.createHash('sha256')
        .update(KEY_SALT + ':' + email.toLowerCase().trim())
        .digest('hex')
        .slice(0, 20)
        .toUpperCase();

    // Format: CORTEX-XXXX-XXXX-XXXX-XXXX
    return `CORTEX-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

/** Validate a license key format and checksum */
export function validateKey(key: string): boolean {
    if (!key) return false;

    // Must match format: CORTEX-XXXX-XXXX-XXXX-XXXX
    const pattern = /^CORTEX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/;
    if (!pattern.test(key.trim().toUpperCase())) return false;

    // Extract the raw part (remove CORTEX- and dashes)
    const raw = key.replace(/^CORTEX-/, '').replace(/-/g, '');

    // Validate checksum: last 4 chars must be hash of first 12
    const payload = raw.slice(0, 12);
    const checksum = raw.slice(12, 16);
    const expected = crypto.createHash('md5')
        .update(KEY_SALT + ':' + payload)
        .digest('hex')
        .slice(0, 4)
        .toUpperCase();

    return checksum === expected;
}

/** Generate a key with valid checksum (for selling) */
export function generateValidKey(identifier: string): string {
    // Generate 12 random chars as payload
    const payload = crypto.createHash('sha256')
        .update(KEY_SALT + ':key:' + identifier + ':' + Date.now())
        .digest('hex')
        .slice(0, 12)
        .toUpperCase();

    // Generate checksum from payload
    const checksum = crypto.createHash('md5')
        .update(KEY_SALT + ':' + payload)
        .digest('hex')
        .slice(0, 4)
        .toUpperCase();

    const raw = payload + checksum;
    return `CORTEX-${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

/** Save a license key to disk */
export function saveKey(key: string): void {
    const dir = path.join(os.homedir(), '.cortex');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'license'), key.trim(), 'utf-8');
    refreshLicense();
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function detectLicense(): LicenseInfo {
    // Priority 1: Environment variable
    const envKey = process.env.CORTEX_LICENSE_KEY?.trim();
    if (envKey) {
        if (validateKey(envKey)) {
            return { plan: 'PRO', key: envKey, valid: true, message: '[OK] PRO license active (from env)' };
        }
        return { plan: 'FREE', key: envKey, valid: false, message: '[FAIL] Invalid license key in CORTEX_LICENSE_KEY' };
    }

    // Priority 2: License file at ~/.cortex/license
    try {
        const licFile = path.join(os.homedir(), '.cortex', 'license');
        if (fs.existsSync(licFile)) {
            const fileKey = fs.readFileSync(licFile, 'utf-8').trim();
            if (validateKey(fileKey)) {
                return { plan: 'PRO', key: fileKey, valid: true, message: '[OK] PRO license active (from ~/.cortex/license)' };
            }
            return { plan: 'FREE', key: fileKey, valid: false, message: '[FAIL] Invalid license key in ~/.cortex/license' };
        }
    } catch { }

    // No key found → FREE plan
    return {
        plan: 'FREE',
        key: null,
        valid: false,
        message: 'Free plan (20 memories). Upgrade: cortex-mcp.org',
    };
}
