/**
 * License System — Gates features behind free/trial/paid plans.
 *
 * Key format: CORTEX-XXXX-XXXX-XXXX-XXXX (20 chars + dashes)
 * Keys are validated offline first, then verified online against
 * the Cortex AI API (https://cortex-ai-iota.vercel.app/api/auth/verify).
 *
 * Environment: CORTEX_LICENSE_KEY or ~/.cortex/license file
 *
 * Plans:
 *   FREE:   20 memories, basic recall, no brain layers
 *   TRIAL:  Full PRO features for 7 days (auto-granted on sign-up)
 *   PRO:    Unlimited memories, all 14 brain layers, all features
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as https from 'https';

export type Plan = 'FREE' | 'TRIAL' | 'PRO';

export interface LicenseInfo {
    plan: Plan;
    key: string | null;
    valid: boolean;
    message: string;
    expiresAt?: string;      // ISO date string for trial expiry
    daysRemaining?: number;  // Days left in trial
}

// Secret salt for key validation (change this before publishing)
const KEY_SALT = 'cortex-mcp-2024-salt';
const VERIFY_URL = 'https://cortex-ai-iota.vercel.app/api/auth/verify';
const CACHE_FILE = path.join(os.homedir(), '.cortex', 'license-cache.json');

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

/** Check if current plan is PRO (or active trial) */
export function isPro(): boolean {
    const license = getLicense();
    return license.plan === 'PRO' || license.plan === 'TRIAL';
}

/** Check if current plan is FREE */
export function isFree(): boolean {
    return getLicense().plan === 'FREE';
}

/** Check if user is on trial */
export function isTrial(): boolean {
    return getLicense().plan === 'TRIAL';
}

/** Get trial status message */
export function getTrialStatus(): string | null {
    const license = getLicense();
    if (license.plan !== 'TRIAL') return null;

    if (license.daysRemaining !== undefined) {
        if (license.daysRemaining <= 0) {
            return '⚠️  Trial expired! Upgrade at https://cortex-ai-iota.vercel.app/dashboard';
        }
        if (license.daysRemaining <= 2) {
            return `🔴 Trial expires in ${license.daysRemaining} day${license.daysRemaining === 1 ? '' : 's'}! Upgrade: https://cortex-ai-iota.vercel.app/dashboard`;
        }
        return `⏳ Trial: ${license.daysRemaining} day${license.daysRemaining === 1 ? '' : 's'} remaining`;
    }
    return '⏳ Trial active';
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

/**
 * Verify license key online against the Cortex AI server.
 * Called asynchronously — results are cached to ~/.cortex/license-cache.json
 * so the server starts fast and validates in the background.
 */
export async function verifyOnline(key: string): Promise<LicenseInfo> {
    return new Promise((resolve) => {
        try {
            const url = new URL(VERIFY_URL);
            const postData = JSON.stringify({ licenseKey: key });

            const req = https.request({
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(postData),
                },
                timeout: 5000,
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => data += chunk);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const result = parseOnlineResponse(json, key);
                        saveLicenseCache(result);
                        cachedLicense = result;
                        resolve(result);
                    } catch {
                        resolve(fallbackFromCache(key));
                    }
                });
            });

            req.on('error', () => resolve(fallbackFromCache(key)));
            req.on('timeout', () => { req.destroy(); resolve(fallbackFromCache(key)); });
            req.write(postData);
            req.end();
        } catch {
            resolve(fallbackFromCache(key));
        }
    });
}

/** Parse the API response into a LicenseInfo */
function parseOnlineResponse(json: any, key: string): LicenseInfo {
    if (!json.valid) {
        return {
            plan: 'FREE',
            key,
            valid: false,
            message: json.error || 'License not valid on server',
        };
    }

    const plan: Plan = json.plan?.toUpperCase() === 'PRO' ? 'PRO' :
        json.plan?.toUpperCase() === 'TRIAL' ? 'TRIAL' : 'FREE';

    const result: LicenseInfo = {
        plan,
        key,
        valid: true,
        message: `[OK] ${plan} license verified online`,
    };

    if (json.expiresAt) {
        result.expiresAt = json.expiresAt;
        const now = new Date();
        const expires = new Date(json.expiresAt);
        result.daysRemaining = Math.max(0, Math.ceil((expires.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)));

        if (plan === 'TRIAL' && result.daysRemaining <= 0) {
            result.plan = 'FREE';
            result.valid = false;
            result.message = 'Trial expired — upgrade to PRO at https://cortex-ai-iota.vercel.app/dashboard';
        }
    }

    return result;
}

/** Save license response to cache for offline use */
function saveLicenseCache(info: LicenseInfo): void {
    try {
        const dir = path.join(os.homedir(), '.cortex');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CACHE_FILE, JSON.stringify({
            ...info,
            cachedAt: new Date().toISOString(),
        }), 'utf-8');
    } catch { /* ignore */ }
}

/** Load cached license response (for offline startup) */
function loadLicenseCache(): LicenseInfo | null {
    try {
        if (!fs.existsSync(CACHE_FILE)) return null;
        const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));

        // Cache expires after 24 hours — force re-verify
        const cachedAt = new Date(data.cachedAt);
        const hoursSinceCached = (Date.now() - cachedAt.getTime()) / (1000 * 60 * 60);
        if (hoursSinceCached > 24) return null;

        // Recalculate days remaining for trial
        if (data.expiresAt) {
            const expires = new Date(data.expiresAt);
            data.daysRemaining = Math.max(0, Math.ceil((expires.getTime() - Date.now()) / (1000 * 60 * 60 * 24)));
            if (data.plan === 'TRIAL' && data.daysRemaining <= 0) {
                data.plan = 'FREE';
                data.valid = false;
                data.message = 'Trial expired — upgrade to PRO';
            }
        }

        return data as LicenseInfo;
    } catch {
        return null;
    }
}

/** Fallback: use cache if online verification fails */
function fallbackFromCache(key: string): LicenseInfo {
    const cached = loadLicenseCache();
    if (cached && cached.key === key) return cached;

    // No cache, key passes format check → assume valid (offline-first)
    if (validateKey(key)) {
        return { plan: 'PRO', key, valid: true, message: '[OK] PRO license (offline validation)' };
    }
    return { plan: 'FREE', key, valid: false, message: 'Invalid license key' };
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function detectLicense(): LicenseInfo {
    // Priority 0: Check cached online verification
    const cached = loadLicenseCache();
    if (cached) return cached;

    // Priority 1: Environment variable
    const envKey = process.env.CORTEX_LICENSE_KEY?.trim();
    if (envKey) {
        if (validateKey(envKey)) {
            // Schedule async online verification (will update cache)
            verifyOnline(envKey).catch(() => { });
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
                // Schedule async online verification
                verifyOnline(fileKey).catch(() => { });
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
        message: 'Free plan (20 memories). Upgrade: https://cortex-ai-iota.vercel.app',
    };
}
