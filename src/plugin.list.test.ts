import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { holdLockScript, runChildScript, waitForLockFile } from "../tests/storage-child";
import { resolveProjectMemoryDir } from "./paths";
import pluginDefault, { type ListOutput, type MemoryTool, type PluginContext } from "./plugin";

// Тесты memory_list (tasks 5.3): текущий индекс MEMORY.md, явный пустой ответ на пустом
// хранилище (без создания каталога памяти), чтение параллельно с записью без лока —
// последний закоммиченный индекс без ошибок и без ожидания, только чтение — ничего
// не создаёт и не пишет. Запись удерживает лок живым дочерним процессом.

let uniqueCounter = 0;

interface TestPlugin {
  save: MemoryTool;
  list: MemoryTool;
  memoryDir: string;
  cleanup: () => Promise<void>;
}

async function createTestPlugin(): Promise<TestPlugin> {
  uniqueCounter += 1;
  const canonical = `plugin-list-test-project-${uniqueCounter}`;
  const added: MemoryTool[] = [];
  const context: PluginContext = {
    location: { project: { canonical } },
    tool: {
      transform: async (apply) => {
        apply({ add: (tool) => added.push(tool) });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async () => ({ dispose: async () => {} }),
      get: async ({ sessionID }) => ({ id: sessionID }),
    },
    event: { subscribe: () => (async function* () {})() },
  };
  const cleanup = await pluginDefault.setup(context);
  const save = added.find((tool) => tool.name === "memory_save");
  const list = added.find((tool) => tool.name === "memory_list");
  if (!save || !list) throw new Error("инструменты memory_save/memory_list не зарегистрированы");
  return { save, list, memoryDir: resolveProjectMemoryDir(canonical), cleanup };
}

async function saveMemory(
  save: MemoryTool,
  text: string,
  name: string,
  type: string,
): Promise<void> {
  const result = await save.execute({ text, name, type }, { sessionID: "sess-1" });
  const output = result.output as { ok: boolean };
  if (!output.ok) throw new Error(`фикстура сохранения не сработала: ${JSON.stringify(output)}`);
}

describe("plugin: memory_list", () => {
  test("пустое хранилище: явный пустой ответ, каталог памяти не создаётся", async () => {
    const { list, memoryDir, cleanup } = await createTestPlugin();
    try {
      const result = await list.execute({}, { sessionID: "sess-1" });
      const out = result.output as ListOutput;
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("пустое хранилище не должно быть ошибкой");
      expect(out.empty).toBe(true);
      expect(out.index).toBe("");
      expect(out.count).toBe(0);
      // Чтение не создаёт ни индекс, ни сам каталог памяти (mkdir — только при записи).
      expect(existsSync(join(memoryDir, "MEMORY.md"))).toBe(false);
      expect(existsSync(memoryDir)).toBe(false);
    } finally {
      await cleanup();
    }
  });

  test("после первой записи каталог памяти появляется", async () => {
    const { save, memoryDir, cleanup } = await createTestPlugin();
    try {
      expect(existsSync(memoryDir)).toBe(false);
      await saveMemory(save, "Alpha fact", "alpha", "project");
      expect(existsSync(memoryDir)).toBe(true);
      expect(existsSync(join(memoryDir, "MEMORY.md"))).toBe(true);
    } finally {
      await cleanup();
    }
  });

  test("возвращает текущий собранный индекс MEMORY.md", async () => {
    const { save, list, memoryDir, cleanup } = await createTestPlugin();
    try {
      await saveMemory(save, "Alpha fact", "alpha", "project");
      await saveMemory(save, "Beta fact", "beta", "feedback");

      const result = await list.execute({}, { sessionID: "sess-1" });
      const out = result.output as ListOutput;
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("непустой индекс не должен быть ошибкой");
      expect(out.empty).toBe(false);
      expect(out.count).toBe(2);

      const onDisk = await readFile(join(memoryDir, "MEMORY.md"), "utf8");
      expect(out.index).toBe(onDisk);
      expect(out.index).toContain("- [alpha](alpha.md) — Alpha fact");
      expect(out.index).toContain("- [beta](beta.md) — Beta fact");
    } finally {
      await cleanup();
    }
  });

  test("чтение параллельно с записью: старое или новое содержимое, без ошибок и без ожидания лока", async () => {
    const { save, list, memoryDir, cleanup } = await createTestPlugin();
    try {
      await saveMemory(save, "Alpha fact", "alpha", "project");
      const indexPath = join(memoryDir, "MEMORY.md");
      const committed = await readFile(indexPath, "utf8");

      // Запись «в процессе»: лок удерживается живым дочерним процессом.
      const child = runChildScript(holdLockScript(indexPath, 1200));
      await waitForLockFile(indexPath);

      const started = Date.now();
      const result = await list.execute({}, { sessionID: "sess-1" });
      const out = result.output as ListOutput;
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("параллельное чтение не должно быть ошибкой");
      // Лок-фрифри чтение: либо старое, либо новое содержимое; без ожидания таймаута лока.
      expect([committed, out.index].includes(out.index)).toBe(true);
      expect(out.index).toBe(committed);
      expect(out.count).toBe(1);
      expect(Date.now() - started).toBeLessThan(1000);

      await child;
      const files = await readdir(memoryDir);
      expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
      expect(await readFile(indexPath, "utf8")).toBe(committed);
    } finally {
      await cleanup();
    }
  }, 15_000);

  test("только чтение: не создаёт MEMORY.md и не оставляет временных файлов", async () => {
    const { save, list, memoryDir, cleanup } = await createTestPlugin();
    try {
      await saveMemory(save, "Alpha fact", "alpha", "project");
      const before = new Set(await readdir(memoryDir));
      const result = await list.execute({}, { sessionID: "sess-1" });
      const out = result.output as ListOutput;
      expect(out.ok).toBe(true);
      const after = await readdir(memoryDir);
      expect(after.sort()).toEqual([...before].sort());
      expect(after.filter((file) => file.endsWith(".lock") || file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await cleanup();
    }
  });

  test("битый MEMORY.md читается tolerant, инструмент не бросает", async () => {
    const { list, memoryDir, cleanup } = await createTestPlugin();
    try {
      await rm(memoryDir, { recursive: true, force: true });
      await mkdir(memoryDir, { recursive: true });
      await writeFile(join(memoryDir, "MEMORY.md"), "\u0000broken\u0000", "utf8");
      const result = await list.execute({}, { sessionID: "sess-1" });
      const out = result.output as ListOutput;
      expect(out.ok).toBe(true);
      if (!out.ok) throw new Error("битый файл не должен быть ошибкой чтения");
      expect(out.index).toBe("\u0000broken\u0000");
    } finally {
      await cleanup();
    }
  });
});
