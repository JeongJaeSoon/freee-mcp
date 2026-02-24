import { createAndStartServer } from './mcp/handlers.js';
import { configure } from './cli.js';
import { loadConfig } from './config.js';
import { DEFAULT_HTTP_PORT, DEFAULT_HTTP_HOST } from './constants.js';

function parseArgs(args: string[]): { subcommand?: string; transport: string; port: number; host: string } {
  let subcommand: string | undefined;
  let transport = 'stdio';
  let port = DEFAULT_HTTP_PORT;
  let host = DEFAULT_HTTP_HOST;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--transport' && i + 1 < args.length) {
      transport = args[++i];
    } else if (arg === '--port' && i + 1 < args.length) {
      port = parseInt(args[++i], 10);
    } else if (arg === '--host' && i + 1 < args.length) {
      host = args[++i];
    } else if (!arg.startsWith('--')) {
      subcommand = arg;
    }
  }

  return { subcommand, transport, port, host };
}

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const parsed = parseArgs(args);

  if (parsed.subcommand === 'configure') {
    await configure();
    return;
  }

  if (parsed.subcommand && parsed.subcommand !== 'client') {
    console.error(`Unknown subcommand: ${parsed.subcommand}`);
    console.error('Usage: freee-mcp [configure]');
    console.error('  --transport <stdio|http>  Transport mode (default: stdio)');
    console.error('  --port <number>           HTTP port (default: 3000)');
    console.error('  --host <string>           HTTP host (default: 0.0.0.0)');
    console.error('  configure                 Interactive configuration setup');
    process.exit(1);
  }

  if (parsed.transport === 'http') {
    // Load config first for HTTP mode
    await loadConfig();
    const { createAndStartHttpServer } = await import('./server/http.js');
    console.error('Starting freee MCP HTTP server');
    await createAndStartHttpServer({
      port: parsed.port,
      host: parsed.host,
    });
  } else {
    console.error('Starting freee MCP server');
    await createAndStartServer();
  }
};

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
