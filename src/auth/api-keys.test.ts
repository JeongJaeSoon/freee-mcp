import { describe, it, expect } from 'vitest';
import { generateApiKey, isValidApiKeyFormat } from './api-keys.js';

describe('api-keys', () => {
  describe('generateApiKey', () => {
    it('should return a string starting with sk-', () => {
      const key = generateApiKey();

      expect(key.startsWith('sk-')).toBe(true);
    });

    it('should return a key with correct length (3 prefix + 64 hex = 67)', () => {
      const key = generateApiKey();

      expect(key.length).toBe(67);
    });

    it('should contain only hex characters after prefix', () => {
      const key = generateApiKey();
      const hexPart = key.slice(3);

      expect(hexPart).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should produce unique keys on each call', () => {
      const keys = new Set(Array.from({ length: 10 }, () => generateApiKey()));

      expect(keys.size).toBe(10);
    });
  });

  describe('isValidApiKeyFormat', () => {
    it('should return true for a valid API key', () => {
      const key = generateApiKey();

      expect(isValidApiKeyFormat(key)).toBe(true);
    });

    it('should return false for key with wrong prefix', () => {
      const key = 'pk-' + 'a'.repeat(64);

      expect(isValidApiKeyFormat(key)).toBe(false);
    });

    it('should return false for key with wrong length (too short)', () => {
      const key = 'sk-' + 'a'.repeat(32);

      expect(isValidApiKeyFormat(key)).toBe(false);
    });

    it('should return false for key with wrong length (too long)', () => {
      const key = 'sk-' + 'a'.repeat(128);

      expect(isValidApiKeyFormat(key)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isValidApiKeyFormat('')).toBe(false);
    });

    it('should return false for prefix only', () => {
      expect(isValidApiKeyFormat('sk-')).toBe(false);
    });
  });
});
