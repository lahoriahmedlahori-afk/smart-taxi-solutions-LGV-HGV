import { createHash, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';

const PASSWORD_COST = 12;

export const hashPassword = password => bcrypt.hash(password, PASSWORD_COST);
export const verifyPassword = (password, passwordHash) => bcrypt.compare(password, passwordHash);
export const createOpaqueToken = () => randomBytes(32).toString('base64url');
export const hashToken = token => createHash('sha256').update(token).digest('hex');

function encryptionKey() {
  const key = Buffer.from(config.appEncryptionKey, 'base64');
  if (key.length !== 32) {
    throw new Error('APP_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
  }
  return key;
}

export function encryptSecret(value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64url')).join('.');
}

export function decryptSecret(value) {
  const [iv, authTag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64url'));
  if (!iv || !authTag || !ciphertext) throw new Error('Invalid encrypted setting');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
