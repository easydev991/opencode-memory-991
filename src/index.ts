import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { join } from "node:path";

import { type MemoryType, parseFrontmatter } from "./frontmatter";
import { logMemory } from "./log";
import { redactCredentials } from "./redaction";
import { atomicWriteText } from "./storage";

/** Имя индексного файла в каталоге памяти (specs/memory-storage: «Формат файлов и индекса»). */
export const MEMORY_INDEX_FILE_NAME = "MEMORY.md";

/** Лимит строк собранного индекса; превышение включает бюджетную адмиссию и финальный маркер. */
export const INDEX_MAX_LINES = 200;

/** Лимит символов собранного индекса (UTF-16 code units, как в zcode index-content.ts). */
export const INDEX_MAX_CHARS = 25_000;

/** Порог stale-пометки в днях по типу памяти; отсутствие типа (feedback) — никогда не помечается. */
export const STALE_THRESHOLD_DAYS: Partial<Record<MemoryType, number>> = {
  project: 60,
  user: 90,
  reference: 90,
};

const DAY_MS = 86_400_000;

/**
 * Карантин повреждённого файла: переименование в *.corrupt-<ts>-<pid>-<uuid>, чтобы он
 * остался различимым для пользователя и не попадал в последующие сборки
 * (specs/memory-storage: «Tolerant чтение повреждённых файлов»; паттерн — src/storage.ts:16-25).
 */
async function quarantineCorruptFile(path: string): Promise<string | null> {
  const quarantinePath = `${path}.corrupt-${Date.now()}-${process.pid}-${randomUUID()}`;
  try {
    await rename(path, quarantinePath);
    return quarantinePath;
  } catch {
    return null;
  }
}

function truncationMarker(shown: number, total: number): string {
  return `> Index truncated: kept ${shown} of ${total} memories (limit ${INDEX_MAX_LINES} lines / ${INDEX_MAX_CHARS} chars).`;
}

// Резерв под «\n» + финальный маркер обрезки при символьном усечении: длина маркера с
// четырёхзначными счётчиками плюс запас. Итоговый контент с маркером остаётся в лимите,
// пока счётчики умещаются в четыре цифры (маркер растёт медленнее усечённого текста).
const MARKER_RESERVE_CHARS = truncationMarker(9999, 9999).length + 2;

interface IndexEntry {
  line: string;
  name: string;
  guaranteed: boolean;
  mtimeMs: number;
}

/**
 * Пересобирает MEMORY.md из *.md-файлов каталога памяти и атомарно записывает его
 * (atomicWriteText; вызова под кросс-процессным локом — ответственность вызывающей
 * записи, tasks 5.2). Возвращает собранный текст.
 *
 * Контракты specs/memory-storage: одна строка «- [Title](file.md) — hook» на файл
 * (hook = description, переносы схлопнуты в пробелы, редакция секретов применяется
 * повторно); порядок — сначала гарантированные user/feedback, затем остальные
 * новейшими-первыми по mtime (design Decision 3); при превышении INDEX_MAX_LINES /
 * INDEX_MAX_CHARS — бюджетная адмиссия и одна финальная строка-маркер, входящая в
 * лимиты, с усечением, безопасным для суррогатных пар; памяти старше порога типа
 * получают пометку «[N d old, verify]» (feedback не помечается); повреждённые
 * (невалидный frontmatter) файлы перемещаются в карантин *.corrupt-…, неполные
 * (frontmatter без name/description) пропускаются — без падения сборки.
 */
export async function rebuildMemoryIndex(memoryDir: string): Promise<string> {
  const entries = await collectEntries(memoryDir);
  const content = buildIndexContent(entries);
  await atomicWriteText(join(memoryDir, MEMORY_INDEX_FILE_NAME), content);
  return content;
}

async function collectEntries(memoryDir: string): Promise<IndexEntry[]> {
  let files: Dirent[];
  try {
    files = await readdir(memoryDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const now = Date.now();
  const entries: IndexEntry[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith(".md") || file.name === MEMORY_INDEX_FILE_NAME) {
      continue;
    }
    const path = join(memoryDir, file.name);
    let source: string;
    try {
      source = await readFile(path, "utf8");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logMemory(`index: файл ${file.name} не читается, пропущен: ${message}`);
      continue;
    }
    try {
      const parsed = parseFrontmatter(source);
      const name = parsed.name?.trim();
      const description = parsed.description?.trim();
      if (!name || !description) {
        logMemory(`index: в ${file.name} нет name/description, пропущен`);
        continue;
      }
      const mtimeMs = (await stat(path)).mtimeMs;
      const hook = formatHook(description);
      entries.push({
        line: entryLine(name, file.name, hook, parsed.type, now, mtimeMs),
        name,
        guaranteed: parsed.type === "user" || parsed.type === "feedback",
        mtimeMs,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const quarantinePath = await quarantineCorruptFile(path);
      logMemory(
        quarantinePath
          ? `index: повреждённый frontmatter в ${file.name}, перемещён в карантин ${quarantinePath}: ${message}`
          : `index: повреждённый frontmatter в ${file.name}, пропуск без карантина: ${message}`,
      );
    }
  }
  return sortEntries(entries);
}

/**
 * Hook строки индекса из description: переносы схлопываются в пробелы (specs/memory-storage:
 * «сведённое к одной строке»), секреты редактируются повторно — защита от ручных правок
 * файлов в обход memory_save (design Decision 7).
 */
export function formatHook(description: string): string {
  return redactCredentials(description.replace(/\r\n?|\n/g, " ")).trim();
}

function sortEntries(entries: IndexEntry[]): IndexEntry[] {
  return [...entries].sort((a, b) => {
    if (a.guaranteed !== b.guaranteed) return a.guaranteed ? -1 : 1;
    if (a.mtimeMs !== b.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
}

function entryLine(
  name: string,
  fileName: string,
  hook: string,
  type: MemoryType | undefined,
  now: number,
  mtimeMs: number,
): string {
  return `- [${name}](${fileName}) — ${hook}${staleSuffix(type, now, mtimeMs)}`;
}

function staleSuffix(type: MemoryType | undefined, now: number, mtimeMs: number): string {
  const thresholdDays = type === undefined ? undefined : STALE_THRESHOLD_DAYS[type];
  if (thresholdDays === undefined) return "";
  const ageDays = Math.floor((now - mtimeMs) / DAY_MS);
  return ageDays > thresholdDays ? ` [${ageDays} d old, verify]` : "";
}

function buildIndexContent(entries: IndexEntry[]): string {
  const lines = entries.map((entry) => entry.line);
  if (lines.length === 0) return "";
  if (lines.length <= INDEX_MAX_LINES && contentLength(lines) <= INDEX_MAX_CHARS) {
    return `${lines.join("\n")}\n`;
  }

  // Бюджетная адмиссия (design Decision 3): гарантированные user/feedback стоят первыми
  // в порядке отображения, поэтому усечение с хвоста задевает их последними; факт
  // обрезки — одна финальная строка-маркер, без per-entry пометок.
  let kept = lines.slice(0, INDEX_MAX_LINES - 1);
  const text = kept.join("\n");
  const candidateMarker = truncationMarker(kept.length, lines.length);
  if (text.length + candidateMarker.length + 2 > INDEX_MAX_CHARS) {
    kept = cutToCharBudget(kept, INDEX_MAX_CHARS - MARKER_RESERVE_CHARS);
  }
  const marker = truncationMarker(kept.length, lines.length);
  return `${[...kept, marker].join("\n")}\n`;
}

/** Символьное усечение по границе строки; без переводов строк — рез посреди записи, но не пары. */
function cutToCharBudget(lines: string[], available: number): string[] {
  const cut = dropTrailingHighSurrogate(lines.join("\n").slice(0, available));
  const lastNewline = cut.lastIndexOf("\n");
  if (lastNewline <= 0) return [cut];
  return cut.slice(0, lastNewline).split("\n");
}

function contentLength(lines: string[]): number {
  // Длина финального контента: строки, «\n» между ними и финальный «\n».
  return lines.reduce((sum, line) => sum + line.length, 0) + lines.length;
}

/** Удаляет висячий хай-суррогат с хвоста реза (иначе utf8-запись даёт U+FFFD). */
export function dropTrailingHighSurrogate(text: string): string {
  const last = text.charCodeAt(text.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? text.slice(0, -1) : text;
}
