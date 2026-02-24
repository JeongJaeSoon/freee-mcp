import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Router } from 'express';
import { TokenStore } from '../store/token-store.js';

vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() =>
    Promise.resolve({
      oauth: {
        tokenEndpoint: 'https://accounts.secure.freee.co.jp/public_api/token',
        authorizationEndpoint: 'https://accounts.secure.freee.co.jp/public_api/authorize',
        scope: 'read write',
      },
      freee: { clientId: 'test-id', clientSecret: 'test-secret' },
    }),
  ),
}));

vi.mock('../auth/oauth.js', () => ({
  generatePKCE: vi.fn(() => ({
    codeVerifier: 'test-verifier',
    codeChallenge: 'test-challenge',
  })),
  buildAuthUrl: vi.fn(() => 'https://accounts.secure.freee.co.jp/public_api/authorize?test=1'),
}));

vi.mock('../auth/api-keys.js', () => ({
  generateApiKey: vi.fn(() => 'sk-' + 'a'.repeat(64)),
}));

vi.mock('../auth/tokens.js', () => ({
  OAuthTokenResponseSchema: {
    safeParse: vi.fn(() => ({
      success: true,
      data: {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_in: 3600,
        token_type: 'Bearer',
      },
    })),
  },
}));

vi.mock('../auth/token-utils.js', () => ({
  createTokenData: vi.fn(() => ({
    access_token: 'test-access-token',
    refresh_token: 'test-refresh-token',
    expires_at: Date.now() + 3600000,
    token_type: 'Bearer',
    scope: 'read write',
  })),
}));

function createMockTokenStore(): TokenStore {
  return {
    save: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    delete: vi.fn().mockResolvedValue(undefined),
    exists: vi.fn().mockResolvedValue(false),
  };
}

// Helper to extract route paths from a Router instance
function getRoutePaths(router: Router): { method: string; path: string }[] {
  const routes: { method: string; path: string }[] = [];
  // Express Router stores routes in its stack
  const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> }).stack;
  for (const layer of stack) {
    if (layer.route) {
      const methods = Object.keys(layer.route.methods);
      for (const method of methods) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path });
      }
    }
  }
  return routes;
}

describe('Setup Router', () => {
  let createSetupRouter: typeof import('./setup.js').createSetupRouter;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Dynamic import to get the actual (non-mocked) createSetupRouter
    const mod = await import('./setup.js');
    createSetupRouter = mod.createSetupRouter;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('createSetupRouter', () => {
    it('should return a Router instance', () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');

      // Express Router is a function
      expect(typeof router).toBe('function');
    });

    it('should register GET /setup route', () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');
      const routes = getRoutePaths(router);

      const setupRoute = routes.find((r) => r.method === 'GET' && r.path === '/setup');
      expect(setupRoute).toBeDefined();
    });

    it('should register GET /setup/auth route', () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');
      const routes = getRoutePaths(router);

      const authRoute = routes.find((r) => r.method === 'GET' && r.path === '/setup/auth');
      expect(authRoute).toBeDefined();
    });

    it('should register GET /setup/callback route', () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');
      const routes = getRoutePaths(router);

      const callbackRoute = routes.find((r) => r.method === 'GET' && r.path === '/setup/callback');
      expect(callbackRoute).toBeDefined();
    });

    it('should register exactly 3 routes', () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');
      const routes = getRoutePaths(router);

      expect(routes).toHaveLength(3);
    });
  });

  describe('GET /setup handler', () => {
    it('should return HTML with setup page content', () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');

      // Extract the /setup handler from the router stack
      const stack = (router as unknown as { stack: Array<{ route?: { path: string; methods: Record<string, boolean> }; handle: (...args: unknown[]) => unknown }> }).stack;
      const setupLayer = stack.find((l) => l.route?.path === '/setup');
      expect(setupLayer).toBeDefined();

      // Get the handler function from the route's stack
      const routeStack = (setupLayer!.route as unknown as { stack: Array<{ handle: (...args: unknown[]) => unknown }> }).stack;
      const handler = routeStack[0].handle;

      let sentBody = '';
      let contentType = '';
      const mockReq = {} as Request;
      const mockRes = {
        setHeader(key: string, value: string) {
          if (key === 'Content-Type') contentType = value;
        },
        send(body: string) {
          sentBody = body;
          return mockRes;
        },
      };

      handler(mockReq, mockRes);

      expect(contentType).toBe('text/html; charset=utf-8');
      expect(sentBody).toContain('freee MCP Setup');
      expect(sentBody).toContain('/setup/auth');
    });
  });

  describe('GET /setup/callback handler', () => {
    it('should return 400 when OAuth error is present', async () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');

      const stack = (router as unknown as { stack: Array<{ route?: { path: string }; handle: (...args: unknown[]) => unknown }> }).stack;
      const callbackLayer = stack.find((l) => l.route?.path === '/setup/callback');
      expect(callbackLayer).toBeDefined();

      const routeStack = (callbackLayer!.route as unknown as { stack: Array<{ handle: (...args: unknown[]) => unknown }> }).stack;
      const handler = routeStack[0].handle;

      let statusCode = 200;
      let sentBody = '';
      const mockReq = {
        query: { error: 'access_denied' },
      };
      const mockRes = {
        status(code: number) {
          statusCode = code;
          return mockRes;
        },
        send(body: string) {
          sentBody = body;
          return mockRes;
        },
      };

      await handler(mockReq, mockRes);

      expect(statusCode).toBe(400);
      expect(sentBody).toContain('Authentication Error');
    });

    it('should return 400 when code or state is missing', async () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');

      const stack = (router as unknown as { stack: Array<{ route?: { path: string }; handle: (...args: unknown[]) => unknown }> }).stack;
      const callbackLayer = stack.find((l) => l.route?.path === '/setup/callback');
      const routeStack = (callbackLayer!.route as unknown as { stack: Array<{ handle: (...args: unknown[]) => unknown }> }).stack;
      const handler = routeStack[0].handle;

      let statusCode = 200;
      let sentBody = '';
      const mockReq = {
        query: {}, // no code or state
      };
      const mockRes = {
        status(code: number) {
          statusCode = code;
          return mockRes;
        },
        send(body: string) {
          sentBody = body;
          return mockRes;
        },
      };

      await handler(mockReq, mockRes);

      expect(statusCode).toBe(400);
      expect(sentBody).toContain('Missing required parameters');
    });

    it('should return 400 when state is invalid (not in pending setups)', async () => {
      const store = createMockTokenStore();
      const router = createSetupRouter(store, 'http://localhost:3000');

      const stack = (router as unknown as { stack: Array<{ route?: { path: string }; handle: (...args: unknown[]) => unknown }> }).stack;
      const callbackLayer = stack.find((l) => l.route?.path === '/setup/callback');
      const routeStack = (callbackLayer!.route as unknown as { stack: Array<{ handle: (...args: unknown[]) => unknown }> }).stack;
      const handler = routeStack[0].handle;

      let statusCode = 200;
      let sentBody = '';
      const mockReq = {
        query: { code: 'test-code', state: 'nonexistent-state' },
      };
      const mockRes = {
        status(code: number) {
          statusCode = code;
          return mockRes;
        },
        send(body: string) {
          sentBody = body;
          return mockRes;
        },
      };

      await handler(mockReq, mockRes);

      expect(statusCode).toBe(400);
      expect(sentBody).toContain('Invalid or expired state');
    });
  });
});
