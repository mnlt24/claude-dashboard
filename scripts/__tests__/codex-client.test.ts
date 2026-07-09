/**
 * @handbook 8.1-test-structure
 * @covers scripts/utils/codex-client.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('codex-client', () => {
  describe('fetchCodexUsage file cache integration', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock('../utils/file-cache.js');
      vi.doUnmock('fs/promises');
      vi.doUnmock('child_process');
    });

    it('returns file cache hit and skips network fetch', async () => {
      const sample = {
        model: 'gpt-5',
        planType: 'plus',
        primary: { usedPercent: 42, resetAt: Date.now() + 3_600_000 },
        secondary: null,
      };

      const authJson = JSON.stringify({
        tokens: { access_token: 'codex-token', account_id: 'acct-1' },
      });

      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockResolvedValue({ mtimeMs: 12345 }),
          readFile: vi.fn().mockResolvedValue(authJson),
        };
      });

      vi.doMock('../utils/file-cache.js', () => ({
        loadFileCache: vi.fn().mockResolvedValue({ data: sample, timestamp: Date.now() }),
        saveFileCache: vi.fn(),
        fileCachePath: (name: string) => `/tmp/${name}`,
        FILE_CACHE_DIR: '/tmp',
        STALE_CACHE_TTL_SECONDS: 3600,
      }));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const { fetchCodexUsage, clearCodexCache } = await import('../utils/codex-client.js');
      clearCodexCache();

      const result = await fetchCodexUsage();

      expect(fetchSpy).not.toHaveBeenCalled();
      expect(result).toEqual(sample);
    });

    it('writes to file cache after successful API fetch', async () => {
      const saveSpy = vi.fn().mockResolvedValue(undefined);

      const authJson = JSON.stringify({
        tokens: { access_token: 'codex-token', account_id: 'acct-1' },
      });

      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockResolvedValue({ mtimeMs: 12345 }),
          readFile: vi.fn().mockImplementation((path: unknown) => {
            if (typeof path === 'string' && path.includes('auth.json')) {
              return Promise.resolve(authJson);
            }
            return Promise.reject(new Error('ENOENT'));
          }),
        };
      });

      // Mock child_process so detectModelFromCodexExec fails fast
      // instead of spawning a real codex CLI subprocess.
      vi.doMock('child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('child_process')>();
        return {
          ...actual,
          execFile: vi.fn((_cmd: string, _args: unknown, opts: unknown, cb: unknown) => {
            const callback = typeof opts === 'function' ? opts : cb;
            if (typeof callback === 'function') {
              callback(new Error('mock: codex CLI unavailable'), '', '');
            }
            return { on: () => {} };
          }),
        };
      });

      vi.doMock('../utils/file-cache.js', () => ({
        loadFileCache: vi.fn().mockResolvedValue(null),
        saveFileCache: saveSpy,
        fileCachePath: (name: string) => `/tmp/${name}`,
        FILE_CACHE_DIR: '/tmp',
        STALE_CACHE_TTL_SECONDS: 3600,
      }));

      const apiResponse = {
        plan_type: 'plus',
        rate_limit: {
          primary_window: { used_percent: 42, reset_at: Date.now() + 3_600_000 },
          secondary_window: null,
        },
      };

      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify(apiResponse), { status: 200 })
      );

      const { fetchCodexUsage, clearCodexCache } = await import('../utils/codex-client.js');
      clearCodexCache();

      const result = await fetchCodexUsage();

      expect(saveSpy).toHaveBeenCalledTimes(1);
      expect(saveSpy).toHaveBeenCalledWith(
        expect.stringContaining('codex-usage-'),
        expect.objectContaining({ planType: 'plus' })
      );
      expect(result).toMatchObject({ planType: 'plus' });
    });
  });

  describe('fetchCodexUsage cacheOnly', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock('../utils/file-cache.js');
      vi.doUnmock('fs/promises');
    });

    it('returns null without calling network when cacheOnly is true and no cache (fresh or stale) exists', async () => {
      const authJson = JSON.stringify({
        tokens: { access_token: 'codex-token', account_id: 'acct-1' },
      });

      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockResolvedValue({ mtimeMs: 12345 }),
          readFile: vi.fn().mockResolvedValue(authJson),
        };
      });

      vi.doMock('../utils/file-cache.js', () => ({
        loadFileCache: vi.fn().mockResolvedValue(null),
        saveFileCache: vi.fn(),
        fileCachePath: (name: string) => `/tmp/${name}`,
        FILE_CACHE_DIR: '/tmp',
        STALE_CACHE_TTL_SECONDS: 3600,
      }));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const { fetchCodexUsage, clearCodexCache } = await import('../utils/codex-client.js');
      clearCodexCache();

      const result = await fetchCodexUsage(60, { cacheOnly: true });

      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns stale file cache without calling network when cacheOnly is true', async () => {
      const authJson = JSON.stringify({
        tokens: { access_token: 'codex-token', account_id: 'acct-1' },
      });
      const staleSample = {
        model: 'gpt-5',
        planType: 'plus',
        primary: { usedPercent: 77, resetAt: Date.now() + 3_600_000 },
        secondary: null,
      };

      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockResolvedValue({ mtimeMs: 12345 }),
          readFile: vi.fn().mockResolvedValue(authJson),
        };
      });

      const loadFileCacheMock = vi
        .fn()
        .mockResolvedValueOnce(null) // fresh-ttl check misses
        .mockResolvedValueOnce({ data: staleSample, timestamp: Date.now() - 7_000_000 }); // stale fallback hits

      vi.doMock('../utils/file-cache.js', () => ({
        loadFileCache: loadFileCacheMock,
        saveFileCache: vi.fn(),
        fileCachePath: (name: string) => `/tmp/${name}`,
        FILE_CACHE_DIR: '/tmp',
        STALE_CACHE_TTL_SECONDS: 3600,
      }));

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('{}', { status: 200 })
      );

      const { fetchCodexUsage, clearCodexCache } = await import('../utils/codex-client.js');
      clearCodexCache();

      const result = await fetchCodexUsage(60, { cacheOnly: true });

      expect(result).toEqual(staleSample);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(loadFileCacheMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('getCodexModel cacheOnly', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock('fs/promises');
      vi.doUnmock('child_process');
    });

    it('skips codex exec detection when cacheOnly is true (config.toml and model cache both missing)', async () => {
      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
          readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
        };
      });

      const execFileSpy = vi.fn((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        if (typeof cb === 'function') cb(new Error('should not be called'), '', '');
        return { on: () => {} };
      });
      vi.doMock('child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('child_process')>();
        return { ...actual, execFile: execFileSpy };
      });

      const { getCodexModel } = await import('../utils/codex-client.js');

      const result = await getCodexModel({ cacheOnly: true });

      expect(result).toBeNull();
      expect(execFileSpy).not.toHaveBeenCalled();
    });

    it('falls through to codex exec detection when cacheOnly is omitted (existing full behavior)', async () => {
      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
          readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
        };
      });

      const execFileSpy = vi.fn((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        if (typeof cb === 'function') cb(new Error('mock: codex CLI unavailable'), '', '');
        return { on: () => {} };
      });
      vi.doMock('child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('child_process')>();
        return { ...actual, execFile: execFileSpy };
      });

      const { getCodexModel } = await import('../utils/codex-client.js');

      const result = await getCodexModel();

      expect(result).toBeNull();
      expect(execFileSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('getCodexModel concurrent dedup (in-flight codex exec spawn)', () => {
    beforeEach(() => {
      vi.resetModules();
    });

    afterEach(() => {
      vi.restoreAllMocks();
      vi.doUnmock('fs/promises');
      vi.doUnmock('child_process');
    });

    it('spawns detectModelFromCodexExec only once for two concurrent getCodexModel() calls (config.toml/cache both missing)', async () => {
      vi.doMock('fs/promises', async (importOriginal) => {
        const actual = await importOriginal<typeof import('fs/promises')>();
        return {
          ...actual,
          stat: vi.fn().mockRejectedValue(new Error('ENOENT')),
          readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
          writeFile: vi.fn().mockResolvedValue(undefined),
          mkdir: vi.fn().mockResolvedValue(undefined),
        };
      });

      // Simulate a real subprocess with a small async delay so both
      // concurrent getCodexModel() calls have a chance to reach step 3
      // before the first `codex exec` detection resolves.
      const execFileSpy = vi.fn((_cmd: string, _args: unknown, _opts: unknown, cb: unknown) => {
        setTimeout(() => {
          if (typeof cb === 'function') cb(null, 'model: gpt-5-test\n', '');
        }, 10);
        return { on: () => {} };
      });
      vi.doMock('child_process', async (importOriginal) => {
        const actual = await importOriginal<typeof import('child_process')>();
        return { ...actual, execFile: execFileSpy };
      });

      const { getCodexModel } = await import('../utils/codex-client.js');

      const [first, second] = await Promise.all([getCodexModel(), getCodexModel()]);

      expect(first).toBe('gpt-5-test');
      expect(second).toBe('gpt-5-test');
      expect(execFileSpy).toHaveBeenCalledTimes(1);
    });
  });
});
