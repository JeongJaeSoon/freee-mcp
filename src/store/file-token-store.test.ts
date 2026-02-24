import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs/promises';
import type { UserTokenData } from './token-store.js';

vi.mock('fs/promises');
vi.mock('../constants.js', () => ({
  getConfigDir: () => '/mock/config',
  CONFIG_FILE_PERMISSION: 0o600,
}));

const mockFs = vi.mocked(fs);

// Dynamic import so mocks are applied before module loads
const { FileTokenStore } = await import('./file-token-store.js');

describe('FileTokenStore', () => {
  let store: InstanceType<typeof FileTokenStore>;

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
    store = new FileTokenStore();
  });

  describe('save', () => {
    it('should read existing file, merge new entry, and write back', async () => {
      const existingData = { 'sk-existing': { apiKey: 'sk-existing', accessToken: 'old' } };
      mockFs.readFile.mockResolvedValue(JSON.stringify(existingData));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await store.save('sk-abc123', mockTokenData);

      expect(mockFs.readFile).toHaveBeenCalledWith('/mock/config/user-tokens.json', 'utf8');
      expect(mockFs.mkdir).toHaveBeenCalledWith('/mock/config', { recursive: true });
      expect(mockFs.writeFile).toHaveBeenCalledWith(
        '/mock/config/user-tokens.json',
        expect.any(String),
        { mode: 0o600 },
      );

      const writtenData = JSON.parse(
        (mockFs.writeFile.mock.calls[0] as [string, string, object])[1],
      );
      expect(writtenData['sk-existing']).toBeDefined();
      expect(writtenData['sk-abc123']).toEqual(mockTokenData);
    });

    it('should create new file when ENOENT', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(error);
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await store.save('sk-abc123', mockTokenData);

      const writtenData = JSON.parse(
        (mockFs.writeFile.mock.calls[0] as [string, string, object])[1],
      );
      expect(writtenData['sk-abc123']).toEqual(mockTokenData);
    });
  });

  describe('load', () => {
    it('should return token data when key exists', async () => {
      const fileData = { 'sk-abc123': mockTokenData };
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileData));

      const result = await store.load('sk-abc123');

      expect(result).toEqual(mockTokenData);
    });

    it('should return null when key does not exist', async () => {
      const fileData = { 'sk-other': mockTokenData };
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileData));

      const result = await store.load('sk-nonexistent');

      expect(result).toBeNull();
    });

    it('should return null when file does not exist (ENOENT)', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(error);

      const result = await store.load('sk-abc123');

      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should remove the key and write back', async () => {
      const fileData = { 'sk-abc123': mockTokenData, 'sk-other': mockTokenData };
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileData));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await store.delete('sk-abc123');

      const writtenData = JSON.parse(
        (mockFs.writeFile.mock.calls[0] as [string, string, object])[1],
      );
      expect(writtenData['sk-abc123']).toBeUndefined();
      expect(writtenData['sk-other']).toBeDefined();
    });

    it('should handle deleting non-existent key gracefully', async () => {
      const fileData = { 'sk-other': mockTokenData };
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileData));
      mockFs.mkdir.mockResolvedValue(undefined);
      mockFs.writeFile.mockResolvedValue(undefined);

      await store.delete('sk-nonexistent');

      const writtenData = JSON.parse(
        (mockFs.writeFile.mock.calls[0] as [string, string, object])[1],
      );
      expect(writtenData['sk-other']).toBeDefined();
    });
  });

  describe('exists', () => {
    it('should return true when key exists', async () => {
      const fileData = { 'sk-abc123': mockTokenData };
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileData));

      const result = await store.exists('sk-abc123');

      expect(result).toBe(true);
    });

    it('should return false when key does not exist', async () => {
      const fileData = { 'sk-other': mockTokenData };
      mockFs.readFile.mockResolvedValue(JSON.stringify(fileData));

      const result = await store.exists('sk-nonexistent');

      expect(result).toBe(false);
    });

    it('should return false when file does not exist (ENOENT)', async () => {
      const error = new Error('File not found') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      mockFs.readFile.mockRejectedValue(error);

      const result = await store.exists('sk-abc123');

      expect(result).toBe(false);
    });
  });
});
