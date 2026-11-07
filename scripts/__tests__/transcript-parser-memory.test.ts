/**
 * transcript 가 커도 파싱 메모리가 크기에 비례하지 않는지, 디스크 캐시가 같은 결과를 내는지 확인한다.
 * @covers scripts/utils/transcript-parser.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, rm, writeFile, appendFile, open } from 'fs/promises';
import path from 'path';
import os from 'os';

const DIR = path.join(os.tmpdir(), 'claude-dashboard-transcript-mem-test');
const FILE = path.join(DIR, 'big.jsonl');
const CACHE_DIR = path.join(DIR, 'home');

describe('transcript-parser memory / disk cache', () => {
  beforeEach(async () => {
    vi.resetModules();
    await mkdir(DIR, { recursive: true });
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(DIR, { recursive: true, force: true });
  });

  it('합성 대용량 transcript 도 최대 RSS 증가가 파일 크기에 비례하지 않는다', async () => {
    const TARGET_BYTES = 200 * 1024 * 1024;
    const filler = 'x'.repeat(8000);
    const fd = await open(FILE, 'w');
    let written = 0;
    let i = 0;
    const startLine = JSON.stringify({ type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: 'hi' } }) + '\n';
    await fd.write(startLine);
    while (written < TARGET_BYTES) {
      let batch = '';
      for (let k = 0; k < 500; k++, i++) {
        const text = JSON.stringify({
          type: 'assistant',
          timestamp: '2024-01-01T00:00:01Z',
          message: { content: [{ type: 'text', text: filler }] },
        });
        batch += text + '\n';
        if (i % 50 === 0) {
          batch +=
            JSON.stringify({
              type: 'assistant',
              timestamp: '2024-01-01T00:00:02Z',
              message: { content: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: '/a/b.ts' } }] },
            }) +
            '\n' +
            JSON.stringify({
              type: 'user',
              timestamp: '2024-01-01T00:00:03Z',
              message: { content: [{ type: 'tool_result', tool_use_id: `t${i}` }] },
            }) +
            '\n';
        }
      }
      written += batch.length;
      await fd.write(batch);
    }
    await fd.close();

    vi.stubEnv('CLAUDE_DASHBOARD_NO_TRANSCRIPT_CACHE', '1');
    const { parseTranscript } = await import('../utils/transcript-parser.js');
    const before = process.resourceUsage().maxRSS; // KB
    const data = await parseTranscript(FILE);
    const growthMb = (process.resourceUsage().maxRSS - before) / 1024;

    expect(data).not.toBeNull();
    expect(data!.completedToolCount).toBeGreaterThan(0);
    expect(data!.runningToolIds.size).toBe(0);
    // 전체를 읽으면 200MB 파일 → 수백 MB~GB. 스트리밍이면 청크(1MB) 수준.
    expect(growthMb).toBeLessThan(120);
  }, 120_000);

  it('디스크 캐시로 이어 읽은 결과가 처음부터 읽은 결과와 같다', async () => {
    const entries = [
      { type: 'user', timestamp: '2024-01-01T00:00:00Z', message: { content: '<command-name>/foo</command-name>' } },
      {
        type: 'assistant',
        timestamp: '2024-01-01T00:00:01Z',
        message: { content: [{ type: 'tool_use', id: 'a1', name: 'Task', input: { subagent_type: 'x' } }] },
      },
      { customTitle: 'my-session' },
    ];
    await writeFile(FILE, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf-8');

    vi.stubEnv('HOME', CACHE_DIR);
    vi.stubEnv('CLAUDE_DASHBOARD_NO_TRANSCRIPT_CACHE', '');
    const m1 = await import('../utils/transcript-parser.js');
    const first = await m1.parseTranscript(FILE);
    expect(first!.activeAgentIds.has('a1')).toBe(true);

    // 파일에 이어 붙이고, 새 프로세스를 흉내 내 모듈을 다시 불러온다 (메모리 캐시 없음)
    await appendFile(
      FILE,
      JSON.stringify({
        type: 'user',
        timestamp: '2024-01-01T00:00:05Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'a1' }] },
      }) + '\n',
      'utf-8'
    );
    vi.resetModules();
    const m2 = await import('../utils/transcript-parser.js');
    const second = await m2.parseTranscript(FILE);

    vi.stubEnv('CLAUDE_DASHBOARD_NO_TRANSCRIPT_CACHE', '1');
    vi.resetModules();
    const m3 = await import('../utils/transcript-parser.js');
    const fresh = await m3.parseTranscript(FILE);

    expect(second!.completedAgentCount).toBe(1);
    expect(second!.sessionName).toBe('my-session');
    expect(second!.sessionStartTime).toBe(fresh!.sessionStartTime);
    expect(second!.completedToolCount).toBe(fresh!.completedToolCount);
    expect(second!.completedAgentCount).toBe(fresh!.completedAgentCount);
    expect([...second!.activeAgentIds]).toEqual([...fresh!.activeAgentIds]);
    expect(second!.activeSlashCommand).toEqual(fresh!.activeSlashCommand);
  });
});
