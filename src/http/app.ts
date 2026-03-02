import { randomUUID } from 'node:crypto';
import express from 'express';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createMcpServer } from '../server.js';
import type { Config } from '../types/index.js';

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  lastActivity: number;
}

const SESSION_CLEANUP_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Create the Express app with MCP routes and DNS rebinding protection.
 *
 * MCP route design:
 *   POST /mcp  — initialize new session or route to existing session
 *   GET  /mcp  — SSE stream for server-initiated messages (existing session only)
 *   DELETE /mcp — terminate session cleanly
 *
 * Session cleanup: a 30-minute interval removes sessions idle for more than 1 hour.
 */
export function createApp(_config: Config): express.Application {
  // createMcpExpressApp() creates an Express app pre-configured with DNS rebinding protection.
  // This protects against SSRF attacks when the server is bound to localhost.
  const app = createMcpExpressApp();

  // JSON body parsing middleware (required for MCP request bodies)
  app.use(express.json());

  // In-memory session registry: sessionId -> { transport, lastActivity }
  const sessions: Record<string, SessionEntry> = {};

  // Periodic cleanup of stale sessions (idle > 1 hour)
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, entry] of Object.entries(sessions)) {
      if (now - entry.lastActivity > SESSION_TTL_MS) {
        delete sessions[sessionId];
      }
    }
  }, SESSION_CLEANUP_INTERVAL_MS);

  // Prevent the cleanup interval from keeping the process alive
  cleanupInterval.unref();

  // POST /mcp — handle new sessions (initialize) and existing sessions
  app.post('/mcp', async (req: express.Request, res: express.Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Route to existing session
    if (sessionId && sessions[sessionId]) {
      sessions[sessionId].lastActivity = Date.now();
      await sessions[sessionId].transport.handleRequest(req, res, req.body);
      return;
    }

    // New session: only allowed for initialize requests
    if (!sessionId && isInitializeRequest(req.body)) {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions[sid] = { transport, lastActivity: Date.now() };
        },
      });

      transport.onclose = () => {
        if (transport.sessionId) {
          delete sessions[transport.sessionId];
        }
      };

      const server = createMcpServer();
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    // Invalid request: no session ID on non-initialize, or unknown session ID
    res.status(400).json({
      error: 'Bad Request',
      message: sessionId
        ? `Session not found: ${sessionId}`
        : 'POST /mcp without mcp-session-id must be an initialize request',
    });
  });

  // GET /mcp — SSE stream for server-initiated messages
  app.get('/mcp', async (req: express.Request, res: express.Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'GET /mcp requires a valid mcp-session-id header',
      });
      return;
    }

    sessions[sessionId].lastActivity = Date.now();
    await sessions[sessionId].transport.handleRequest(req, res);
  });

  // DELETE /mcp — terminate session cleanly
  app.delete('/mcp', async (req: express.Request, res: express.Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    if (!sessionId || !sessions[sessionId]) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'DELETE /mcp requires a valid mcp-session-id header',
      });
      return;
    }

    await sessions[sessionId].transport.handleRequest(req, res);
    // Session cleanup happens via transport.onclose callback
  });

  return app;
}
