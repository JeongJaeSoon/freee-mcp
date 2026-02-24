import express, { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../mcp/handlers.js';
import { isValidApiKeyFormat } from '../auth/api-keys.js';
import { createTokenStore } from '../store/index.js';
import { createSetupRouter } from './setup.js';
import { MCP_ENDPOINT_PATH } from '../constants.js';
import { OAuthTokenResponseSchema } from '../auth/tokens.js';
import { createTokenData } from '../auth/token-utils.js';
import { getConfig } from '../config.js';
import { USER_AGENT } from '../constants.js';

export interface HttpServerOptions {
  port: number;
  host: string;
  baseUrl?: string;
}

export async function createAndStartHttpServer(options: HttpServerOptions): Promise<void> {
  const { port, host } = options;
  const baseUrl = options.baseUrl || `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

  const tokenStore = createTokenStore();
  const app = express();

  // Middleware
  app.use(express.json());

  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // CORS
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.json({ status: 'ok' });
  });

  // Setup routes (no auth required)
  app.use(createSetupRouter(tokenStore, baseUrl));

  // MCP endpoint - Stateless POST only
  app.post(MCP_ENDPOINT_PATH, async (req: Request, res: Response) => {
    try {
      // Extract API Key from Authorization header
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({ error: 'Missing or invalid Authorization header. Use: Bearer sk-xxx' });
        return;
      }

      const apiKey = authHeader.slice(7); // Remove "Bearer " prefix
      if (!isValidApiKeyFormat(apiKey)) {
        res.status(401).json({ error: 'Invalid API Key format.' });
        return;
      }

      // Look up user tokens
      const userData = await tokenStore.load(apiKey);
      if (!userData) {
        res.status(401).json({ error: 'Invalid API Key. Please register at /setup.' });
        return;
      }

      // Check token expiry and refresh if needed
      if (Date.now() >= userData.expiresAt) {
        try {
          const config = getConfig();
          const refreshResponse = await fetch(config.oauth.tokenEndpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              'User-Agent': USER_AGENT,
            },
            body: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: userData.refreshToken,
              client_id: config.freee.clientId,
              client_secret: config.freee.clientSecret,
            }),
          });

          if (!refreshResponse.ok) {
            res.status(401).json({ error: 'Token refresh failed. Please re-authenticate at /setup.' });
            return;
          }

          const jsonData: unknown = await refreshResponse.json();
          const parseResult = OAuthTokenResponseSchema.safeParse(jsonData);
          if (!parseResult.success) {
            res.status(401).json({ error: 'Invalid token refresh response.' });
            return;
          }

          const newTokenData = createTokenData(parseResult.data, {
            refreshToken: userData.refreshToken,
            scope: config.oauth.scope,
          });

          // Update stored tokens
          userData.accessToken = newTokenData.access_token;
          userData.refreshToken = newTokenData.refresh_token || userData.refreshToken;
          userData.expiresAt = newTokenData.expires_at;
          await tokenStore.save(apiKey, userData);
        } catch {
          res.status(401).json({ error: 'Token refresh failed. Please re-authenticate at /setup.' });
          return;
        }
      }

      // Create a new MCP server instance for this request (stateless)
      const server = await createMcpServer();

      // Create stateless transport
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
        enableJsonResponse: true,
      });

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('MCP request error:', message);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    }
  });

  // Reject other methods on /mcp
  app.all(MCP_ENDPOINT_PATH, (_req: Request, res: Response) => {
    res.status(405).json({ error: 'Method not allowed. Use POST.' });
  });

  // Start server
  const server = app.listen(port, host, () => {
    console.error(`Freee MCP HTTP Server running on http://${host}:${port}`);
    console.error(`  MCP endpoint: POST ${baseUrl}${MCP_ENDPOINT_PATH}`);
    console.error(`  Setup page: ${baseUrl}/setup`);
    console.error(`  Health check: ${baseUrl}/health`);
  });

  // Graceful shutdown
  const shutdown = (): void => {
    console.error('Shutting down HTTP server...');
    server.close(() => {
      console.error('HTTP server stopped.');
      // Disconnect Redis if applicable
      if ('disconnect' in tokenStore && typeof (tokenStore as Record<string, unknown>).disconnect === 'function') {
        (tokenStore as { disconnect: () => Promise<void> }).disconnect().catch(() => {});
      }
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
