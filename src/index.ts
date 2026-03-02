import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createServer, type Server } from 'node:http';
import pino from 'pino';
import { loadConfig } from './config/loader.js';
import { createApp } from './http/app.js';

// Configure Pino logger
// pino-pretty is used only in development for human-readable output
const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
});

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

// Placeholder for startup dependency validation (implemented in Plan 01-02)
logger.warn('Dependency validation will be added in next plan (FalkorDB, LanceDB, Ollama checks)');

// Build the Express app with MCP routes
const app = createApp(config);

// Start the HTTP server
const httpServer: Server = createServer(app);

httpServer.listen(config.port, () => {
  logger.info(`CodeGraph MCP server listening on port ${config.port}`);
  logger.info(`MCP endpoint: http://localhost:${config.port}/mcp`);
});

// Graceful shutdown handler
let isShuttingDown = false;

function gracefulShutdown(signal: string): void {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, 'Shutting down...');

  httpServer.close((err) => {
    if (err) {
      logger.error({ err }, 'Error closing HTTP server');
      process.exit(1);
    }

    // Future: close FalkorDB and LanceDB connections (placeholder for Plan 01-02)
    logger.info('HTTP server closed. Exiting.');
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
