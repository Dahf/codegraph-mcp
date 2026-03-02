import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ConfigSchema, type Config } from './schema.js';
import { defaultConfig } from './defaults.js';

/**
 * Load and validate the config file.
 *
 * Config path resolution:
 *   1. CLI arg (process.argv[2] if it looks like a .json path)
 *   2. Default: ./config.json relative to cwd
 *
 * On validation failure: logs Zod errors and exits.
 * On file not found: creates default config.json and returns defaults.
 */
export function loadConfig(configPath?: string): Config {
  // Resolve config path: accept explicit arg, fallback to process.argv[2] if json, then default
  let resolvedPath: string;

  if (configPath) {
    resolvedPath = resolve(configPath);
  } else {
    const cliArg = process.argv[2];
    if (cliArg && cliArg.endsWith('.json')) {
      resolvedPath = resolve(cliArg);
    } else {
      resolvedPath = resolve(process.cwd(), 'config.json');
    }
  }

  // Handle missing config file — create defaults and return
  if (!existsSync(resolvedPath)) {
    console.log(`[config] No config file found at ${resolvedPath} — creating default config.json`);
    writeFileSync(resolvedPath, JSON.stringify(defaultConfig, null, 2) + '\n', 'utf-8');
    console.log(`[config] Created default config.json`);
    return defaultConfig;
  }

  // Read and parse JSON
  let rawJson: unknown;
  try {
    const content = readFileSync(resolvedPath, 'utf-8');
    rawJson = JSON.parse(content);
  } catch (err) {
    console.error(`[config] Failed to read or parse config file at ${resolvedPath}:`, err);
    process.exit(1);
  }

  // Validate with Zod
  const result = ConfigSchema.safeParse(rawJson);
  if (!result.success) {
    console.error(`[config] Config validation failed for ${resolvedPath}:`);
    for (const issue of result.error.issues) {
      console.error(`  - ${issue.path.join('.')}: ${issue.message}`);
    }
    process.exit(1);
  }

  return result.data;
}
