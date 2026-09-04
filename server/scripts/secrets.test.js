/**
 * Unit tests for server/lib/secrets.js — AES-256-GCM secret box.
 *
 *   npm run secrets:test        (from server/)
 *   node --test scripts/secrets.test.js
 *
 * The key is set here before the module loads (it reads the env once at
 * require time), so this file must not be bundled with tests that expect a
 * different key.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

process.env.APP_ENCRYPTION_KEY = crypto.randomBytes(32).toString("base64");
const { encryptSecret, decryptSecret, secretsReady, isEncrypted, SecretsError } = require("../lib/secrets");

test("round-trips a secret", () => {
  assert.equal(secretsReady(), true);
  const plain = "s3cr3t-value·with-ünicode";
  const blob = encryptSecret(plain);
  assert.match(blob, /^gcm\.v1\./);
  assert.equal(isEncrypted(blob), true);
  assert.equal(decryptSecret(blob), plain);
});

test("two encryptions of the same value differ (random IV)", () => {
  assert.notEqual(encryptSecret("same"), encryptSecret("same"));
});

test("rejects empty / non-string input", () => {
  assert.throws(() => encryptSecret(""), SecretsError);
  assert.throws(() => encryptSecret(null), SecretsError);
});

test("tampered ciphertext fails the auth tag", () => {
  const blob = encryptSecret("do-not-tamper");
  const raw = Buffer.from(blob.slice("gcm.v1.".length), "base64");
  raw[raw.length - 1] ^= 0x01;
  const tampered = "gcm.v1." + raw.toString("base64");
  assert.throws(() => decryptSecret(tampered), SecretsError);
});

test("a different key cannot decrypt", () => {
  const blob = encryptSecret("locked");
  const key2 = crypto.randomBytes(32);
  const raw = Buffer.from(blob.slice("gcm.v1.".length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", key2, iv);
  d.setAuthTag(tag);
  assert.throws(() => Buffer.concat([d.update(ct), d.final()]));
});

test("decryptSecret rejects non-blobs", () => {
  assert.throws(() => decryptSecret("plaintext"), SecretsError);
  assert.throws(() => decryptSecret("gcm.v1.!!notbase64!!"), SecretsError);
});
