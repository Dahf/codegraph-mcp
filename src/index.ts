import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { loadConfig } from './config/loader.js';
import { createApp } from './http/app.js';
import { FalkorDBAdapter } from './adapters/falkordb.js';
import { LanceDBAdapter } from './adapters/lancedb.js';
import { OllamaAdapter } from './adapters/ollama.js';
import { RepoStore } from './repos/store.js';
import { RepoManager } from './repos/manager.js';

// Configure Pino logger
// pino-pretty is used only in development for human-readable output
const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
});

// Record startup time before any async work
const startTime = new Date();

// Load and validate configuration
const config = loadConfig();

logger.info({ port: config.port, dataDir: config.dataDir }, 'Configuration loaded');

// Auto-init: create required data directories on first start
const dataDir = resolve(config.dataDir);
const dataDirs = [
  join(dataDir, 'repos'),
  join(dataDir, 'graph'),
  join(dataDir, 'vectors'),
];

for (const dir of dataDirs) {
  mkdirSync(dir, { recursive: true });
}
logger.info({ dataDir }, 'Data directories initialized');

// Startup dependency validation — fail fast if any dependency is unreachable
const falkordb = new FalkorDBAdapter(config.falkordb);
const lancedb = new LanceDBAdapter(config.lancedb);
const ollama = new OllamaAdapter(config.ollama);

try {
  await falkordb.connect();
  await lancedb.connect();
  await ollama.connect();
} catch (err) {
  logger.error({ err }, 'Startup validation failed');
  process.exit(1);
}

logger.info('All dependencies validated. Starting server...');

// Build adapters grouping for app and health routes
const adapters = { falkordb, lancedb, ollama };

// Resolve config path for RepoManager persistence
// Uses same resolution logic as loadConfig(): argv[2] if .json, else cwd/config.json
const configArg = process.argv[2];
const configPath =
  configArg && configArg.endsWith('.json')
    ? resolve(configArg)
    : resolve(process.cwd(), 'config.json');

// Initialize repo store and manager
const repoStore = new RepoStore(config.repos);
const repoManager = new RepoManager(repoStore, configPath);

// Build the Express app with MCP routes, repo API, and health endpoints
const app = createApp(config, adapters, repoManager, repoStore, startTime);

// Start the HTTP server
const httpServer: Server = createServer(app);

httpServer.listen(config.port, () => {
  logger.info(`CodeGraph MCP server listening on port ${config.port}`);
  logger.info(`MCP endpoint: http://localhost:${config.port}/mcp`);
  logger.info(`Health endpoint: http://localhost:${config.port}/health`);
  logger.info(`Repos endpoint: http://localhost:${config.port}/repos`);
});

// Graceful shutdown handler
let isShuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down...');

  httpServer.close(async (err) => {
    if (err) {
      logger.error({ err }, 'Error closing HTTP server');
      process.exit(1);
    }

    // Close all adapter connections cleanly
    await falkordb.close();
    await lancedb.close();
    await ollama.close();

    logger.info('All connections closed. Exiting.');
    process.exit(0);
  });

  // Force exit after 10 seconds if graceful shutdown stalls
  setTimeout(() => {
    logger.error('Graceful shutdown timed out. Forcing exit.');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
