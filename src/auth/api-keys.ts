import crypto from 'crypto';

const API_KEY_PREFIX = 'sk-';
const API_KEY_BYTES = 32;

export function generateApiKey(): string {
  const randomPart = crypto.randomBytes(API_KEY_BYTES).toString('hex');
  return `${API_KEY_PREFIX}${randomPart}`;
}

export function isValidApiKeyFormat(apiKey: string): boolean {
  return apiKey.startsWith(API_KEY_PREFIX) && apiKey.length === API_KEY_PREFIX.length + API_KEY_BYTES * 2;
}
