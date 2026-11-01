import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runChildScript,
  slowUpdateScript,
  waitForLockFile,
  writerScript,
} from "../tests/storage-child";
import { atomicWriteText, LOCK_WAIT_TIMEOUT_MS, withFileLock } from "./storage";

// Тесты трансплантата owm (tasks 3.1-3.2, в пересечении с runtime-использованием плагина):
// атомарная запись (tmp+rename), stale-lock recovery, сериализация внутри процесса и между
// дочерними bun-процессами. JSON-слой owm (readJSON/updateJSON/readJSONWithLock) в плагине
// не используется и удалён вместе с покрывавшими его characterization-тестами.

const storageModule = join(import.meta.dir, "storage.ts");

describe("storage: атомарная запись", () => {
  test("atomicWriteText пишет текст и не оставляет tmp", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-text-"));
    try {
      const path = join(root, "nested", "MEMORY.md");
      const text = "# Index\n- [Note](note.md) — hook\n";

      await atomicWriteText(path, text);

      expect(await readFile(path, "utf8")).toBe(text);
      const files = await readdir(join(root, "nested"));
      expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("atomicWriteText удаляет tmp при ошибке записи и пробрасывает ошибку", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-text-fail-"));
    try {
      const blocked = join(root, "blocked");
      await mkdir(blocked);

      await expect(atomicWriteText(blocked, "content")).rejects.toThrow();

      const files = await readdir(root);
      expect(files.filter((file) => file.endsWith(".tmp"))).toEqual([]);
      expect(existsSync(blocked)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("storage: локи", () => {
  test("таймаут ожидания лока зафиксирован именованной константой 5000 мс", () => {
    expect(LOCK_WAIT_TIMEOUT_MS).toBe(5000);
  });

  test("withFileLock сериализует параллельные инкременты в одном процессе", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-inproc-"));
    try {
      const path = join(root, "counter.json");
      await writeFile(path, JSON.stringify({ count: 0 }), "utf8");
      await Promise.all(
        Array.from({ length: 25 }, () =>
          withFileLock(path, async () => {
            const current = JSON.parse(await readFile(path, "utf8")) as { count: number };
            await writeFile(path, JSON.stringify({ count: current.count + 1 }), "utf8");
          }),
        ),
      );

      const final = JSON.parse(await readFile(path, "utf8")) as { count: number };
      expect(final.count).toBe(25);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("withFileLock восстанавливается после stale-lock от упавшего процесса", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-stale-"));
    try {
      const path = join(root, "locked.json");
      const lockPath = `${path}.lock`;
      await writeFile(lockPath, "999999\n0\n", "utf8");

      await withFileLock(path, async () => {
        await writeFile(path, "written", "utf8");
      });

      expect(existsSync(lockPath)).toBe(false);
      // Перехват stale-лока атомарен (rename в *.stale-<uuid>): файл-свидетель удаляется,
      // в каталоге ничего не остаётся.
      expect((await readdir(root)).filter((name) => name.includes(".stale-"))).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("withFileLock не удаляет лок, перехваченный другим процессом (проверка владельца)", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-ownlock-"));
    try {
      const path = join(root, "data.bin");
      const lockPath = `${path}.lock`;
      const foreign = `999999\n${Date.now()}\n`;

      await withFileLock(path, async () => {
        // Тик heartbeat (1 с) переписывает лок нашим pid; затем эмулируем stale-перехват
        // чужим процессом: он записывает в файл лока свой pid.
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await writeFile(lockPath, foreign, "utf8");
      });

      // Чужой лок не удалён: безусловный rm в finally стёр бы лок нового держателя
      // и впустил бы третий процесс в критическую секцию параллельно.
      expect(existsSync(lockPath)).toBe(true);
      expect(await readFile(lockPath, "utf8")).toBe(foreign);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 10_000);

  test("withFileLock по таймауту бросает coded-ошибку ELOCKTIMEOUT", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-timeout-"));
    try {
      const path = join(root, "counter.json");
      const holder = withFileLock(path, () => new Promise((resolve) => setTimeout(resolve, 400)));
      await waitForLockFile(path);

      let caught: unknown;
      try {
        await withFileLock(path, async () => undefined, { timeoutMs: 100 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKTIMEOUT");
      expect((caught as Error).message).toContain("Timed out waiting for lock");

      await holder;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("withFileLock сериализует записи между отдельными bun-процессами без потери записей", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-xproc-"));
    try {
      const path = join(root, "counter.json");
      await writeFile(path, JSON.stringify({ count: 0 }), "utf8");

      await Promise.all(
        Array.from({ length: 5 }, () => runChildScript(writerScript(storageModule, path, 20, 5))),
      );

      const final = JSON.parse(await readFile(path, "utf8")) as { count: number };
      expect(final.count).toBe(100);
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("withFileLock ждёт живой кросс-процессный лок и сохраняет обе записи", async () => {
    const root = await mkdtemp(join(tmpdir(), "memory-storage-live-lock-"));
    try {
      const path = join(root, "counter.json");
      await writeFile(path, JSON.stringify({ count: 0, order: [] as string[] }), "utf8");
      const child = runChildScript(slowUpdateScript(storageModule, path, 250));
      await waitForLockFile(path);

      await withFileLock(path, async () => {
        const current = JSON.parse(await readFile(path, "utf8")) as {
          count: number;
          order: string[];
        };
        await writeFile(
          path,
          JSON.stringify({ count: current.count + 1, order: [...current.order, "parent"] }),
          "utf8",
        );
      });
      await child;

      const final = JSON.parse(await readFile(path, "utf8")) as {
        count: number;
        order: string[];
      };
      expect(final.count).toBe(2);
      expect(new Set(final.order)).toEqual(new Set(["child", "parent"]));
      expect(existsSync(`${path}.lock`)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 15_000);
});
