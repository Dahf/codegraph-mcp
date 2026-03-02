import type { Request, Response, NextFunction, ErrorRequestHandler } from 'express';
import pino from 'pino';

const logger = pino({
  level: process.env['LOG_LEVEL'] ?? 'info',
  transport:
    process.env['NODE_ENV'] === 'development'
      ? { target: 'pino-pretty' }
      : undefined,
});

/**
 * Global Express error handler middleware.
 *
 * Must be registered LAST (after all routes) to catch unhandled errors.
 * Express identifies error handlers by their 4-argument signature: (err, req, res, next).
 *
 * Behavior:
 *   - JSON parse errors (SyntaxError from body-parser): 400 with { error: "Invalid JSON" }
 *   - All other errors: 500
 *     - Production: { error: "Internal server error" }
 *     - Development: { error: "Internal server error", details: err.message }
 */
export const errorHandler: ErrorRequestHandler = (
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void => {
  // Handle JSON parse errors from express.json() middleware
  if (err instanceof SyntaxError && 'status' in err && (err as { status: number }).status === 400) {
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  // Log the error
  logger.error({ err }, 'Unhandled error');

  const message = err instanceof Error ? err.message : String(err);

  if (process.env['NODE_ENV'] === 'development') {
    res.status(500).json({ error: 'Internal server error', details: message });
  } else {
    res.status(500).json({ error: 'Internal server error' });
  }
};
