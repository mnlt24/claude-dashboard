/**
 * @handbook 8.1-test-structure
 * @covers scripts/utils/background-refresh.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import path from 'path';
import os from 'os';
import { shouldSpawnRefresh, REFRESH_MIN_INTERVAL_MS } from '../utils/background-refresh.js';

describe('background-refresh', () => {
  describe('shouldSpawnRefresh (throttle logic)', () => {
    const TEST_DIR = path.join(os.tmpdir(), 'claude-dashboard-background-refresh-test');
    const LOCK_FILE = path.join(TEST_DIR, 'refresh-lock.json');

    beforeEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
      mkdirSync(TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      rmSync(TEST_DIR, { recursive: true, force: true });
    });

    it('returns true when no lock file exists yet (first run)', () => {
      expect(shouldSpawnRefresh(Date.now(), LOCK_FILE)).toBe(true);
    });

    it('returns false when the lock file was written recently (within throttle window)', () => {
      writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: Date.now() }));
      const now = Date.now();
      // mtime defaults to "now" at write time — well within the throttle window.
      expect(shouldSpawnRefresh(now, LOCK_FILE)).toBe(false);
    });

    it('returns true once the throttle window has elapsed', () => {
      writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: 0 }));
      const past = new Date(Date.now() - (REFRESH_MIN_INTERVAL_MS + 1_000));
      utimesSync(LOCK_FILE, past, past);

      expect(shouldSpawnRefresh(Date.now(), LOCK_FILE)).toBe(true);
    });

    it('returns false exactly at the throttle boundary minus one ms', () => {
      writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: 0 }));
      const now = Date.now();
      const justInsideWindow = new Date(now - (REFRESH_MIN_INTERVAL_MS - 1));
      utimesSync(LOCK_FILE, justInsideWindow, justInsideWindow);

      expect(shouldSpawnRefresh(now, LOCK_FILE)).toBe(false);
    });

    it('returns true when the lock file path is unreadable/invalid (fail open, allow spawn)', () => {
      const missingPath = path.join(TEST_DIR, 'nested', 'does-not-exist', 'refresh-lock.json');
      expect(shouldSpawnRefresh(Date.now(), missingPath)).toBe(true);
    });
  });

  describe('maybeSpawnRefresh (spawn wiring)', () => {
    const SPAWN_TEST_DIR = path.join(
      os.tmpdir(),
      'claude-dashboard-background-refresh-spawn-test-' + process.pid
    );
    const LOCK_FILE = path.join(SPAWN_TEST_DIR, 'refresh-lock.json');

    // Route the module's internal REFRESH_LOCK_FILE/FILE_CACHE_DIR at an
    // isolated temp dir instead of the real `~/.cache/claude-dashboard`, so
    // throttle state can be controlled per test without touching the
    // developer's actual cache.
    function mockFileCache() {
      vi.doMock('../utils/file-cache.js', () => ({
        fileCachePath: (name: string) => path.join(SPAWN_TEST_DIR, name),
        FILE_CACHE_DIR: SPAWN_TEST_DIR,
      }));
    }

    beforeEach(() => {
      vi.resetModules();
      rmSync(SPAWN_TEST_DIR, { recursive: true, force: true });
      mkdirSync(SPAWN_TEST_DIR, { recursive: true });
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock('child_process');
      vi.doUnmock('../utils/file-cache.js');
      rmSync(SPAWN_TEST_DIR, { recursive: true, force: true });
    });

    it('spawns a detached refresh process with the expected args and unrefs the child when throttle allows', async () => {
      mockFileCache();
      const unrefSpy = vi.fn();
      const spawnSpy = vi.fn().mockReturnValue({ unref: unrefSpy });
      vi.doMock('child_process', () => ({ spawn: spawnSpy }));

      const { maybeSpawnRefresh } = await import('../utils/background-refresh.js');
      maybeSpawnRefresh('/path/to/dist/index.js');

      expect(spawnSpy).toHaveBeenCalledTimes(1);
      expect(spawnSpy).toHaveBeenCalledWith(
        process.execPath,
        ['/path/to/dist/index.js', '--refresh'],
        expect.objectContaining({
          detached: true,
          stdio: 'ignore',
          env: expect.any(Object),
        })
      );
      expect(unrefSpy).toHaveBeenCalledTimes(1);
    });

    it('does not spawn when entryPath is undefined', async () => {
      mockFileCache();
      const spawnSpy = vi.fn();
      vi.doMock('child_process', () => ({ spawn: spawnSpy }));

      const { maybeSpawnRefresh } = await import('../utils/background-refresh.js');
      maybeSpawnRefresh(undefined);

      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('does not spawn when throttled by a recently-written lock file', async () => {
      mockFileCache();
      writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: Date.now() }));

      const spawnSpy = vi.fn();
      vi.doMock('child_process', () => ({ spawn: spawnSpy }));

      const { maybeSpawnRefresh } = await import('../utils/background-refresh.js');
      maybeSpawnRefresh('/path/to/dist/index.js');

      expect(spawnSpy).not.toHaveBeenCalled();
    });

    it('does not throw when spawn itself throws (best-effort)', async () => {
      mockFileCache();
      const spawnSpy = vi.fn(() => {
        throw new Error('spawn EAGAIN');
      });
      vi.doMock('child_process', () => ({ spawn: spawnSpy }));

      const { maybeSpawnRefresh } = await import('../utils/background-refresh.js');

      expect(() => maybeSpawnRefresh('/path/to/dist/index.js')).not.toThrow();
      expect(spawnSpy).toHaveBeenCalledTimes(1);
    });
  });
});
