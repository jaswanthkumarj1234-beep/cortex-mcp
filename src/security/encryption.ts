/**
 * Memory Encryption — AES-256-GCM encryption at rest for sensitive memory content.
 * 
 * Uses Node.js built-in crypto module (no external deps).
 * Encryption key derived from a machine-specific seed using PBKDF2.
 * 
 * When enabled:
 * - Memory `intent` and `action` fields are encrypted before storage
 * - Decrypted on read
 * - FTS index uses plaintext (searched in-memory) — only DB at rest is encrypted
 */
import * as crypto from 'crypto';
import * as os from 'os';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT = 'cortex-memory-salt-v1';

// Derive key from machine-specific info (hostname + username + homedir hash)
function deriveKey(): Buffer {
    const seed = `${os.hostname()}:${os.userInfo().username}:${os.homedir()}`;
    return crypto.pbkdf2Sync(seed, SALT, 100000, KEY_LENGTH, 'sha512');
}

let _key: Buffer | null = null;
function getKey(): Buffer {
    if (!_key) _key = deriveKey();
    return _key;
}

/**
 * Encrypt plaintext content.
 * Returns a base64 string: iv:tag:ciphertext
 */
export function encrypt(plaintext: string): string {
    if (!plaintext) return plaintext;

    const key = getKey();
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');
    const tag = cipher.getAuthTag();

    // Format: iv:tag:ciphertext (all base64)
    return `ENC:${iv.toString('base64')}:${tag.toString('base64')}:${encrypted}`;
}

/**
 * Decrypt encrypted content.
 * Expects format: ENC:iv:tag:ciphertext
 */
export function decrypt(encrypted: string): string {
    if (!encrypted || !encrypted.startsWith('ENC:')) return encrypted;

    try {
        const parts = encrypted.split(':');
        if (parts.length !== 4) return encrypted;

        const iv = Buffer.from(parts[1], 'base64');
        const tag = Buffer.from(parts[2], 'base64');
        const ciphertext = parts[3];

        const key = getKey();
        const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
        decipher.setAuthTag(tag);

        let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    } catch {
        // If decryption fails, return original (might be plaintext from before encryption was enabled)
        return encrypted;
    }
}

/**
 * Check if a string is encrypted
 */
export function isEncrypted(text: string): boolean {
    return text?.startsWith('ENC:') ?? false;
}
