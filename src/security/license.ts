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

const VERIFY_URL = 'https://cortex-website-theta.vercel.app/api/auth/verify';
const CORTEX_DIR = path.join(os.homedir(), '.cortex');
const CACHE_FILE = path.join(CORTEX_DIR, 'license-cache.json');
const KEY_FILE = path.join(CORTEX_DIR, '.cache-key');
const CACHE_TTL_HOURS = 24;
const MAX_RESPONSE_BYTES = 4096;

let cachedLicense: LicenseInfo | null = null;
let _initPromise: Promise<LicenseInfo> | null = null;

// ─── HMAC Key — Per-Machine Random Secret ─────────────────────────────────────
// A 32-byte cryptographically random key is generated ONCE and persisted
// to ~/.cortex/.cache-key (mode 0600). If the file is missing or unreadable,
// a NEW random key is generated each time (cache simply won't persist across
// restarts until the filesystem issue is resolved — this is intentionally
// secure-by-default: no predictable fallback exists).

let _hmacKey: string | null = null;

function getCacheHmacKey(): string {
    if (_hmacKey) return _hmacKey;

    try {
        ensureDir();

        // Try to read existing key
        if (fs.existsSync(KEY_FILE)) {
            const existing = fs.readFileSync(KEY_FILE, 'utf-8').trim();
            if (existing.length >= 64) {
                _hmacKey = existing;
                return _hmacKey;
            }
        }

        // No valid key on disk — generate and persist a new one
        const fresh = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(KEY_FILE, fresh, { encoding: 'utf-8', mode: 0o600 });
        _hmacKey = fresh;
        return _hmacKey;
    } catch {
        // Filesystem failure — use an ephemeral random key for this session.
        // Cache won't persist across restarts, but integrity is never compromised.
        _hmacKey = crypto.randomBytes(32).toString('hex');
        return _hmacKey;
    }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Synchronous license accessor. Returns the cached license state.
 *
 * On the very first call (cold start with no disk cache), this returns
 * the HMAC-signed cached result if available. If no cache exists, it
 * starts background verification and returns a "verifying" state.
 *
 * For guaranteed accurate results at startup, call `waitForVerification()`
 * first — it blocks until the server responds (with a configurable timeout).
 */
export function getLicense(): LicenseInfo {
    if (cachedLicense) return cachedLicense;
    cachedLicense = detectLicense();
    return cachedLicense;
}

/**
 * Async startup helper — waits for online verification to finish.
 * Call this ONCE at startup, then use getLicense() synchronously afterwards.
 *
 * After this resolves, `getLicense()` will return the server-verified plan
 * (PRO, TRIAL, or FREE) rather than the cold-start "verifying" state.
 */
export async function waitForVerification(timeoutMs: number = 5000): Promise<LicenseInfo> {
    // Ensure detectLicense runs first (sets up _initPromise if needed)
    getLicense();

    if (_initPromise) {
        try {
            const result = await Promise.race([
                _initPromise,
                new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
            ]);
            if (result) {
                cachedLicense = result;
                return result;
            }
        } catch { /* timeout or network failure — fall through */ }
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
    if (l.daysRemaining <= 0) return 'Trial expired. Upgrade at https://cortex-website-theta.vercel.app/dashboard';
    if (l.daysRemaining <= 2) return `Trial expires in ${l.daysRemaining}d. Upgrade: https://cortex-website-theta.vercel.app/dashboard`;
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
        let settled = false;

        function settle(value: LicenseInfo): void {
            if (settled) return;
            settled = true;
            resolve(value);
        }

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
                let totalBytes = 0;
                const chunks: Buffer[] = [];

                res.on('data', (chunk: Buffer) => {
                    // Enforce response size limit BEFORE accumulating
                    const incoming = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
                    if (totalBytes + incoming > MAX_RESPONSE_BYTES) {
                        res.destroy();
                        settle(readCacheOrFree(key));
                        return;
                    }
                    totalBytes += incoming;
                    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
                });

                res.on('end', () => {
                    try {
                        const data = Buffer.concat(chunks, totalBytes).toString('utf-8');
                        const json = JSON.parse(data);
                        const result = parseServerResponse(json, key);
                        writeCache(result);
                        cachedLicense = result;
                        settle(result);
                    } catch {
                        settle(readCacheOrFree(key));
                    }
                });

                res.on('error', () => settle(readCacheOrFree(key)));
            });

            req.on('error', () => settle(readCacheOrFree(key)));
            req.on('timeout', () => { req.destroy(); settle(readCacheOrFree(key)); });
            req.write(body);
            req.end();
        } catch {
            settle(readCacheOrFree(key));
        }
    });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function detectLicense(): LicenseInfo {
    const key = readKeyFromDisk();

    // Fast path: HMAC-verified cache is present and matches the current key.
    // This returns the real plan (PRO/TRIAL/FREE) from the last server response.
    const cached = readCache();
    if (cached && cached.key === key) return cached;

    if (!key) {
        return { plan: 'FREE', key: null, valid: false, message: 'Free plan. Upgrade: https://cortex-website-theta.vercel.app' };
    }

    if (!validateKeyFormat(key)) {
        return { plan: 'FREE', key, valid: false, message: 'Invalid license key format' };
    }

    // No valid cache — fire async verification, store promise for waitForVerification()
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
