import type { TokenStore } from './token-store.js';
import { FileTokenStore } from './file-token-store.js';
import { RedisTokenStore } from './redis-token-store.js';

export type { TokenStore, UserTokenData } from './token-store.js';
export { FileTokenStore } from './file-token-store.js';
export { RedisTokenStore } from './redis-token-store.js';

export function createTokenStore(): TokenStore {
  const redisUrl = process.env.REDIS_URL;
  if (redisUrl) {
    return new RedisTokenStore(redisUrl);
  }
  return new FileTokenStore();
}
