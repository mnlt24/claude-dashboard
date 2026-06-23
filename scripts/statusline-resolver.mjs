#!/usr/bin/env node
/**
 * statusline-resolver.mjs
 *
 * 자가치유(self-healing) 리졸버: 런타임에 최신 설치 버전을 탐색해 실행한다.
 * settings.json의 statusLine.command에 절대 버전 경로 대신 이 파일을 지정하면
 * 플러그인 업데이트 후에도 경로가 깨지지 않는다.
 *
 * 동작:
 *  1. ~/.claude/plugins/cache/claude-dashboard/claude-dashboard/ 아래에서
 *     semver 디렉터리(x.y.z)를 내림차순으로 순회
 *  2. 처음으로 <ver>/dist/index.js가 존재하는 경로를 선택
 *  3. spawnSync(node, [target], { stdio: 'inherit' })로 실행
 *     (ESM 포맷 + main() 자동호출 구조이므로 자식 프로세스로 직접 실행 필요)
 *  4. 플러그인 미설치 등 오류 시 graceful 종료(exit 0, 출력 없음)
 *
 * 단일 소스: ~/.claude/claude-dashboard-statusline.mjs 는 이 파일을
 * 캐시에서 node 크로스플랫폼 복사로 설치한다 (setup.md Step 3a 참조).
 */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';

/**
 * semver 내림차순 정렬: 높은 버전이 앞에 온다.
 * @param {string[]} versions - ['1.2.3', '1.10.0', '2.0.0'] 등
 * @returns {string[]}
 */
export function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) =>
    b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * 캐시 base 디렉터리에서 최신 dist/index.js 경로를 반환한다.
 * 없으면 null.
 * @param {string} baseDir
 * @returns {string | null}
 */
export function resolveLatestDist(baseDir) {
  if (!existsSync(baseDir)) return null;

  let entries;
  try {
    entries = readdirSync(baseDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const versions = entries
    .filter((e) => e.isDirectory() && /^\d+\.\d+\.\d+$/.test(e.name))
    .map((e) => e.name);

  for (const ver of sortVersionsDesc(versions)) {
    const candidate = join(baseDir, ver, 'dist', 'index.js');
    if (existsSync(candidate)) return candidate;
  }

  return null;
}

// --- 엔트리포인트: 직접 실행 시에만 동작 (import로 불러올 때는 실행 안 함) ---
// pathToFileURL을 사용해 Windows 드라이브레터/역슬래시도 정확히 처리한다 (크로스플랫폼 표준 관용구).
import { pathToFileURL } from 'node:url';

const _isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (_isMain) {
  const BASE_DIR = join(
    homedir(),
    '.claude',
    'plugins',
    'cache',
    'claude-dashboard',
    'claude-dashboard'
  );

  const target = resolveLatestDist(BASE_DIR);

  if (!target) {
    // 플러그인 미설치 또는 dist 없음 → statusline 공백(크래시보다 낫다)
    process.exit(0);
  }

  spawnSync(process.execPath, [target], { stdio: 'inherit' });
  // statusline은 비정상 종료 코드를 표면화하면 안 된다 — 터미널 프롬프트 오염 방지.
  process.exit(0);
}
