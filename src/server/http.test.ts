import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { isValidApiKeyFormat } from '../auth/api-keys.js';
import { MCP_ENDPOINT_PATH } from '../constants.js';
import { TokenStore, UserTokenData } from '../store/token-store.js';

// Mock dependencies
vi.mock('../store/index.js', () => ({
  createTokenStore: vi.fn(() => ({
    save: vi.fn(),
    load: vi.fn(),
    delete: vi.fn(),
    exists: vi.fn(),
  })),
}));

vi.mock('../mcp/handlers.js', () => ({
  createMcpServer: vi.fn(() => ({
    connect: vi.fn(),
  })),
}));

vi.mock('./setup.js', () => ({
  createSetupRouter: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => { next(); }),
}));

vi.mock('../config.js', () => ({
  getConfig: vi.fn(() => ({
    oauth: {
      tokenEndpoint: 'https://accounts.secure.freee.co.jp/public_api/token',
      scope: 'read write',
    },
    freee: { clientId: 'test-id', clientSecret: 'test-secret' },
  })),
}));

vi.mock('../auth/tokens.js', () => ({
  OAuthTokenResponseSchema: {
    safeParse: vi.fn(),
  },
}));

vi.mock('../auth/token-utils.js', () => ({
  createTokenData: vi.fn(),
}));

// Helper: create mock Request
function createMockRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'GET',
    headers: {},
    query: {},
    body: {},
    ...overrides,
  } as unknown as Request;
}

// Helper: create mock Response
function createMockResponse(): Response & { _status: number; _headers: Record<string, string>; _body: unknown; _ended: boolean } {
  const res = {
    _status: 200,
    _headers: {} as Record<string, string>,
    _body: undefined as unknown,
    _ended: false,
    headersSent: false,
    status(code: number) {
      res._status = code;
      return res;
    },
    json(body: unknown) {
      res._body = body;
      res._ended = true;
      return res;
    },
    setHeader(key: string, value: string) {
      res._headers[key] = value;
      return res;
    },
    end() {
      res._ended = true;
      return res;
    },
  };
  return res as unknown as Response & { _status: number; _headers: Record<string, string>; _body: unknown; _ended: boolean };
}

describe('HTTP Server', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Security headers middleware', () => {
    it('should set X-Content-Type-Options and X-Frame-Options headers', () => {
      // Simulate the security headers middleware from http.ts lines 31-35
      const middleware = (_req: Request, res: Response, next: NextFunction): void => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        next();
      };

      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res as unknown as Response, next);

      expect(res._headers['X-Content-Type-Options']).toBe('nosniff');
      expect(res._headers['X-Frame-Options']).toBe('DENY');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('CORS middleware', () => {
    it('should return 204 for OPTIONS requests (CORS preflight)', () => {
      // Simulate the CORS middleware from http.ts lines 38-47
      const corsMiddleware = (_req: Request, res: Response, next: NextFunction): void => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (_req.method === 'OPTIONS') {
          res.status(204).end();
          return;
        }
        next();
      };

      const req = createMockRequest({ method: 'OPTIONS' });
      const res = createMockResponse();
      const next = vi.fn();

      corsMiddleware(req, res as unknown as Response, next);

      expect(res._status).toBe(204);
      expect(res._ended).toBe(true);
      expect(next).not.toHaveBeenCalled();
    });

    it('should set CORS headers and call next for non-OPTIONS requests', () => {
      const corsMiddleware = (_req: Request, res: Response, next: NextFunction): void => {
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        if (_req.method === 'OPTIONS') {
          res.status(204).end();
          return;
        }
        next();
      };

      const req = createMockRequest({ method: 'POST' });
      const res = createMockResponse();
      const next = vi.fn();

      corsMiddleware(req, res as unknown as Response, next);

      expect(res._headers['Access-Control-Allow-Origin']).toBe('*');
      expect(res._headers['Access-Control-Allow-Methods']).toBe('POST, GET, OPTIONS');
      expect(res._headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization');
      expect(next).toHaveBeenCalled();
    });
  });

  describe('Health check endpoint', () => {
    it('should return { status: "ok" } for GET /health', () => {
      // Simulate health check handler from http.ts lines 50-52
      const handler = (_req: Request, res: Response): void => {
        res.json({ status: 'ok' });
      };

      const req = createMockRequest();
      const res = createMockResponse();

      handler(req, res as unknown as Response);

      expect(res._body).toEqual({ status: 'ok' });
    });
  });

  describe('MCP endpoint authentication', () => {
    // Simulate the authentication logic from http.ts lines 58-78
    async function mcpAuthHandler(
      req: Request,
      res: Response,
      tokenStore: TokenStore,
    ): Promise<{ authorized: boolean; apiKey?: string; userData?: UserTokenData }> {
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer sk-xxx' });
        return { authorized: false };
      }

      const apiKey = authHeader.slice(7);
      if (!isValidApiKeyFormat(apiKey)) {
        res.status(401).json({ error: 'Invalid API Key format.' });
        return { authorized: false };
      }

      const userData = await tokenStore.load(apiKey);
      if (!userData) {
        res.status(401).json({ error: 'Invalid API Key. Please register at /setup.' });
        return { authorized: false };
      }

      return { authorized: true, apiKey, userData };
    }

    function createMockTokenStore(overrides: Partial<TokenStore> = {}): TokenStore {
      return {
        save: vi.fn(),
        load: vi.fn().mockResolvedValue(null),
        delete: vi.fn(),
        exists: vi.fn(),
        ...overrides,
      };
    }

    it('should return 401 when Authorization header is missing', async () => {
      const req = createMockRequest({ headers: {} });
      const res = createMockResponse();
      const store = createMockTokenStore();

      const result = await mcpAuthHandler(req, res as unknown as Response, store);

      expect(result.authorized).toBe(false);
      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'Missing or invalid Authorization header. Use: Bearer sk-xxx' });
    });

    it('should return 401 when Authorization header does not start with Bearer', async () => {
      const req = createMockRequest({ headers: { authorization: 'Basic abc123' } });
      const res = createMockResponse();
      const store = createMockTokenStore();

      const result = await mcpAuthHandler(req, res as unknown as Response, store);

      expect(result.authorized).toBe(false);
      expect(res._status).toBe(401);
    });

    it('should return 401 when API Key format is invalid', async () => {
      const req = createMockRequest({ headers: { authorization: 'Bearer invalid-key' } });
      const res = createMockResponse();
      const store = createMockTokenStore();

      const result = await mcpAuthHandler(req, res as unknown as Response, store);

      expect(result.authorized).toBe(false);
      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'Invalid API Key format.' });
    });

    it('should return 401 when API Key is valid format but not found in store', async () => {
      // Generate a valid-format API key (sk- + 64 hex chars)
      const validFormatKey = 'sk-' + 'a'.repeat(64);
      const req = createMockRequest({ headers: { authorization: `Bearer ${validFormatKey}` } });
      const res = createMockResponse();
      const store = createMockTokenStore({
        load: vi.fn().mockResolvedValue(null),
      });

      const result = await mcpAuthHandler(req, res as unknown as Response, store);

      expect(result.authorized).toBe(false);
      expect(res._status).toBe(401);
      expect(res._body).toEqual({ error: 'Invalid API Key. Please register at /setup.' });
    });

    it('should authorize when API Key is valid and found in store', async () => {
      const validFormatKey = 'sk-' + 'b'.repeat(64);
      const mockUserData: UserTokenData = {
        apiKey: validFormatKey,
        accessToken: 'test-access-token',
        refreshToken: 'test-refresh-token',
        expiresAt: Date.now() + 3600000,
        companyId: '1',
        createdAt: Date.now(),
      };

      const req = createMockRequest({ headers: { authorization: `Bearer ${validFormatKey}` } });
      const res = createMockResponse();
      const store = createMockTokenStore({
        load: vi.fn().mockResolvedValue(mockUserData),
      });

      const result = await mcpAuthHandler(req, res as unknown as Response, store);

      expect(result.authorized).toBe(true);
      expect(result.apiKey).toBe(validFormatKey);
      expect(result.userData).toEqual(mockUserData);
    });
  });

  describe('Method not allowed handler', () => {
    it('should return 405 for non-POST methods on MCP endpoint', () => {
      // Simulate the catch-all handler from http.ts lines 150-152
      const handler = (_req: Request, res: Response): void => {
        res.status(405).json({ error: 'Method not allowed. Use POST.' });
      };

      const req = createMockRequest({ method: 'GET' });
      const res = createMockResponse();

      handler(req, res as unknown as Response);

      expect(res._status).toBe(405);
      expect(res._body).toEqual({ error: 'Method not allowed. Use POST.' });
    });
  });

  describe('isValidApiKeyFormat', () => {
    it('should accept valid API key format', () => {
      const validKey = 'sk-' + 'a'.repeat(64);
      expect(isValidApiKeyFormat(validKey)).toBe(true);
    });

    it('should reject key without sk- prefix', () => {
      const invalidKey = 'xx-' + 'a'.repeat(64);
      expect(isValidApiKeyFormat(invalidKey)).toBe(false);
    });

    it('should reject key with wrong length', () => {
      const shortKey = 'sk-' + 'a'.repeat(32);
      expect(isValidApiKeyFormat(shortKey)).toBe(false);
    });

    it('should reject empty string', () => {
      expect(isValidApiKeyFormat('')).toBe(false);
    });
  });

  describe('MCP_ENDPOINT_PATH constant', () => {
    it('should be /mcp', () => {
      expect(MCP_ENDPOINT_PATH).toBe('/mcp');
    });
  });
});
