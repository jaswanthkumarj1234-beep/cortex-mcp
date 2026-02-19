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
const KEY_FILE = path.join(CORTEX_DIR, '.cache-key');
const CACHE_TTL_HOURS = 24;
const MAX_RESPONSE_BYTES = 4096;

let cachedLicense: LicenseInfo | null = null;
let _initPromise: Promise<LicenseInfo> | null = null;

// ─── HMAC Key Management ──────────────────────────────────────────────────────
// The HMAC key is a per-machine random secret stored on disk.
// This ensures the cache file cannot be forged or copied between machines.

function getOrCreateHmacKey(): string {
    try {
        ensureDir();
        if (fs.existsSync(KEY_FILE)) {
            const existing = fs.readFileSync(KEY_FILE, 'utf-8').trim();
            if (existing.length >= 64) return existing;
        }
        // Generate a cryptographically random key and persist it
        const newKey = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(KEY_FILE, newKey, { encoding: 'utf-8', mode: 0o600 });
        return newKey;
    } catch {
        // If filesystem fails, derive from machine identity as last resort
        return crypto.createHash('sha256')
            .update(`${os.hostname()}:${os.userInfo().username}:${process.pid}`)
            .digest('hex');
    }
}

// Lazily loaded and cached in memory so we only read disk once
let _hmacKey: string | null = null;
function getCacheHmacKey(): string {
    if (!_hmacKey) _hmacKey = getOrCreateHmacKey();
    return _hmacKey;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Get the current license. On first call without cache, this returns FREE
 * and triggers background verification. Use waitForVerification() at startup
 * to block until the real plan is known.
 */
export function getLicense(): LicenseInfo {
    if (cachedLicense) return cachedLicense;
    cachedLicense = detectLicense();
    return cachedLicense;
}

/**
 * Wait for the initial online verification to complete (with timeout).
 * Call this once at startup so subsequent getLicense() calls return the real plan.
 * If the verification completes before the timeout, the license is updated immediately.
 * If it times out, falls back to whatever detectLicense returned (cache or FREE).
 */
export async function waitForVerification(timeoutMs: number = 5000): Promise<LicenseInfo> {
    // Ensure detectLicense has been called (which sets up _initPromise)
    getLicense();

    if (_initPromise) {
        try {
            const result = await Promise.race([
                _initPromise,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
            ]);
            if (result) {
                cachedLicense = result;
                return result;
            }
        } catch { /* verification failed, fall through */ }
    }
    return getLicense();
}

export function refreshLicense(): LicenseInfo {
    cachedLicense = null;
    _initPromise = null;
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
        let resolved = false;
        const safeResolve = (value: LicenseInfo) => {
            if (resolved) return;
            resolved = true;
            resolve(value);
        };

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
                const chunks: Buffer[] = [];
                let totalBytes = 0;

                res.on('data', (chunk: Buffer) => {
                    totalBytes += chunk.length;
                    if (totalBytes > MAX_RESPONSE_BYTES) {
                        req.destroy();
                        safeResolve(readCacheOrFree(key));
                        return;
                    }
                    chunks.push(chunk);
                });

                res.on('end', () => {
                    try {
                        const data = Buffer.concat(chunks).toString('utf-8');
                        const json = JSON.parse(data);
                        const result = parseServerResponse(json, key);
                        writeCache(result);
                        cachedLicense = result;
                        safeResolve(result);
                    } catch {
                        safeResolve(readCacheOrFree(key));
                    }
                });

                res.on('error', () => safeResolve(readCacheOrFree(key)));
            });

            req.on('error', () => safeResolve(readCacheOrFree(key)));
            req.on('timeout', () => { req.destroy(); safeResolve(readCacheOrFree(key)); });
            req.write(body);
            req.end();
        } catch {
            safeResolve(readCacheOrFree(key));
        }
    });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function detectLicense(): LicenseInfo {
    const key = readKeyFromDisk();

    // Fast path: HMAC-signed cache matches current key — returns real plan
    const cached = readCache();
    if (cached && cached.key === key) return cached;

    if (!key) {
        return { plan: 'FREE', key: null, valid: false, message: 'Free plan. Upgrade: https://cortex-ai-iota.vercel.app' };
    }

    if (!validateKeyFormat(key)) {
        return { plan: 'FREE', key, valid: false, message: 'Invalid license key format' };
    }

    // No valid cache — start async verification and return FREE until it completes.
    // Callers should use waitForVerification() at startup to get the real plan.
    _initPromise = verifyOnline(key);
    _initPromise.catch(() => { });

    return {
        plan: 'FREE',
        key,
        valid: false,
        message: 'Verifying license...',
    };
}

function parseServerResponse(json: any, key: string): LicenseInfo {
    if (!json || typeof json !== 'object') {
        return { plan: 'FREE', key, valid: false, message: 'Invalid server response' };
    }

    if (!json.valid) {
        const errMsg = typeof json.error === 'string' ? json.error.slice(0, 200) : 'License not valid';
        return { plan: 'FREE', key, valid: false, message: errMsg };
    }

    const rawPlan = typeof json.plan === 'string' ? json.plan.toUpperCase() : '';
    const plan: Plan = rawPlan === 'PRO' ? 'PRO' : rawPlan === 'TRIAL' ? 'TRIAL' : 'FREE';

    const result: LicenseInfo = { plan, key, valid: true, message: `${plan} license verified` };

    if (typeof json.expiresAt === 'string') {
        result.expiresAt = json.expiresAt.slice(0, 30);
        const expiryMs = new Date(json.expiresAt).getTime();
        if (!isNaN(expiryMs)) {
            result.daysRemaining = Math.max(0, Math.ceil((expiryMs - Date.now()) / 86400000));
            if (plan === 'TRIAL' && result.daysRemaining <= 0) {
                result.plan = 'FREE';
                result.valid = false;
                result.message = 'Trial expired';
            }
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
    return crypto.createHmac('sha256', getCacheHmacKey()).update(data).digest('hex');
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

        if (!raw.payload || !raw.sig) return null;
        if (computeHmac(raw.payload) !== raw.sig) {
            clearCache();
            return null;
        }

        const data = JSON.parse(raw.payload);

        if ((Date.now() - data.ts) / 3600000 > CACHE_TTL_HOURS) return null;

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
