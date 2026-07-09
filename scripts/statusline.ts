#!/usr/bin/env node

/**
 * Claude Dashboard Status Line
 * Displays model info, context usage, rate limits, and more
 * @handbook 2.2-import-order
 * @handbook 4.6-config-caching
 * @handbook 6.1-hierarchical-defense
 */

import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';

import type { StdinInput, Config, WidgetContext, UsageLimits } from './types.js';
import { DEFAULT_CONFIG, parsePreset } from './types.js';
import { COLORS, colorize, setTheme, setSeparatorStyle } from './utils/colors.js';
import { ICON } from './utils/emoji.js';
import { fetchUsageLimits } from './utils/api-client.js';
import { usesAnthropicRateLimits } from './utils/provider.js';
import { getTranslations } from './utils/i18n.js';
import { formatOutput } from './widgets/index.js';

const CONFIG_PATH = join(homedir(), '.claude', 'claude-dashboard.local.json');

/**
 * statusline은 매 렌더마다 실행되는 hot path. cold 캐시일 때 fetchUsageLimits()가
 * fetch 타임아웃(5s) + curl 폴백(5s)까지 최대 ~11초 동기 대기해 상태줄 렌더를 막을 수 있다.
 * 이 데드라인을 넘기면 stale 파일 캐시(있으면)로 즉시 폴백해 렌더를 블로킹하지 않는다.
 * 원본 fetch는 백그라운드에서 계속 완료돼 다음 렌더를 위해 파일 캐시를 데운다.
 */
const USAGE_FETCH_DEADLINE_MS = 1500;

/**
 * Cached config with mtime-based invalidation
 */
let configCache: {
  config: Config;
  mtime: number;
} | null = null;

/**
 * Read and parse stdin JSON
 */
async function readStdin(): Promise<StdinInput | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    const content = Buffer.concat(chunks).toString('utf-8');
    return JSON.parse(content) as StdinInput;
  } catch {
    return null;
  }
}

/**
 * Load user configuration with mtime-based cache and migration support
 */
async function loadConfig(): Promise<Config> {
  try {
    // Check mtime for cache invalidation
    const fileStat = await stat(CONFIG_PATH);
    const mtime = fileStat.mtimeMs;

    // Return cached if mtime matches
    if (configCache?.mtime === mtime) {
      return configCache.config;
    }

    const content = await readFile(CONFIG_PATH, 'utf-8');
    const userConfig = JSON.parse(content);

    // Migrate old config format (add displayMode if missing)
    const config: Config = {
      ...DEFAULT_CONFIG,
      ...userConfig,
    };

    // Apply preset shorthand if configured
    if (config.preset) {
      const lines = parsePreset(config.preset);
      if (lines.length > 0) {
        config.displayMode = 'custom';
        config.lines = lines;
      }
    }

    // Cache result
    configCache = { config, mtime };
    return config;
  } catch {
    return DEFAULT_CONFIG;
  }
}

/**
 * Convert a single stdin rate limit window (epoch seconds) to UsageLimits field format (ISO string).
 */
function convertStdinLimit(window: { used_percentage: number; resets_at: number }) {
  return {
    utilization: window.used_percentage,
    resets_at: new Date(window.resets_at * 1000).toISOString(),
  };
}

/**
 * Convert stdin rate_limits (Unix epoch seconds) to UsageLimits format (ISO string).
 * Returns null when stdin doesn't provide rate_limits (before first API response or older Claude Code).
 */
function parseStdinRateLimits(stdin: StdinInput): UsageLimits | null {
  const rl = stdin.rate_limits;
  if (!rl) return null;

  return {
    five_hour: rl.five_hour ? convertStdinLimit(rl.five_hour) : null,
    seven_day: rl.seven_day ? convertStdinLimit(rl.seven_day) : null,
    seven_day_sonnet: null, // Not available in stdin
  };
}

/**
 * Main entry point
 */
async function main(): Promise<void> {
  // Load configuration
  const config = await loadConfig();

  // Initialize theme and separator
  setTheme(config.theme);
  setSeparatorStyle(config.separator);

  // Get translations
  const translations = getTranslations(config);

  // Read stdin
  const stdin = await readStdin();
  if (!stdin) {
    console.log(colorize(ICON.warning, COLORS.yellow));
    return;
  }

  // Build rate limits: prefer stdin, fallback to API
  const stdinLimits = parseStdinRateLimits(stdin);
  let rateLimits: UsageLimits | null;

  if (!usesAnthropicRateLimits()) {
    // Bedrock/Vertex/z.ai: Anthropic 구독 usage 없음 → 키체인+네트워크 호출 자체를 스킵.
    // rate-limit 위젯은 어차피 숨겨지므로 표시 결과 불변.
    rateLimits = null;
  } else if (!stdinLimits) {
    // Stdin rate_limits not yet available — full API fallback
    rateLimits = await fetchUsageLimits(config.cache.ttlSeconds, { deadlineMs: USAGE_FETCH_DEADLINE_MS });
  } else if (config.plan === 'max') {
    // Hybrid: stdin for 5h/7d, API only for seven_day_sonnet
    const apiLimits = await fetchUsageLimits(config.cache.ttlSeconds, { deadlineMs: USAGE_FETCH_DEADLINE_MS });
    rateLimits = { ...stdinLimits, seven_day_sonnet: apiLimits?.seven_day_sonnet ?? null };
  } else {
    rateLimits = stdinLimits;
  }

  // Create widget context
  const ctx: WidgetContext = {
    stdin,
    config,
    translations,
    rateLimits,
  };

  // Format output using widget system
  const output = await formatOutput(ctx);

  console.log(output);
}

// Run
main().catch(() => {
  console.log(colorize(ICON.warning, COLORS.yellow));
});
