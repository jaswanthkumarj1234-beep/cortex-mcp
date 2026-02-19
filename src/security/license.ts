/**
 * License validation — online-first, secure.
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
    expiresAt?: string;
    daysRemaining?: number;
}

const VERIFY_URL = 'https://cortex-ai-iota.vercel.app/api/auth/verify';
const CORTEX_DIR = path.join(os.homedir(), '.cortex');
const CACHE_FILE = path.join(CORTEX_DIR, 'license-cache.json');
const CACHE_HMAC_KEY = 'cortex-cache-integrity';
const CACHE_TTL_HOURS = 24;

let cachedLicense: LicenseInfo | null = null;

// ─── Public API ───────────────────────────────────────────────────────────────

export function getLicense(): LicenseInfo {
    if (cachedLicense) return cachedLicense;
    cachedLicense = detectLicense();
    return cachedLicense;
}

export function refreshLicense(): LicenseInfo {
    cachedLicense = null;
    return getLicense();
}

export function isPro(): boolean {
    const l = getLicense();
    return l.plan === 'PRO' || l.plan === 'TRIAL';
}

export function isFree(): boolean {
    return getLicense().plan === 'FREE';
}

export function isTrial(): boolean {
    return getLicense().plan === 'TRIAL';
}

export function getTrialStatus(): string | null {
    const l = getLicense();
    if (l.plan !== 'TRIAL') return null;
    if (l.daysRemaining === undefined) return null;
    if (l.daysRemaining <= 0) return 'Trial expired. Upgrade at https://cortex-ai-iota.vercel.app/dashboard';
    if (l.daysRemaining <= 2) return `Trial expires in ${l.daysRemaining}d. Upgrade: https://cortex-ai-iota.vercel.app/dashboard`;
    return `Trial: ${l.daysRemaining}d remaining`;
}

export function saveKey(key: string): void {
    ensureDir();
    fs.writeFileSync(path.join(CORTEX_DIR, 'license'), key.trim(), 'utf-8');
    clearCache();
    refreshLicense();
}

export function validateKeyFormat(key: string): boolean {
    if (!key) return false;
    return /^CORTEX-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(key.trim().toUpperCase());
}

// ─── Online Verification ──────────────────────────────────────────────────────

export async function verifyOnline(key: string): Promise<LicenseInfo> {
    return new Promise((resolve) => {
        try {
            const url = new URL(VERIFY_URL);
            const body = JSON.stringify({ licenseKey: key });

            const req = https.request({
                hostname: url.hostname,
                port: 443,
                path: url.pathname,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                },
                timeout: 8000,
            }, (res) => {
                let data = '';
                res.on('data', (c) => data += c);
                res.on('end', () => {
                    try {
                        const json = JSON.parse(data);
                        const result = parseServerResponse(json, key);
                        writeCache(result);
                        cachedLicense = result;
                        resolve(result);
                    } catch {
                        resolve(readCacheOrFree(key));
                    }
                });
            });

            req.on('error', () => resolve(readCacheOrFree(key)));
            req.on('timeout', () => { req.destroy(); resolve(readCacheOrFree(key)); });
            req.write(body);
            req.end();
        } catch {
            resolve(readCacheOrFree(key));
        }
    });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function detectLicense(): LicenseInfo {
    const key = readKeyFromDisk();

    // Try signed cache first (fast startup)
    const cached = readCache();
    if (cached && cached.key === key) return cached;

    // No key → FREE
    if (!key) {
        return { plan: 'FREE', key: null, valid: false, message: 'Free plan. Upgrade: https://cortex-ai-iota.vercel.app' };
    }

    // Key exists but no valid cache → FREE until server confirms
    if (!validateKeyFormat(key)) {
        return { plan: 'FREE', key, valid: false, message: 'Invalid license key format' };
    }

    // Start background verification — stay FREE until confirmed
    verifyOnline(key).catch(() => { });
    return {
        plan: 'FREE',
        key,
        valid: false,
        message: 'Verifying license...',
    };
}

function parseServerResponse(json: any, key: string): LicenseInfo {
    if (!json.valid) {
        return { plan: 'FREE', key, valid: false, message: json.error || 'License not valid' };
    }

    const plan: Plan = json.plan?.toUpperCase() === 'PRO' ? 'PRO' :
        json.plan?.toUpperCase() === 'TRIAL' ? 'TRIAL' : 'FREE';

    const result: LicenseInfo = { plan, key, valid: true, message: `${plan} license verified` };

    if (json.expiresAt) {
        result.expiresAt = json.expiresAt;
        result.daysRemaining = Math.max(0, Math.ceil((new Date(json.expiresAt).getTime() - Date.now()) / 86400000));
        if (plan === 'TRIAL' && result.daysRemaining <= 0) {
            result.plan = 'FREE';
            result.valid = false;
            result.message = 'Trial expired';
        }
    }

    return result;
}

function readKeyFromDisk(): string | null {
    const envKey = process.env.CORTEX_LICENSE_KEY?.trim();
    if (envKey) return envKey;

    try {
        const f = path.join(CORTEX_DIR, 'license');
        if (fs.existsSync(f)) return fs.readFileSync(f, 'utf-8').trim() || null;
    } catch { }
    return null;
}

// ─── Signed Cache ─────────────────────────────────────────────────────────────

function computeHmac(data: string): string {
    return crypto.createHmac('sha256', CACHE_HMAC_KEY).update(data).digest('hex');
}

function writeCache(info: LicenseInfo): void {
    try {
        ensureDir();
        const payload = JSON.stringify({ ...info, ts: Date.now() });
        const sig = computeHmac(payload);
        fs.writeFileSync(CACHE_FILE, JSON.stringify({ payload, sig }), 'utf-8');
    } catch { }
}

function readCache(): LicenseInfo | null {
    try {
        if (!fs.existsSync(CACHE_FILE)) return null;
        const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));

        // Verify HMAC signature — reject tampered caches
        if (!raw.payload || !raw.sig) return null;
        if (computeHmac(raw.payload) !== raw.sig) {
            clearCache();
            return null;
        }

        const data = JSON.parse(raw.payload);

        // Expire after TTL
        if ((Date.now() - data.ts) / 3600000 > CACHE_TTL_HOURS) return null;

        // Recalculate trial days
        if (data.expiresAt) {
            data.daysRemaining = Math.max(0, Math.ceil((new Date(data.expiresAt).getTime() - Date.now()) / 86400000));
            if (data.plan === 'TRIAL' && data.daysRemaining <= 0) {
                data.plan = 'FREE';
                data.valid = false;
                data.message = 'Trial expired';
            }
        }

        return data as LicenseInfo;
    } catch {
        return null;
    }
}

function readCacheOrFree(key: string): LicenseInfo {
    const c = readCache();
    if (c && c.key === key) return c;
    return { plan: 'FREE', key, valid: false, message: 'Offline — license pending verification' };
}

function clearCache(): void {
    try { if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE); } catch { }
}

function ensureDir(): void {
    if (!fs.existsSync(CORTEX_DIR)) fs.mkdirSync(CORTEX_DIR, { recursive: true });
}
