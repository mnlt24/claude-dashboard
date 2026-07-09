/**
 * Provider detection utility
 * Detects whether Claude is running via Anthropic, z.ai, ZHIPU, Amazon Bedrock, or Google Vertex
 * @handbook 7.2-provider-detection
 * @tested scripts/__tests__/provider.test.ts
 */

/**
 * Provider type for API routing
 */
export type ProviderType = 'anthropic' | 'zai' | 'zhipu' | 'bedrock' | 'vertex';

/**
 * Parse a CLAUDE_CODE_USE_* style env flag. Accepts '1' or 'true' (case-insensitive).
 */
function isTruthyFlag(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * Detect current provider based on CLAUDE_CODE_USE_* env flags, then ANTHROPIC_BASE_URL
 */
export function detectProvider(): ProviderType {
  if (isTruthyFlag(process.env.CLAUDE_CODE_USE_BEDROCK) || isTruthyFlag(process.env.CLAUDE_CODE_USE_MANTLE)) {
    return 'bedrock';
  }
  if (isTruthyFlag(process.env.CLAUDE_CODE_USE_VERTEX)) {
    return 'vertex';
  }

  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';

  if (baseUrl.includes('api.z.ai')) {
    return 'zai';
  }
  if (baseUrl.includes('bigmodel.cn')) {
    return 'zhipu';
  }

  return 'anthropic';
}

/**
 * Check if using z.ai or ZHIPU provider
 */
export function isZaiProvider(): boolean {
  const provider = detectProvider();
  return provider === 'zai' || provider === 'zhipu';
}

/**
 * Anthropic 구독(Pro/Max) rate-limit API가 적용되는 provider인지 여부.
 * 직접 Anthropic 인증일 때만 true. z.ai/ZHIPU/Bedrock/Vertex는 별도 과금·라우팅이라
 * Anthropic OAuth usage 데이터가 없음.
 */
export function usesAnthropicRateLimits(): boolean {
  return detectProvider() === 'anthropic';
}

/**
 * Get the z.ai API base URL from ANTHROPIC_BASE_URL
 * Extracts the origin (scheme + host) for quota API calls
 */
export function getZaiApiBaseUrl(): string | null {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) {
    return null;
  }

  try {
    const url = new URL(baseUrl);
    return url.origin;
  } catch {
    return null;
  }
}
