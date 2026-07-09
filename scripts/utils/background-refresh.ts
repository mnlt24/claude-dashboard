/**
 * Throttled detached background refresh spawn.
 *
 * The statusline entry point is a hot path: each render is a freshly spawned
 * child process that the resolver waits on synchronously (see
 * `statusline-resolver.mjs`'s `spawnSync`). It must never block on slow
 * network/subprocess calls. Instead, the render process reads cache-only
 * data (see `fetchUsageLimits({ cacheOnly: true })`, `getCodexModel({
 * cacheOnly: true })`) and, after printing output, fires off a detached
 * `--refresh` child process that performs the full (network-including)
 * fetches and warms the shared file cache for the *next* render. The parent
 * never waits on it.
 *
 * @handbook 4.7-cross-process-file-cache
 * @tested scripts/__tests__/background-refresh.test.ts
 */
import { spawn } from 'child_process';
import { mkdirSync, statSync, writeFileSync } from 'fs';
import { fileCachePath, FILE_CACHE_DIR } from './file-cache.js';
import { debugLog } from './debug.js';

/**
 * Minimum interval between spawned refreshes. Throttles repeated renders
 * (e.g. rapid re-renders while typing) from each spawning their own
 * background process.
 */
export const REFRESH_MIN_INTERVAL_MS = 30_000;

/**
 * Lock file used purely as a throttle marker (mtime = last spawn time).
 * Not a real lock — best-effort, first writer wins, no cross-process
 * coordination guarantees beyond "good enough to avoid a spawn storm".
 */
const REFRESH_LOCK_FILE = fileCachePath('refresh-lock.json');

/**
 * Pure throttle check, split out from `maybeSpawnRefresh` for unit testing
 * without mocking `child_process.spawn`. Returns true when enough time has
 * elapsed since the last recorded refresh (or no lock file exists yet).
 *
 * @param now - Current time in ms (injectable for deterministic tests)
 * @param lockFilePath - Lock file to check (injectable for isolated tests)
 */
export function shouldSpawnRefresh(
  now: number = Date.now(),
  lockFilePath: string = REFRESH_LOCK_FILE
): boolean {
  try {
    const stat = statSync(lockFilePath);
    return now - stat.mtimeMs >= REFRESH_MIN_INTERVAL_MS;
  } catch {
    // Missing lock file (first run, or cache dir doesn't exist yet) — allow spawn.
    return true;
  }
}

/**
 * Best-effort: spawn a detached background process to warm the file cache,
 * throttled so at most one refresh is spawned per `REFRESH_MIN_INTERVAL_MS`.
 * Never throws and never blocks the caller — any failure (throttle check,
 * lock write, or spawn itself) is swallowed and debug-logged so the hot-path
 * render is never affected.
 *
 * @param entryPath - Path to the dist entry point to re-invoke with `--refresh`
 *   (typically `process.argv[1]` of the calling render process)
 */
export function maybeSpawnRefresh(entryPath: string | undefined): void {
  if (!entryPath) return;

  try {
    if (!shouldSpawnRefresh()) {
      debugLog('background-refresh', 'throttled, skipping spawn');
      return;
    }
  } catch (err) {
    // Fail safe: if the throttle check itself misbehaves unexpectedly, skip
    // spawning rather than risk an unthrottled spawn storm.
    debugLog('background-refresh', 'throttle check failed, skipping spawn', err);
    return;
  }

  try {
    mkdirSync(FILE_CACHE_DIR, { recursive: true, mode: 0o700 });
    writeFileSync(REFRESH_LOCK_FILE, JSON.stringify({ timestamp: Date.now() }), { mode: 0o600 });
  } catch (err) {
    debugLog('background-refresh', 'lock write failed (best-effort, continuing)', err);
  }

  try {
    const child = spawn(process.execPath, [entryPath, '--refresh'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env },
    });
    child.unref();
    debugLog('background-refresh', 'spawned detached refresh process');
  } catch (err) {
    debugLog('background-refresh', 'spawn failed (best-effort, ignored)', err);
  }
}
