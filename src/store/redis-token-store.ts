import { Redis } from 'ioredis';
import type { TokenStore, UserTokenData } from './token-store.js';

const KEY_PREFIX = 'freee-mcp:token:';
const DEFAULT_TTL_SECONDS = 90 * 24 * 60 * 60; // 90 days

export class RedisTokenStore implements TokenStore {
  private readonly redis: Redis;
  private readonly ttl: number;

  constructor(redisUrl: string, ttl: number = DEFAULT_TTL_SECONDS) {
    this.redis = new Redis(redisUrl);
    this.ttl = ttl;
  }

  private key(apiKey: string): string {
    return `${KEY_PREFIX}${apiKey}`;
  }

  async save(apiKey: string, data: UserTokenData): Promise<void> {
    await this.redis.set(this.key(apiKey), JSON.stringify(data), 'EX', this.ttl);
  }

  async load(apiKey: string): Promise<UserTokenData | null> {
    const raw = await this.redis.get(this.key(apiKey));
    if (!raw) {
      return null;
    }
    return JSON.parse(raw) as UserTokenData;
  }

  async delete(apiKey: string): Promise<void> {
    await this.redis.del(this.key(apiKey));
  }

  async exists(apiKey: string): Promise<boolean> {
    const result = await this.redis.exists(this.key(apiKey));
    return result === 1;
  }

  async disconnect(): Promise<void> {
    await this.redis.quit();
  }
}
