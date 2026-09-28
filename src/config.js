import crypto from 'node:crypto';
import path from 'node:path';

function required(name) {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith('replace_') || value.startsWith('your_')) {
    throw new Error(`${name} must be set. Copy .env.example to .env and provide a real value.`);
  }
  return value;
}

function encryptionKey() {
  const encoded = required('CONNECTION_ENCRYPTION_KEY');
  let key;
  try {
    key = Buffer.from(encoded, 'base64');
  } catch {
    throw new Error('CONNECTION_ENCRYPTION_KEY must be base64-encoded.');
  }
  if (key.length !== 32) {
    throw new Error('CONNECTION_ENCRYPTION_KEY must decode to exactly 32 bytes.');
  }
  return key;
}

export const config = {
  port: Number.parseInt(process.env.PORT || '3000', 10),
  githubClientId: required('GITHUB_CLIENT_ID'),
  encryptionKey: encryptionKey(),
  connectionStorePath: path.resolve(
    process.env.CONNECTION_STORE_PATH || path.join(process.cwd(), 'data', 'connections.json'),
  ),
  githubApiBaseUrl: 'https://api.github.com',
};

if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
  throw new Error('PORT must be a valid TCP port.');
}

export function encrypt(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', config.encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
}

export function decrypt(payload) {
  const [ivEncoded, tagEncoded, encryptedEncoded] = String(payload).split('.');
  if (!ivEncoded || !tagEncoded || !encryptedEncoded) {
    throw new Error('Stored connection credential has an invalid format.');
  }
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    config.encryptionKey,
    Buffer.from(ivEncoded, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedEncoded, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}
