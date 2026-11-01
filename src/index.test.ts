import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type MemoryType, serializeFrontmatter } from "./frontmatter";
import {
  formatHook,
  INDEX_MAX_CHARS,
  INDEX_MAX_LINES,
  MEMORY_INDEX_FILE_NAME,
  rebuildMemoryIndex,
  STALE_THRESHOLD_DAYS,
} from "./index";

// Строгий TDD (tasks 4.1): сборка MEMORY.md по контрактам спеки memory-storage.
// Возраст памятей контролируется utimes (без sleep); содержимое проверяется по записанному
// файлу — сборщик обязан атомарно писать MEMORY.md и возвращать собранный текст.

const DAY_MS = 86_400_000;

async function makeMemoryDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

async function writeMemory(
  dir: string,
  name: string,
  description: string,
  type: MemoryType,
  mtime?: Date,
): Promise<void> {
  const file = join(dir, `${name}.md`);
  await writeFile(
    file,
    serializeFrontmatter({ name, description, type }, `Тело [[${name}]].\n`),
    "utf8",
  );
  if (mtime !== undefined) {
    await utimes(file, mtime, mtime);
  }
}

function entryLines(content: string): string[] {
  return content.split("\n").filter((line) => line.startsWith("- ["));
}

function truncatedMarkerText(shown: number, total: number): string {
  return `> Index truncated: kept ${shown} of ${total} memories (limit ${INDEX_MAX_LINES} lines / ${INDEX_MAX_CHARS} chars).`;
}

describe("rebuildMemoryIndex: константы контракта", () => {
  test("лимиты индекса и имя файла зафиксированы именованными константами", () => {
    expect(INDEX_MAX_LINES).toBe(200);
    expect(INDEX_MAX_CHARS).toBe(25_000);
    expect(MEMORY_INDEX_FILE_NAME).toBe("MEMORY.md");
  });

  test("пороги stale в днях: project 60, user/reference 90, feedback никогда", () => {
    expect(STALE_THRESHOLD_DAYS.project).toBe(60);
    expect(STALE_THRESHOLD_DAYS.user).toBe(90);
    expect(STALE_THRESHOLD_DAYS.reference).toBe(90);
    expect(STALE_THRESHOLD_DAYS.feedback).toBeUndefined();
  });
});

describe("rebuildMemoryIndex: формат строки индекса", () => {
  test("одна строка «- [Title](file.md) — hook» на файл; атомарно записанный файл равен ответу", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-format-");
    try {
      await writeMemory(dir, "login-flow", "Как устроен логин в приложении", "project");
      const content = await rebuildMemoryIndex(dir);

      expect(content).toBe("- [login-flow](login-flow.md) — Как устроен логин в приложении\n");
      expect(await readFile(join(dir, MEMORY_INDEX_FILE_NAME), "utf8")).toBe(content);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("formatHook: переносы строк в description схлопываются в пробелы — hook всегда одна строка", () => {
    // Многострочный scalar недостижим через line-based parseFrontmatter, контракт сведение
    // к одной строке (specs/memory-storage:25) закреплён на самом форматтере hook'а.
    expect(formatHook("первая строка\nвторая строка\n\nхвост")).toBe(
      "первая строка вторая строка  хвост",
    );
    expect(formatHook("одна строка")).toBe("одна строка");
    expect(formatHook("  с пробелами по краям  ")).toBe("с пробелами по краям");
  });

  test("N файлов без повреждённых → ровно N строк-записей (спека: Индекс соответствует файлам)", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-count-");
    try {
      await writeMemory(dir, "alpha", "запись alpha", "project");
      await writeMemory(dir, "beta", "запись beta", "user");
      await writeMemory(dir, "gamma", "запись gamma", "reference");
      const content = await rebuildMemoryIndex(dir);

      expect(entryLines(content)).toHaveLength(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("пустое хранилище → пустой индекс без маркера обрезки", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-empty-");
    try {
      const content = await rebuildMemoryIndex(dir);

      expect(content).toBe("");
      expect(await readFile(join(dir, MEMORY_INDEX_FILE_NAME), "utf8")).toBe("");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebuildMemoryIndex: сортировка", () => {
  test("новейшие-первыми по mtime файла памяти", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-sort-");
    try {
      const now = Date.now();
      await writeMemory(dir, "oldest", "старейшая", "project", new Date(now - 3 * DAY_MS));
      await writeMemory(dir, "newest", "новейшая", "project", new Date(now - DAY_MS));
      await writeMemory(dir, "middle", "средняя", "project", new Date(now - 2 * DAY_MS));
      const content = await rebuildMemoryIndex(dir);

      expect(entryLines(content).map((line) => line.split("]")[0])).toEqual([
        "- [newest",
        "- [middle",
        "- [oldest",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("равные mtime → детерминированный тайбрейк по имени", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-tie-");
    try {
      const same = new Date(Date.now() - DAY_MS);
      await writeMemory(dir, "zeta", "второй", "project", same);
      await writeMemory(dir, "alpha", "первый", "project", same);
      const content = await rebuildMemoryIndex(dir);

      expect(entryLines(content).map((line) => line.split("]")[0])).toEqual([
        "- [alpha",
        "- [zeta",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("гарантированные user/feedback отображаются раньше остальных (design Decision 3)", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-guaranteed-order-");
    try {
      const now = Date.now();
      await writeMemory(
        dir,
        "fresh-project",
        "свежая проектная",
        "project",
        new Date(now - DAY_MS),
      );
      await writeMemory(
        dir,
        "old-user",
        "старая пользовательская",
        "user",
        new Date(now - 30 * DAY_MS),
      );
      const content = await rebuildMemoryIndex(dir);

      expect(entryLines(content).map((line) => line.split("]")[0])).toEqual([
        "- [old-user",
        "- [fresh-project",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebuildMemoryIndex: stale-пометка возраста", () => {
  test("project старше 60 дней помечается «[N d old, verify]», свежий — нет", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-stale-project-");
    try {
      const now = Date.now();
      await writeMemory(dir, "stale-project", "устаревшая", "project", new Date(now - 61 * DAY_MS));
      await writeMemory(dir, "fresh-project", "свежая", "project", new Date(now - 59 * DAY_MS));
      const content = await rebuildMemoryIndex(dir);

      expect(content).toContain(
        "- [stale-project](stale-project.md) — устаревшая [61 d old, verify]",
      );
      expect(content).not.toContain("fresh-project [");
      expect(content).toContain("- [fresh-project](fresh-project.md) — свежая\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("user и reference старше 90 дней помечаются", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-stale-user-reference-");
    try {
      const now = Date.now();
      await writeMemory(dir, "stale-user", "устаревшая", "user", new Date(now - 91 * DAY_MS));
      await writeMemory(
        dir,
        "stale-reference",
        "устаревшая",
        "reference",
        new Date(now - 100 * DAY_MS),
      );
      const content = await rebuildMemoryIndex(dir);

      expect(content).toContain("- [stale-user](stale-user.md) — устаревшая [91 d old, verify]");
      expect(content).toContain(
        "- [stale-reference](stale-reference.md) — устаревшая [100 d old, verify]",
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("feedback любого возраста никогда не помечается", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-stale-feedback-");
    try {
      await writeMemory(
        dir,
        "old-feedback",
        "замечание",
        "feedback",
        new Date(Date.now() - 400 * DAY_MS),
      );
      const content = await rebuildMemoryIndex(dir);

      expect(content).toBe("- [old-feedback](old-feedback.md) — замечание\n");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebuildMemoryIndex: бюджетная адмиссия", () => {
  test("превышение 200 строк: гарантированные user/feedback сохранены, остальные — новейшие, финальный маркер", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-budget-lines-");
    try {
      const now = Date.now();
      await writeMemory(dir, "user-prefs", "предпочтения", "user", new Date(now - 100 * DAY_MS));
      await writeMemory(dir, "fb-note", "замечание", "feedback", new Date(now - 90 * DAY_MS));
      // 220 project-памятей: proj-000 — старейшая (220 дн.), proj-219 — новейшая (1 дн.).
      for (let i = 0; i < 220; i++) {
        const name = `proj-${String(i).padStart(3, "0")}`;
        await writeMemory(
          dir,
          name,
          `project memory number ${i}`,
          "project",
          new Date(now - (220 - i) * DAY_MS),
        );
      }
      const content = await rebuildMemoryIndex(dir);
      const lines = content.split("\n");

      // Гарантированные user/feedback — первые две строки (внутри группы новейшие-первыми);
      // старая user-память при этом получает stale-пометку.
      expect(lines[0]).toBe("- [fb-note](fb-note.md) — замечание");
      expect(lines[1]).toBe("- [user-prefs](user-prefs.md) — предпочтения [100 d old, verify]");

      // Итог в пределах 200 строк включая маркер; маркер — последняя строка и входит в бюджет.
      expect(lines).toHaveLength(INDEX_MAX_LINES + 1); // 200 записей+маркер и финальный перевод строки
      expect(lines[INDEX_MAX_LINES - 1]).toBe(truncatedMarkerText(199, 222));
      expect(content.length).toBeLessThanOrEqual(INDEX_MAX_CHARS);

      // Из project-памятей остались новейшие: proj-023 ещё в индексе, proj-000..proj-022 срезаны.
      expect(content).toContain("- [proj-219](proj-219.md) — project memory number 219");
      expect(content).toContain("- [proj-023](proj-023.md) — project memory number 23");
      expect(content).not.toContain("- [proj-022](proj-022.md)");
      expect(content).not.toContain("- [proj-000](proj-000.md)");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);

  test("превышение 25 000 символов: хвост срезан целыми строками, маркер в бюджете", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-budget-chars-");
    try {
      for (let i = 0; i < 30; i++) {
        const name = `big-${String(i).padStart(2, "0")}`;
        await writeMemory(dir, name, "x".repeat(1000), "project");
      }
      const content = await rebuildMemoryIndex(dir);

      expect(content.length).toBeLessThanOrEqual(INDEX_MAX_CHARS);
      const lines = content.split("\n");
      expect(lines.length - 1).toBeLessThanOrEqual(INDEX_MAX_LINES);

      // Все оставшиеся записи полные (рез по символам откатился к границе строки).
      for (const line of entryLines(content)) {
        expect(line).toMatch(/^- \[big-\d+\]\(big-\d+\.md\) — x{1000}$/);
      }

      // Маркер — последняя строка, его счётчики согласованы с фактическим числом записей.
      const marker = lines[lines.length - 2];
      const match = /^> Index truncated: kept (\d+) of (\d+) memories/.exec(marker);
      expect(match).not.toBeNull();
      if (match) {
        expect(Number(match[1])).toBe(entryLines(content).length);
        expect(Number(match[2])).toBe(30);
      }
      expect(marker).toBe(truncatedMarkerText(entryLines(content).length, 30));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("всё помещается в лимиты → маркер обрезки не появляется", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-no-marker-");
    try {
      await writeMemory(dir, "fits", "помещается", "project");
      const content = await rebuildMemoryIndex(dir);

      expect(content).toBe("- [fits](fits.md) — помещается\n");
      expect(content).not.toContain("Index truncated");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebuildMemoryIndex: safe-усечение суррогатных пар", () => {
  test("астральные символы у порога 25 000 не рвутся посреди пары", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-surrogate-");
    try {
      // Одна запись длиннее лимита: рез приходится внутрь строки, без переводов строк.
      // "🚀x" — пара (2 UTF-16 units) + ASCII, граница реза неизбежно попадает в паттерн.
      await writeMemory(dir, "emoji-cut", "🚀x".repeat(9500), "project");
      const content = await rebuildMemoryIndex(dir);

      expect(content.length).toBeLessThanOrEqual(INDEX_MAX_CHARS);
      expect(content.isWellFormed()).toBe(true);
      expect(content.startsWith("- [emoji-cut](emoji-cut.md) — 🚀x")).toBe(true);
      expect(content.split("\n").filter((line) => line.startsWith("- ["))).toHaveLength(1);
      expect(content).toContain(truncatedMarkerText(1, 1));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebuildMemoryIndex: повторная редакция секретов", () => {
  test("секрет в description файла на диске редактируется при сборке индекса", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-redaction-");
    try {
      // Файл записан напрямую, мимо memory_save (защита от ручных правок).
      await writeMemory(dir, "leaked", "api_key: sk-abc123", "project");
      const content = await rebuildMemoryIndex(dir);

      expect(content).toMatch(/^- \[leaked\]\(leaked\.md\) — api_key: \[REDACTED:[0-9a-f]{8}\]\n$/);
      expect(content).not.toContain("sk-abc123");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("rebuildMemoryIndex: tolerant сборка повреждённых файлов", () => {
  test("повреждённый frontmatter карантинится (*.corrupt-…), неполный пропускается, остальные в индексе", async () => {
    const dir = await makeMemoryDir("opencode-memory-991-index-corrupt-");
    try {
      await writeMemory(dir, "good-one", "запись один", "project");
      await writeMemory(dir, "good-two", "запись два", "user");
      await writeFile(join(dir, "broken.md"), "вообще не frontmatter\n", "utf8");
      await writeFile(
        join(dir, "no-name.md"),
        "---\ndescription: имя отсутствует\nmetadata:\n  type: user\n---\nтело\n",
        "utf8",
      );
      const content = await rebuildMemoryIndex(dir);

      expect(entryLines(content)).toHaveLength(2);
      expect(content).toContain("- [good-one](good-one.md) — запись один");
      expect(content).toContain("- [good-two](good-two.md) — запись два");
      expect(content).not.toContain("broken.md");
      expect(content).not.toContain("no-name.md");

      // Повреждённый файл перемещён в карантин (остался различимым, specs/memory-storage),
      // повторная сборка его больше не видит; неполный файл остаётся на месте.
      expect(await readdir(dir)).toContain("no-name.md");
      const quarantined = (await readdir(dir)).filter((name) =>
        /^broken\.md\.corrupt-\d+-\d+-[0-9a-f-]+$/i.test(name),
      );
      expect(quarantined).toHaveLength(1);
      expect(await readFile(join(dir, quarantined[0] as string), "utf8")).toContain(
        "вообще не frontmatter",
      );
      const repeat = await rebuildMemoryIndex(dir);
      expect(entryLines(repeat)).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
