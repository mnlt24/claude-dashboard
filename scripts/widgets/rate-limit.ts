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
import type { WidgetContext, RateLimitData, UsageLimits, Config } from '../types.js';
import { getColorForPercent, colorize, getTheme } from '../utils/colors.js';
import { ICON } from '../utils/emoji.js';
import { formatTimeRemaining } from '../utils/formatters.js';
import { usesAnthropicRateLimits } from '../utils/provider.js';

type LabelKey = '5h' | '7d_all' | '7d_sonnet' | '7d_fable';
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
 * 모델별 7일 한도(Sonnet/Fable) 버킷을 노출하는 플랜인지 여부 (Max/Ultra)
 */
export function hasModelScopedWeeklyLimits(plan: Config['plan']): boolean {
  return plan === 'max' || plan === 'ultra';
}

/**
 * 5-hour rate limit widget
 */
export const rateLimit5hWidget: Widget<RateLimitData> = {
  id: 'rateLimit5h',
  name: '5h Rate Limit',

  async getData(ctx: WidgetContext): Promise<RateLimitData | null> {
    if (shouldHideAnthropicLimits()) return null;
    const limits = ctx.rateLimits;
    const data = getLimitData(limits, 'five_hour');
    if (data) return data;
    // five_hour만 null이고 다른 버킷 값이 있으면 5h 한도가 없는 계정(검증된 Ultra) → 오류 아님, 숨김.
    // 모든 버킷이 null(조회 실패·빈 응답·stdin 누락)이면 경고 (중복 방지를 위해 이 위젯에서만)
    const hasOtherLimits = !!(limits?.seven_day || limits?.seven_day_sonnet || limits?.seven_day_fable);
    return hasOtherLimits ? null : { utilization: 0, resetsAt: null, isError: true };
  },

  render(data: RateLimitData, ctx: WidgetContext): string {
    return renderRateLimit(data, ctx, '5h');
  },
};

/**
 * 7-day rate limit widget (Pro, Max, Ultra plans)
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
 * 7-day Sonnet-only rate limit widget (Max/Ultra)
 */
export const rateLimit7dSonnetWidget: Widget<RateLimitData> = {
  id: 'rateLimit7dSonnet',
  name: '7d Sonnet Rate Limit',

  async getData(ctx: WidgetContext): Promise<RateLimitData | null> {
    if (shouldHideAnthropicLimits()) return null;
    if (!hasModelScopedWeeklyLimits(ctx.config.plan)) return null;
    return getLimitData(ctx.rateLimits, 'seven_day_sonnet');
  },

  render(data: RateLimitData, ctx: WidgetContext): string {
    return renderRateLimit(data, ctx, '7d_sonnet');
  },
};

/**
 * 7-day Fable-only rate limit widget (Max/Ultra) — API `limits[]`
 * weekly_scoped 버킷 기반
 */
export const rateLimit7dFableWidget: Widget<RateLimitData> = {
  id: 'rateLimit7dFable',
  name: '7d Fable Rate Limit',

  async getData(ctx: WidgetContext): Promise<RateLimitData | null> {
    if (shouldHideAnthropicLimits()) return null;
    if (!hasModelScopedWeeklyLimits(ctx.config.plan)) return null;
    return getLimitData(ctx.rateLimits, 'seven_day_fable');
  },

  render(data: RateLimitData, ctx: WidgetContext): string {
    return renderRateLimit(data, ctx, '7d_fable');
  },
};
