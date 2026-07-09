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
import { isCodexInstalled, getCodexModel, fetchCodexUsage } from './utils/codex-client.js';
import { isZaiInstalled, fetchZaiUsage } from './utils/zai-api-client.js';
import { isGeminiInstalled, fetchGeminiUsage } from './utils/gemini-client.js';
import { usesAnthropicRateLimits } from './utils/provider.js';
import { getTranslations } from './utils/i18n.js';
import { formatOutput } from './widgets/index.js';
import { maybeSpawnRefresh } from './utils/background-refresh.js';
import { debugLog } from './utils/debug.js';

const CONFIG_PATH = join(homedir(), '.claude', 'claude-dashboard.local.json');

/**
 * statusline은 매 렌더마다 새로 spawn되는 hot path 프로세스다(리졸버가
 * spawnSync로 동기 대기). cold 캐시일 때 fetchUsageLimits()의 네트워크 fetch
 * (타임아웃 5s + curl 폴백 5s, 최대 ~11s), codex-usage 위젯의 codex exec
 * 서브프로세스(~8s), z.ai/Gemini 사용량 API 호출(각 최대 ~5s)을 기다리면
 * 상태줄 렌더 전체가 그만큼 멈춘다.
 *
 * 해결: 렌더 프로세스는 각 provider(Anthropic/Codex/z.ai/Gemini) 위젯이
 * 모두 `cacheOnly`로 파일 캐시만 읽어 즉시 렌더하고 종료한다. 렌더 직후
 * `maybeSpawnRefresh()`가 분리된(detached) 자식 프로세스를 `--refresh` 인자로
 * 띄워 백그라운드에서 전체 fetch로 캐시를 데운다 — 부모는 기다리지 않는다
 * (stale-while-revalidate, 프로세스 분리).
 */
const isRefresh = process.argv.includes('--refresh');

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

  // Build rate limits: prefer stdin, fallback to cache-only API read.
  // Hot path never hits the network directly — a detached refresh process
  // (spawned below, after output is printed) keeps the file cache warm.
  const stdinLimits = parseStdinRateLimits(stdin);
  let rateLimits: UsageLimits | null;

  if (!usesAnthropicRateLimits()) {
    // Bedrock/Vertex/z.ai: Anthropic 구독 usage 없음 → 키체인+네트워크 호출 자체를 스킵.
    // rate-limit 위젯은 어차피 숨겨지므로 표시 결과 불변.
    rateLimits = null;
  } else if (!stdinLimits) {
    // Stdin rate_limits not yet available — cache-only fallback
    rateLimits = await fetchUsageLimits(config.cache.ttlSeconds, { cacheOnly: true });
  } else if (config.plan === 'max') {
    // Hybrid: stdin for 5h/7d, cache-only for seven_day_sonnet
    const apiLimits = await fetchUsageLimits(config.cache.ttlSeconds, { cacheOnly: true });
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
    fast: true,
  };

  // Format output using widget system
  const output = await formatOutput(ctx);

  console.log(output);

  // Cache warming happens out-of-band; never block the render on it.
  maybeSpawnRefresh(process.argv[1]);
}

/**
 * Background cache-warming entry point (`--refresh` mode).
 *
 * Spawned detached by `maybeSpawnRefresh()` from a hot-path render process.
 * Never reads stdin and never renders — this process's own wall time is
 * invisible to the user (the parent already printed output and exited).
 * Performs the full (network-including) fetches that the render path skips
 * via `cacheOnly`, so the *next* render finds a warm file cache.
 */
async function runRefresh(): Promise<void> {
  try {
    const config = await loadConfig();
    const tasks: Promise<unknown>[] = [];

    if (usesAnthropicRateLimits()) {
      tasks.push(fetchUsageLimits(config.cache.ttlSeconds));
    }

    if (await isCodexInstalled()) {
      tasks.push(getCodexModel());
      tasks.push(fetchCodexUsage(config.cache.ttlSeconds));
    }

    if (isZaiInstalled()) {
      tasks.push(fetchZaiUsage(config.cache.ttlSeconds));
    }

    if (await isGeminiInstalled()) {
      tasks.push(fetchGeminiUsage(config.cache.ttlSeconds));
    }

    await Promise.allSettled(tasks);
    debugLog('statusline', 'background refresh completed');
  } catch (err) {
    debugLog('statusline', 'background refresh failed', err);
  } finally {
    process.exit(0);
  }
}

// Run: `--refresh` warms the cache in the background; otherwise render normally.
// The detached refresh process never calls maybeSpawnRefresh itself, so there
// is no recursive spawn chain.
if (isRefresh) {
  runRefresh();
} else {
  main().catch(() => {
    console.log(colorize(ICON.warning, COLORS.yellow));
  });
}
