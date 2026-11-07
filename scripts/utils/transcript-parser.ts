/**
 * Transcript parser - parses Claude Code transcript.jsonl files
 * @handbook 4.5-transcript-incremental-parsing
 * @tested scripts/__tests__/transcript-parser.test.ts
 * @tested scripts/__tests__/widgets.test.ts
 * Uses incremental parsing: remembers last byte offset and only parses new content.
 * Running tools, agents, tasks, and todos are tracked incrementally in processEntries()
 * so extract functions read O(1) instead of scanning the full transcript.
 */

import { open, stat, readFile, writeFile, mkdir, rename } from 'fs/promises';
import { createHash } from 'crypto';
import { basename } from 'path';
import { fileCachePath, FILE_CACHE_DIR } from './file-cache.js';
import type { TranscriptEntry, ParsedTranscript, TodoProgressData, WidgetContext, SlashCommandData } from '../types.js';
import { truncate } from './formatters.js';

/**
 * Cached transcript data with incremental parsing state
 */
let cachedTranscript: {
  path: string;
  /** File size at last parse (used as byte offset for next read) */
  size: number;
  data: ParsedTranscript;
} | null = null;

/**
 * Create a fresh ParsedTranscript with all incremental tracking fields initialized.
 */
function createParsedTranscript(): ParsedTranscript {
  return {
    toolUses: new Map(),
    completedToolCount: 0,
    runningToolIds: new Set(),
    lastTodoWriteInput: null,
    activeAgentIds: new Set(),
    completedAgentCount: 0,
    tasks: new Map(),
    nextTaskId: 1,
    pendingTaskCreates: new Map(),
    pendingTaskUpdates: new Map(),
    activeSlashCommand: null,
  };
}

/**
 * Matches `<command-name>/xxx</command-name>` tags injected by Claude Code
 * when a user types a slash command. Captures the full name including the
 * leading slash (e.g. '/superpowers:brainstorming').
 */
const SLASH_COMMAND_TAG_RE = /<command-name>([^<]+)<\/command-name>/;

/**
 * Parse JSONL content into transcript entries, skipping malformed lines
 */
function parseJsonlContent(content: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const line of content.split('\n')) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line) as TranscriptEntry);
    } catch {
      // Skip malformed lines
    }
  }
  return entries;
}

/**
 * Process entries and merge into existing parsed transcript data.
 * Incrementally updates running tools, agents, tasks, and last TodoWrite.
 */
function processEntries(
  entries: TranscriptEntry[],
  existing: ParsedTranscript
): void {
  for (const entry of entries) {
    // Track session start time from first entry
    if (!existing.sessionStartTime && entry.timestamp) {
      existing.sessionStartTime = new Date(entry.timestamp).getTime();
    }

    // Extract session name from /rename command
    if (entry.customTitle) {
      existing.sessionName = entry.customTitle;
    }

    // Extract tool_use blocks
    if (entry.type === 'assistant' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_use' && block.id && block.name) {
          existing.toolUses.set(block.id, {
            name: block.name,
            timestamp: entry.timestamp,
            input: block.input,
          });
          existing.runningToolIds.add(block.id);

          // Track agent (Task) dispatches
          if (block.name === 'Task') {
            existing.activeAgentIds.add(block.id);
          }

          // Track pending TaskCreate/TaskUpdate for deferred application on result
          if (block.name === 'TaskCreate') {
            const input = block.input as { subject?: string; status?: string } | undefined;
            if (input?.subject) {
              const seqId = String(existing.nextTaskId);
              existing.nextTaskId++;
              existing.pendingTaskCreates.set(block.id, {
                subject: input.subject,
                status: normalizeTaskStatus(input.status || 'pending'),
                seqId,
              });
            }
          } else if (block.name === 'TaskUpdate') {
            const input = block.input as { taskId?: string; status?: string; subject?: string } | undefined;
            if (input?.taskId) {
              existing.pendingTaskUpdates.set(block.id, {
                taskId: input.taskId,
                status: input.status,
                subject: input.subject,
              });
            }
          }
        }
      }
    }

    // User entries are visited in two separate blocks (text vs tool_result) instead
    // of one merged loop: text drives slash-command tracking, tool_result drives
    // tool/task lifecycle. Splitting keeps each concern flat and avoids interleaving
    // two state machines.
    //
    // String-form content needs care: Claude Code injects system entries like
    // `<local-command-stdout>` and `<local-command-caveat>` right after a
    // `<command-name>` slash command. Treating those as plain user text would
    // clear the command within milliseconds of setting it. We classify a string
    // payload as (a) command-name capture, (b) genuine plain text, or (c) system
    // lifecycle tag (no state change).
    if (entry.type === 'user' && entry.message?.content !== undefined) {
      const content = entry.message.content;
      let matchedName: string | null = null;
      let hasText = false;

      if (typeof content === 'string') {
        const m = content.match(SLASH_COMMAND_TAG_RE);
        if (m) {
          const name = m[1].trim();
          if (name.startsWith('/')) {
            matchedName = name;
            hasText = true;
          }
        } else {
          const trimmed = content.trim();
          if (trimmed.length > 0 && !trimmed.startsWith('<')) {
            hasText = true;
          }
        }
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'text' || typeof block.text !== 'string') continue;
          hasText = true;
          const m = block.text.match(SLASH_COMMAND_TAG_RE);
          if (m) {
            const name = m[1].trim();
            if (name.startsWith('/')) matchedName = name;
            break;
          }
        }
      }

      if (hasText) {
        existing.activeSlashCommand = matchedName
          ? {
              name: matchedName,
              startTime: entry.timestamp ? new Date(entry.timestamp).getTime() : Date.now(),
            }
          : null;
      }
    }

    // Extract tool_result blocks (they come as user messages with tool_result content)
    if (entry.type === 'user' && Array.isArray(entry.message?.content)) {
      for (const block of entry.message.content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          existing.completedToolCount++;
          existing.runningToolIds.delete(block.tool_use_id);

          // Track agent (Task) completions
          if (existing.activeAgentIds.delete(block.tool_use_id)) {
            existing.completedAgentCount++;
          }

          // Track last completed TodoWrite
          const tool = existing.toolUses.get(block.tool_use_id);
          if (tool?.name === 'TodoWrite') {
            existing.lastTodoWriteInput = tool.input;
          }

          // Apply pending TaskCreate on result
          const pendingCreate = existing.pendingTaskCreates.get(block.tool_use_id);
          if (pendingCreate) {
            existing.tasks.set(pendingCreate.seqId, {
              subject: pendingCreate.subject,
              status: pendingCreate.status,
            });
            existing.pendingTaskCreates.delete(block.tool_use_id);
          }

          // Apply pending TaskUpdate on result
          const pendingUpdate = existing.pendingTaskUpdates.get(block.tool_use_id);
          if (pendingUpdate) {
            const task = existing.tasks.get(pendingUpdate.taskId);
            if (task) {
              if (pendingUpdate.status) task.status = normalizeTaskStatus(pendingUpdate.status);
              if (pendingUpdate.subject) task.subject = pendingUpdate.subject;
            }
            existing.pendingTaskUpdates.delete(block.tool_use_id);
          }

          // Prune completed tool from Map (no longer needed for display)
          existing.toolUses.delete(block.tool_use_id);
        }
      }
    }
  }
}

/** 스트리밍 읽기 청크 크기 (메모리 상한은 청크 + 가장 긴 한 줄) */
const READ_CHUNK_BYTES = 1024 * 1024;
/** 디스크 캐시 검증용으로 offset 바로 앞에서 읽는 바이트 수 */
const TAIL_FINGERPRINT_BYTES = 64;
/** 디스크 캐시 파일 스키마 버전 (ParsedTranscript 구조가 바뀌면 올린다) */
const DISK_CACHE_VERSION = 1;

/**
 * 파싱 결과에 영향 없는 줄을 JSON.parse 전에 걸러낸다.
 * processEntries 는 tool_use/tool_result, customTitle, user 항목, 첫 timestamp 만 본다.
 * (대화 본문뿐인 assistant 줄이 transcript 의 대부분을 차지한다.)
 */
function isRelevantLine(line: string): boolean {
  return (
    line.includes('tool_use') ||
    line.includes('tool_result') ||
    line.includes('customTitle') ||
    line.includes('"user"')
  );
}

/**
 * 파일을 offset 부터 청크 단위로 읽어 줄 단위로 처리한다 (전체를 메모리에 올리지 않는다).
 * 개행으로 끝나지 않은 마지막 줄은 아직 쓰는 중일 수 있어 건드리지 않는다
 * (완결된 JSON 이면 처리). 반환값은 처리를 마친 바이트 offset.
 */
async function streamEntries(
  filePath: string,
  offset: number,
  fileSize: number,
  data: ParsedTranscript
): Promise<number> {
  if (fileSize <= offset) return offset;

  const fd = await open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(READ_CHUNK_BYTES);
    let pos = offset;
    let carry: Buffer[] = [];
    let carryLen = 0;
    let consumed = offset;

    const handleLine = (lineBuf: Buffer): boolean => {
      if (lineBuf.length === 0) return true;
      const line = lineBuf.toString('utf-8');
      // sessionStartTime 은 첫 timestamp 항목에서 정해지므로 그 전까지는 거르지 않는다
      if (data.sessionStartTime && !isRelevantLine(line)) return true;
      try {
        processEntries([JSON.parse(line) as TranscriptEntry], data);
        return true;
      } catch {
        return false; // malformed
      }
    };

    while (pos < fileSize) {
      const want = Math.min(READ_CHUNK_BYTES, fileSize - pos);
      const { bytesRead } = await fd.read(buffer, 0, want, pos);
      if (bytesRead <= 0) break;
      const chunk = buffer.subarray(0, bytesRead);

      let start = 0;
      let nl = chunk.indexOf(0x0a, start);
      while (nl !== -1) {
        const piece = chunk.subarray(start, nl);
        const lineBuf = carryLen > 0 ? Buffer.concat([...carry, piece], carryLen + piece.length) : piece;
        carry = [];
        carryLen = 0;
        handleLine(lineBuf);
        start = nl + 1;
        nl = chunk.indexOf(0x0a, start);
      }
      consumed = pos + start;
      if (start < bytesRead) {
        const rest = Buffer.from(chunk.subarray(start)); // buffer 재사용 전에 복사
        carry.push(rest);
        carryLen += rest.length;
      }
      pos += bytesRead;
    }

    // 개행 없는 마지막 줄: 완결된 JSON 일 때만 처리하고 offset 을 넘긴다
    if (carryLen > 0) {
      const ok = handleLine(Buffer.concat(carry, carryLen));
      if (ok) consumed = pos;
    }
    return consumed;
  } finally {
    await fd.close();
  }
}

/** offset 바로 앞 바이트(hex) — 디스크 캐시가 같은 파일의 앞부분인지 확인하는 지문 */
async function readFingerprint(filePath: string, offset: number): Promise<string> {
  if (offset <= 0) return '';
  const len = Math.min(TAIL_FINGERPRINT_BYTES, offset);
  const fd = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fd.read(buf, 0, len, offset - len);
    return buf.subarray(0, bytesRead).toString('hex');
  } finally {
    await fd.close();
  }
}

interface DiskCacheFile {
  v: number;
  path: string;
  offset: number;
  fingerprint: string;
  data: unknown;
}

function diskCacheFile(transcriptPath: string): string | null {
  if (process.env.CLAUDE_DASHBOARD_NO_TRANSCRIPT_CACHE) return null;
  const key = createHash('sha256').update(transcriptPath).digest('hex').substring(0, 16);
  return fileCachePath(`transcript-state-${key}.json`);
}

function serializeParsed(d: ParsedTranscript): unknown {
  return {
    ...d,
    toolUses: [...d.toolUses],
    runningToolIds: [...d.runningToolIds],
    activeAgentIds: [...d.activeAgentIds],
    tasks: [...d.tasks],
    pendingTaskCreates: [...d.pendingTaskCreates],
    pendingTaskUpdates: [...d.pendingTaskUpdates],
  };
}

function deserializeParsed(raw: any): ParsedTranscript {
  return {
    ...raw,
    toolUses: new Map(raw.toolUses),
    runningToolIds: new Set(raw.runningToolIds),
    activeAgentIds: new Set(raw.activeAgentIds),
    tasks: new Map(raw.tasks),
    pendingTaskCreates: new Map(raw.pendingTaskCreates),
    pendingTaskUpdates: new Map(raw.pendingTaskUpdates),
  };
}

/**
 * 디스크에 저장된 파싱 상태를 읽는다. 상태줄은 호출마다 새 프로세스라 메모리 캐시가
 * 소용없으므로, offset 까지의 상태를 파일로 남겨 다음 실행이 새로 붙은 바이트만 읽게 한다.
 * 파일이 줄었거나 offset 앞 지문이 다르면(다른 파일로 교체) 버린다.
 */
async function loadDiskCache(
  transcriptPath: string,
  fileSize: number
): Promise<{ offset: number; data: ParsedTranscript } | null> {
  const file = diskCacheFile(transcriptPath);
  if (!file) return null;
  try {
    const raw = JSON.parse(await readFile(file, 'utf-8')) as DiskCacheFile;
    if (raw.v !== DISK_CACHE_VERSION || raw.path !== transcriptPath) return null;
    if (!(raw.offset >= 0 && raw.offset <= fileSize)) return null;
    if ((await readFingerprint(transcriptPath, raw.offset)) !== raw.fingerprint) return null;
    return { offset: raw.offset, data: deserializeParsed(raw.data) };
  } catch {
    return null;
  }
}

async function saveDiskCache(
  transcriptPath: string,
  offset: number,
  data: ParsedTranscript
): Promise<void> {
  const file = diskCacheFile(transcriptPath);
  if (!file) return;
  try {
    await mkdir(FILE_CACHE_DIR, { recursive: true });
    const payload: DiskCacheFile = {
      v: DISK_CACHE_VERSION,
      path: transcriptPath,
      offset,
      fingerprint: await readFingerprint(transcriptPath, offset),
      data: serializeParsed(data),
    };
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(payload), 'utf-8');
    await rename(tmp, file);
  } catch {
    // 캐시 실패는 무시 — 다음 실행이 다시 읽을 뿐이다
  }
}

/**
 * Parse transcript JSONL file
 * Uses incremental parsing: only reads new bytes since last parse (in-process
 * memory cache, then cross-process disk cache). Reading is streamed so memory
 * does not scale with transcript size.
 */
export async function parseTranscript(
  transcriptPath: string
): Promise<ParsedTranscript | null> {
  try {
    const fileStat = await stat(transcriptPath);
    const fileSize = fileStat.size;

    // Incremental parse: reuse existing data if file only grew
    if (cachedTranscript?.path === transcriptPath && cachedTranscript.size <= fileSize) {
      if (cachedTranscript.size === fileSize) {
        return cachedTranscript.data;
      }

      cachedTranscript.size = await streamEntries(
        transcriptPath,
        cachedTranscript.size,
        fileSize,
        cachedTranscript.data
      );

      return cachedTranscript.data;
    }

    // 다른 프로세스가 남긴 디스크 캐시에서 이어 읽기 (없으면 처음부터)
    const disk = await loadDiskCache(transcriptPath, fileSize);
    const data = disk?.data ?? createParsedTranscript();
    const startOffset = disk?.offset ?? 0;

    const endOffset = await streamEntries(transcriptPath, startOffset, fileSize, data);

    cachedTranscript = { path: transcriptPath, size: endOffset, data };
    if (endOffset !== startOffset || !disk) {
      await saveDiskCache(transcriptPath, endOffset, data);
    }

    return data;
  } catch {
    return null;
  }
}

/**
 * Extract a human-readable target from a tool's input.
 * Returns the file basename for file tools, pattern for search tools,
 * or truncated command for Bash.
 */
export function extractToolTarget(name: string, input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const inp = input as Record<string, unknown>;
  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return typeof inp.file_path === 'string' ? basename(inp.file_path) : undefined;
    case 'Glob':
    case 'Grep':
      return typeof inp.pattern === 'string' ? truncate(inp.pattern, 20) : undefined;
    case 'Bash':
      return typeof inp.command === 'string' ? truncate(inp.command, 25) : undefined;
    default:
      return undefined;
  }
}

/**
 * Get running tools from incrementally tracked runningToolIds.
 * O(k) where k = number of currently running tools (typically 0-3).
 */
export function getRunningTools(
  transcript: ParsedTranscript
): Array<{ name: string; startTime: number; target?: string }> {
  const running: Array<{ name: string; startTime: number; target?: string }> = [];

  for (const id of transcript.runningToolIds) {
    const tool = transcript.toolUses.get(id);
    if (!tool) continue;
    running.push({
      name: tool.name,
      startTime: tool.timestamp
        ? new Date(tool.timestamp).getTime()
        : Date.now(),
      target: extractToolTarget(tool.name, tool.input),
    });
  }

  return running;
}

/**
 * Get completed tool count
 */
export function getCompletedToolCount(transcript: ParsedTranscript): number {
  return transcript.completedToolCount;
}

/**
 * Normalize task/todo status variants to canonical values.
 * Maps upstream API variants (not_started, running, done, complete)
 * to the canonical set used in TodoProgressData.
 */
export function normalizeTaskStatus(status: string): string {
  switch (status) {
    case 'not_started':
      return 'pending';
    case 'running':
      return 'in_progress';
    case 'complete':
    case 'done':
      return 'completed';
    default:
      return status;
  }
}

/**
 * Extract TodoWrite progress from incrementally tracked lastTodoWriteInput.
 * O(t) where t = number of todos in the last TodoWrite (typically <20).
 */
export function extractTodoProgress(
  transcript: ParsedTranscript
): {
  current?: { content: string; status: 'in_progress' | 'pending' };
  completed: number;
  total: number;
} | null {
  const lastTodoWrite = transcript.lastTodoWriteInput;
  if (!lastTodoWrite || typeof lastTodoWrite !== 'object') {
    return null;
  }

  const input = lastTodoWrite as { todos?: Array<{ content: string; status: string }> };
  if (!Array.isArray(input.todos)) {
    return null;
  }

  const todos = input.todos;
  const completed = todos.filter((t) => normalizeTaskStatus(t.status) === 'completed').length;
  const total = todos.length;
  const current = todos.find((t) => {
    const s = normalizeTaskStatus(t.status);
    return s === 'in_progress' || s === 'pending';
  });

  return {
    current: current
      ? {
          content: current.content,
          status: normalizeTaskStatus(current.status) as 'in_progress' | 'pending',
        }
      : undefined,
    completed,
    total,
  };
}

/**
 * Extract task progress from incrementally tracked tasks Map.
 * O(t) where t = number of tasks (typically <20).
 */
export function extractTaskProgress(
  transcript: ParsedTranscript
): TodoProgressData | null {
  if (transcript.tasks.size === 0) return null;

  const all = [...transcript.tasks.values()];
  const completed = all.filter((t) => t.status === 'completed').length;
  const current = all.find(
    (t) => t.status === 'in_progress' || t.status === 'pending'
  );

  return {
    current: current
      ? { content: current.subject, status: current.status as 'in_progress' | 'pending' }
      : undefined,
    completed,
    total: all.length,
  };
}

/**
 * Unified progress extractor: Tasks API (TaskCreate/TaskUpdate) first,
 * falls back to TodoWrite for backward compatibility.
 */
export function extractTodoOrTaskProgress(
  transcript: ParsedTranscript
): TodoProgressData | null {
  return extractTaskProgress(transcript) ?? extractTodoProgress(transcript);
}

/**
 * Convenience helper: get parsed transcript from widget context.
 * Eliminates the repeated null-check boilerplate in widget getData methods.
 */
export async function getTranscript(ctx: WidgetContext): Promise<ParsedTranscript | null> {
  const transcriptPath = ctx.stdin.transcript_path;
  if (!transcriptPath) return null;
  return parseTranscript(transcriptPath);
}

/**
 * Extract agent status from incrementally tracked fields.
 * O(a) where a = number of active agents (typically 0-5).
 */
export function extractAgentStatus(
  transcript: ParsedTranscript
): {
  active: Array<{ name: string; description?: string }>;
  completed: number;
} {
  const active: Array<{ name: string; description?: string }> = [];

  for (const id of transcript.activeAgentIds) {
    const tool = transcript.toolUses.get(id);
    if (!tool) continue;
    const input = tool.input as {
      description?: string;
      subagent_type?: string;
    } | undefined;
    active.push({
      name: input?.subagent_type || 'Agent',
      description: input?.description,
    });
  }

  return { active, completed: transcript.completedAgentCount };
}

/**
 * Return the slash command active for the current turn, or null if the
 * user's last input was plain text. O(1) — value tracked in processEntries.
 */
export function getActiveSlashCommand(
  transcript: ParsedTranscript
): SlashCommandData | null {
  return transcript.activeSlashCommand;
}
