/**
 * At-rest encryption for small secrets stored in the database
 * (currently: email-transport credentials — server/lib/emailTransport.js).
 * ---------------------------------------------------------------------------
 * AES-256-GCM with a single process-wide key from the instance env:
 *
 *   APP_ENCRYPTION_KEY   32 bytes, as base64 (44 chars) or hex (64 chars).
 *                        Generate: node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 *
 * Ciphertext format (one self-describing string, safe in a text column):
 *
 *   gcm.v1.<base64( iv(12) || authTag(16) || ciphertext )>
 *
 * Rotating APP_ENCRYPTION_KEY invalidates every previously stored secret —
 * they must be re-entered. There is no key list / rewrap here yet.
 *
 * secretsReady() is false when the key is absent or malformed; callers use
 * it to fail a save with a clear message rather than storing plaintext.
 * ---------------------------------------------------------------------------
 */
const crypto = require("crypto");

const PREFIX = "gcm.v1.";
const IV_LEN = 12;
const TAG_LEN = 16;

class SecretsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SecretsError";
  }
}

// Parse APP_ENCRYPTION_KEY once. Invalid -> keyError is set, key stays null.
let key = null;
let keyError = null;
(function loadKey() {
  const raw = (process.env.APP_ENCRYPTION_KEY || "").trim();
  if (!raw) {
    keyError = "APP_ENCRYPTION_KEY is not set";
    return;
  }
  let buf = null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    buf = Buffer.from(raw, "hex");
  } else {
    try {
      const b = Buffer.from(raw, "base64");
      if (b.length === 32) buf = b;
    } catch {
      /* fall through */
    }
  }
  if (!buf || buf.length !== 32) {
    keyError = "APP_ENCRYPTION_KEY must be 32 bytes (base64 or hex)";
    return;
  }
  key = buf;
})();

/** True when a valid key is loaded and encrypt/decrypt will work. */
function secretsReady() {
  return key !== null;
}

/** Why secretsReady() is false (null when it's true). */
function secretsKeyError() {
  return keyError;
}

/** Encrypt a UTF-8 string. Returns the `gcm.v1.…` blob. */
function encryptSecret(plain) {
  if (!key) throw new SecretsError(keyError || "encryption key unavailable");
  if (typeof plain !== "string" || plain === "") {
    throw new SecretsError("encryptSecret expects a non-empty string");
  }
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

/** Decrypt a `gcm.v1.…` blob back to the original string. */
function decryptSecret(blob) {
  if (!key) throw new SecretsError(keyError || "encryption key unavailable");
  if (typeof blob !== "string" || !blob.startsWith(PREFIX)) {
    throw new SecretsError("not an encrypted secret");
  }
  let packed;
  try {
    packed = Buffer.from(blob.slice(PREFIX.length), "base64");
  } catch {
    throw new SecretsError("corrupt secret (bad base64)");
  }
  if (packed.length < IV_LEN + TAG_LEN + 1) {
    throw new SecretsError("corrupt secret (too short)");
  }
  const iv = packed.subarray(0, IV_LEN);
  const tag = packed.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = packed.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretsError("could not decrypt — wrong key or tampered data");
  }
}

/** True when `v` looks like one of our ciphertext blobs. */
function isEncrypted(v) {
  return typeof v === "string" && v.startsWith(PREFIX);
}

module.exports = {
  SecretsError,
  secretsReady,
  secretsKeyError,
  encryptSecret,
  decryptSecret,
  isEncrypted,
};
