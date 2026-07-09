/**
 * Rate limit widgets - displays 5h and 7d usage limits
 * @handbook 6.2-stale-while-error
 * Note: These widgets return null for non-Anthropic providers
 * (z.ai/ZHIPU/Bedrock/Vertex) which don't use Anthropic subscription rate limits.
 * z.ai/ZHIPU show the zaiUsage widget instead; Bedrock/Vertex show nothing in its place.
 * @handbook 3.3-widget-data-sources
 * @handbook 7.2-provider-detection
 * @tested scripts/__tests__/rate-limit.test.ts
 */

import type { Widget } from './base.js';
import type { WidgetContext, RateLimitData, UsageLimits } from '../types.js';
import { getColorForPercent, colorize, getTheme } from '../utils/colors.js';
import { ICON } from '../utils/emoji.js';
import { formatTimeRemaining } from '../utils/formatters.js';
import { usesAnthropicRateLimits } from '../utils/provider.js';

type LabelKey = '5h' | '7d_all' | '7d_sonnet';
type LimitKey = keyof UsageLimits;

function renderRateLimit(data: RateLimitData, ctx: WidgetContext, labelKey: LabelKey): string {
  if (data.isError) {
    return colorize(ICON.warning, getTheme().warning);
  }

  const { translations: t } = ctx;
  const color = getColorForPercent(data.utilization);
  const label = `${t.labels[labelKey]}: ${colorize(`${data.utilization}%`, color)}`;

  if (!data.resetsAt) return label;
  return `${label} (${formatTimeRemaining(data.resetsAt, t)})`;
}

function getLimitData(limits: UsageLimits | null | undefined, key: LimitKey): RateLimitData | null {
  const limit = limits?.[key];
  if (!limit) return null;

  return {
    utilization: Math.round(limit.utilization),
    resetsAt: limit.resets_at,
  };
}

/**
 * Check if Anthropic rate limits should be hidden (non-Anthropic providers
 * — z.ai/ZHIPU/Bedrock/Vertex — use different quota systems or none at all)
 */
function shouldHideAnthropicLimits(): boolean {
  return !usesAnthropicRateLimits();
}

/**
 * 5-hour rate limit widget
 */
export const rateLimit5hWidget: Widget<RateLimitData> = {
  id: 'rateLimit5h',
  name: '5h Rate Limit',

  async getData(ctx: WidgetContext): Promise<RateLimitData | null> {
    if (shouldHideAnthropicLimits()) return null;
    const data = getLimitData(ctx.rateLimits, 'five_hour');
    // Show warning if API failed (only in this widget to avoid duplicates)
    return data ?? { utilization: 0, resetsAt: null, isError: true };
  },

  render(data: RateLimitData, ctx: WidgetContext): string {
    return renderRateLimit(data, ctx, '5h');
  },
};

/**
 * 7-day rate limit widget (Pro and Max plans)
 */
export const rateLimit7dWidget: Widget<RateLimitData> = {
  id: 'rateLimit7d',
  name: '7d Rate Limit',

  async getData(ctx: WidgetContext): Promise<RateLimitData | null> {
    if (shouldHideAnthropicLimits()) return null;
    return getLimitData(ctx.rateLimits, 'seven_day');
  },

  render(data: RateLimitData, ctx: WidgetContext): string {
    return renderRateLimit(data, ctx, '7d_all');
  },
};

/**
 * 7-day Sonnet-only rate limit widget (Max plan only)
 */
export const rateLimit7dSonnetWidget: Widget<RateLimitData> = {
  id: 'rateLimit7dSonnet',
  name: '7d Sonnet Rate Limit',

  async getData(ctx: WidgetContext): Promise<RateLimitData | null> {
    if (shouldHideAnthropicLimits()) return null;
    if (ctx.config.plan !== 'max') return null;
    return getLimitData(ctx.rateLimits, 'seven_day_sonnet');
  },

  render(data: RateLimitData, ctx: WidgetContext): string {
    return renderRateLimit(data, ctx, '7d_sonnet');
  },
};
