import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['scripts/__tests__/**/*.test.ts'],
    // 기존 시험이 ~/.cache 에 transcript 상태 파일을 남기지 않게 한다 (전용 시험만 켠다)
    env: { CLAUDE_DASHBOARD_NO_TRANSCRIPT_CACHE: '1' },
  },
  define: {
    __VERSION__: JSON.stringify('test'),
  },
});
