/**
 * statusline-resolver.mjs 단위 테스트
 *
 * 검증 대상:
 *  - sortVersionsDesc: semver 내림차순 정렬
 *  - resolveLatestDist: 최신 dist/index.js 경로 탐색
 *    - 정상 케이스: 여러 버전 중 최고 semver 선택
 *    - base 디렉터리 부재 시 graceful(null 반환)
 *    - dist 파일이 없는 버전은 스킵
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sortVersionsDesc, resolveLatestDist } from '../statusline-resolver.mjs';

// --- sortVersionsDesc ---

describe('sortVersionsDesc', () => {
  it('높은 버전이 앞에 온다', () => {
    const input = ['1.2.3', '1.10.0', '2.0.0', '0.9.9'];
    expect(sortVersionsDesc(input)[0]).toBe('2.0.0');
  });

  it('마이너 버전을 numeric 비교한다 (1.9 < 1.10)', () => {
    const sorted = sortVersionsDesc(['1.9.0', '1.10.0', '1.2.0']);
    expect(sorted).toEqual(['1.10.0', '1.9.0', '1.2.0']);
  });

  it('패치 버전을 numeric 비교한다', () => {
    const sorted = sortVersionsDesc(['1.0.9', '1.0.10', '1.0.2']);
    expect(sorted).toEqual(['1.0.10', '1.0.9', '1.0.2']);
  });

  it('단일 버전은 그대로 반환', () => {
    expect(sortVersionsDesc(['1.2.3'])).toEqual(['1.2.3']);
  });

  it('빈 배열은 빈 배열 반환', () => {
    expect(sortVersionsDesc([])).toEqual([]);
  });

  it('원본 배열을 변경하지 않는다', () => {
    const original = ['2.0.0', '1.0.0'];
    sortVersionsDesc(original);
    expect(original).toEqual(['2.0.0', '1.0.0']);
  });
});

// --- resolveLatestDist ---

describe('resolveLatestDist', () => {
  let baseDir: string;

  beforeEach(() => {
    baseDir = join(tmpdir(), `resolver-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(() => {
    if (existsSync(baseDir)) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  function createVersion(ver: string, withDist = true) {
    const distDir = join(baseDir, ver, 'dist');
    mkdirSync(distDir, { recursive: true });
    if (withDist) {
      writeFileSync(join(distDir, 'index.js'), `// mock dist ${ver}`);
    }
  }

  it('base 디렉터리 부재 시 null 반환', () => {
    expect(resolveLatestDist('/nonexistent/path/xyz')).toBeNull();
  });

  it('버전 디렉터리가 없으면 null 반환', () => {
    mkdirSync(baseDir, { recursive: true });
    expect(resolveLatestDist(baseDir)).toBeNull();
  });

  it('dist/index.js가 없는 버전은 스킵하고 null 반환', () => {
    createVersion('1.0.0', false); // dist 없음
    expect(resolveLatestDist(baseDir)).toBeNull();
  });

  it('단일 버전에서 올바른 경로 반환', () => {
    createVersion('1.5.0');
    const result = resolveLatestDist(baseDir);
    expect(result).toBe(join(baseDir, '1.5.0', 'dist', 'index.js'));
  });

  it('여러 버전 중 최고 semver를 선택한다', () => {
    createVersion('1.2.0');
    createVersion('1.10.0');
    createVersion('2.0.0');
    createVersion('1.9.0');
    const result = resolveLatestDist(baseDir);
    expect(result).toBe(join(baseDir, '2.0.0', 'dist', 'index.js'));
  });

  it('최신 버전에 dist 없으면 다음 버전으로 폴백한다', () => {
    createVersion('2.0.0', false); // dist 없음 (부분 설치 시뮬레이션)
    createVersion('1.29.0');
    createVersion('1.5.0');
    const result = resolveLatestDist(baseDir);
    expect(result).toBe(join(baseDir, '1.29.0', 'dist', 'index.js'));
  });

  it('semver 아닌 디렉터리는 무시한다', () => {
    mkdirSync(join(baseDir, 'latest', 'dist'), { recursive: true });
    writeFileSync(join(baseDir, 'latest', 'dist', 'index.js'), '// ignored');
    mkdirSync(join(baseDir, '.cache'), { recursive: true });
    createVersion('1.0.0');
    const result = resolveLatestDist(baseDir);
    expect(result).toBe(join(baseDir, '1.0.0', 'dist', 'index.js'));
  });

  it('prerelease 디렉터리(2.0.0-beta.1)는 무시한다 ($ 앵커)', () => {
    // 2.0.0-beta.1 은 /^\d+\.\d+\.\d+$/ 에 매칭되지 않아야 한다
    const prereleaseDir = join(baseDir, '2.0.0-beta.1', 'dist');
    mkdirSync(prereleaseDir, { recursive: true });
    writeFileSync(join(prereleaseDir, 'index.js'), '// prerelease');
    createVersion('1.29.0');
    const result = resolveLatestDist(baseDir);
    // prerelease가 아닌 안정 버전 1.29.0을 선택해야 한다
    expect(result).toBe(join(baseDir, '1.29.0', 'dist', 'index.js'));
  });

  it('비표준 디렉터리(v2.0.0 접두사)는 무시한다', () => {
    const vPrefixDir = join(baseDir, 'v2.0.0', 'dist');
    mkdirSync(vPrefixDir, { recursive: true });
    writeFileSync(join(vPrefixDir, 'index.js'), '// v-prefixed');
    createVersion('1.5.0');
    const result = resolveLatestDist(baseDir);
    expect(result).toBe(join(baseDir, '1.5.0', 'dist', 'index.js'));
  });
});
