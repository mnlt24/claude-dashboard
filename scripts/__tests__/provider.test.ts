/**
 * @handbook 8.1-test-structure
 * @covers scripts/utils/provider.ts
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

const ENV_KEYS = [
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_MANTLE',
] as const;

describe('provider', () => {
  const originalEnv: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    originalEnv[key] = process.env[key];
  }

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key];
      } else {
        delete process.env[key];
      }
    }
  });

  describe('detectProvider', () => {
    it('should return anthropic by default', async () => {
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('anthropic');
    });

    it('should detect z.ai provider', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('zai');
    });

    it('should detect ZHIPU provider', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('zhipu');
    });

    it('should detect bedrock provider via CLAUDE_CODE_USE_BEDROCK=1', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('bedrock');
    });

    it('should detect bedrock provider via CLAUDE_CODE_USE_BEDROCK=true', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = 'true';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('bedrock');
    });

    it('should detect vertex provider via CLAUDE_CODE_USE_VERTEX=1', async () => {
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('vertex');
    });

    it('should detect bedrock provider via CLAUDE_CODE_USE_MANTLE=1', async () => {
      process.env.CLAUDE_CODE_USE_MANTLE = '1';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('bedrock');
    });

    it('should treat CLAUDE_CODE_USE_BEDROCK=0 as falsy (anthropic)', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '0';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('anthropic');
    });

    it('should give env flag precedence over ANTHROPIC_BASE_URL (bedrock wins over z.ai URL)', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
      const { detectProvider } = await import('../utils/provider.js');
      expect(detectProvider()).toBe('bedrock');
    });
  });

  describe('isZaiProvider', () => {
    it('should return false for anthropic', async () => {
      const { isZaiProvider } = await import('../utils/provider.js');
      expect(isZaiProvider()).toBe(false);
    });

    it('should return true for z.ai', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
      const { isZaiProvider } = await import('../utils/provider.js');
      expect(isZaiProvider()).toBe(true);
    });

    it('should return true for ZHIPU', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
      const { isZaiProvider } = await import('../utils/provider.js');
      expect(isZaiProvider()).toBe(true);
    });

    it('should return false for bedrock', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      const { isZaiProvider } = await import('../utils/provider.js');
      expect(isZaiProvider()).toBe(false);
    });

    it('should return false for vertex', async () => {
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      const { isZaiProvider } = await import('../utils/provider.js');
      expect(isZaiProvider()).toBe(false);
    });
  });

  describe('usesAnthropicRateLimits', () => {
    it('should return true for anthropic', async () => {
      const { usesAnthropicRateLimits } = await import('../utils/provider.js');
      expect(usesAnthropicRateLimits()).toBe(true);
    });

    it('should return false for zai', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1';
      const { usesAnthropicRateLimits } = await import('../utils/provider.js');
      expect(usesAnthropicRateLimits()).toBe(false);
    });

    it('should return false for zhipu', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4';
      const { usesAnthropicRateLimits } = await import('../utils/provider.js');
      expect(usesAnthropicRateLimits()).toBe(false);
    });

    it('should return false for bedrock', async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = '1';
      const { usesAnthropicRateLimits } = await import('../utils/provider.js');
      expect(usesAnthropicRateLimits()).toBe(false);
    });

    it('should return false for vertex', async () => {
      process.env.CLAUDE_CODE_USE_VERTEX = '1';
      const { usesAnthropicRateLimits } = await import('../utils/provider.js');
      expect(usesAnthropicRateLimits()).toBe(false);
    });
  });

  describe('getZaiApiBaseUrl', () => {
    it('should return null when no base URL', async () => {
      const { getZaiApiBaseUrl } = await import('../utils/provider.js');
      expect(getZaiApiBaseUrl()).toBeNull();
    });

    it('should extract origin from base URL', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://api.z.ai/v1/messages';
      const { getZaiApiBaseUrl } = await import('../utils/provider.js');
      expect(getZaiApiBaseUrl()).toBe('https://api.z.ai');
    });

    it('should return null for invalid URL', async () => {
      process.env.ANTHROPIC_BASE_URL = 'not-a-url';
      const { getZaiApiBaseUrl } = await import('../utils/provider.js');
      expect(getZaiApiBaseUrl()).toBeNull();
    });
  });
});
