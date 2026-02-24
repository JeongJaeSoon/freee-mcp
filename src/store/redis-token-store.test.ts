import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserTokenData } from './token-store.js';

const mockGet = vi.fn();
const mockSet = vi.fn();
const mockDel = vi.fn();
const mockExists = vi.fn();
const mockQuit = vi.fn();

vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    get: mockGet,
    set: mockSet,
    del: mockDel,
    exists: mockExists,
    quit: mockQuit,
  })),
}));

const { RedisTokenStore } = await import('./redis-token-store.js');

describe('RedisTokenStore', () => {
  let store: InstanceType<typeof RedisTokenStore>;

  const mockTokenData: UserTokenData = {
    apiKey: 'sk-abc123',
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    expiresAt: Date.now() + 3600000,
    companyId: '12345',
    createdAt: Date.now(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    store = new RedisTokenStore('redis://localhost:6379');
  });

  describe('save', () => {
    it('should store token data with TTL', async () => {
      mockSet.mockResolvedValue('OK');

      await store.save('sk-abc123', mockTokenData);

      expect(mockSet).toHaveBeenCalledWith(
        'freee-mcp:token:sk-abc123',
        JSON.stringify(mockTokenData),
        'EX',
        90 * 24 * 60 * 60,
      );
    });

    it('should use custom TTL when provided', async () => {
      mockSet.mockResolvedValue('OK');
      const customStore = new RedisTokenStore('redis://localhost:6379', 3600);

      await customStore.save('sk-abc123', mockTokenData);

      expect(mockSet).toHaveBeenCalledWith(
        'freee-mcp:token:sk-abc123',
        JSON.stringify(mockTokenData),
        'EX',
        3600,
      );
    });
  });

  describe('load', () => {
    it('should return parsed token data when key exists', async () => {
      mockGet.mockResolvedValue(JSON.stringify(mockTokenData));

      const result = await store.load('sk-abc123');

      expect(mockGet).toHaveBeenCalledWith('freee-mcp:token:sk-abc123');
      expect(result).toEqual(mockTokenData);
    });

    it('should return null when key does not exist', async () => {
      mockGet.mockResolvedValue(null);

      const result = await store.load('sk-nonexistent');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete the key from Redis', async () => {
      mockDel.mockResolvedValue(1);

      await store.delete('sk-abc123');

      expect(mockDel).toHaveBeenCalledWith('freee-mcp:token:sk-abc123');
    });
  });

  describe('exists', () => {
    it('should return true when key exists', async () => {
      mockExists.mockResolvedValue(1);

      const result = await store.exists('sk-abc123');

      expect(mockExists).toHaveBeenCalledWith('freee-mcp:token:sk-abc123');
      expect(result).toBe(true);
    });

    it('should return false when key does not exist', async () => {
      mockExists.mockResolvedValue(0);

      const result = await store.exists('sk-nonexistent');

      expect(result).toBe(false);
    });
  });

  describe('disconnect', () => {
    it('should call quit on Redis client', async () => {
      mockQuit.mockResolvedValue('OK');

      await store.disconnect();

      expect(mockQuit).toHaveBeenCalled();
    });
  });
});
