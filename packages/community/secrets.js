import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const newId = () => `urn:uuid:${randomUUID()}`;
export const uuidPart = id => id.slice('urn:uuid:'.length);
export const sha256 = value => createHash('sha256').update(value).digest('hex');

/** Constant-time comparison of two lowercase hex digests. */
export function sameDigest(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
/** Single-use claim code carried in the claim URL, ~78 bits of entropy (16 chars). */
export function claimCode() {
  const chars = [];
  while (chars.length < 16) {
    for (const byte of randomBytes(32)) {
      // Rejection sampling keeps every character equally likely.
      if (byte < 240 && chars.length < 16) chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]);
    }
  }
  return chars.join('').match(/.{4}/gu).join('-');
}
export const normalizeCode = code => typeof code === 'string' ? code.trim().toUpperCase().replace(/[^A-Z0-9]/gu, '') : '';

/** Bearer secret whose prefix names the record that stores its hash. */
export function issueCredential(prefix, recordId) {
  const secret = randomBytes(32).toString('base64url');
  return { token: `${prefix}_${uuidPart(recordId)}_${secret}`, hash: sha256(secret) };
}
export function parseCredential(prefix, token) {
  const match = typeof token === 'string' && token.match(new RegExp(`^${prefix}_([0-9a-f-]{36})_([A-Za-z0-9_-]{43})$`, 'u'));
  return match ? { recordId: `urn:uuid:${match[1]}`, secretHash: sha256(match[2]) } : null;
}
export const bearer = header => typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : null;
