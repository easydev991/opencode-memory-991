import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { flushLog, logMemory } from "./log";
import { resolveMemoryRoot } from "./paths";

describe("log: файл plugin.log", () => {
  test("logMemory пишет строку с префиксом [memory] в plugin.log изолированного XDG", async () => {
    logMemory("log: тестовая строка смоука");
    await flushLog();
    const text = await Bun.file(`${resolveMemoryRoot()}/plugin.log`).text();
    expect(text).toContain("[memory] log: тестовая строка смоука");
  });

  test("строки одного процесса сохраняют порядок вызовов", async () => {
    logMemory("log: порядок 1");
    logMemory("log: порядок 2");
    await flushLog();
    const text = await Bun.file(`${resolveMemoryRoot()}/plugin.log`).text();
    expect(text.indexOf("log: порядок 1")).toBeLessThan(text.indexOf("log: порядок 2"));
  });

  test("усечение при >2МБ сохраняет свежий хвост (последние строки, не первые)", async () => {
    const root = resolveMemoryRoot();
    const file = join(root, "plugin.log");
    await rm(file, { force: true });
    await writeFile(file, "log: старая строка\n".repeat(200_000)); // ~3.4МБ
    logMemory("log: свежая строка после усечения");
    await flushLog();
    const text = await Bun.file(file).text();
    expect(text).toContain("log: свежая строка после усечения");
    expect(text.split("\n").length).toBeLessThanOrEqual(502);
  });

  test("fail-open: plugin.log как каталог не роняет logMemory, предупреждение — один раз", async () => {
    const root = resolveMemoryRoot();
    const file = join(root, "plugin.log");
    await rm(file, { force: true });
    await mkdir(file); // каталог вместо файла — appendFile упадёт EISDIR
    const original = console.error;
    const captured: string[] = [];
    console.error = (...args: unknown[]) => {
      captured.push(args.map((arg) => String(arg)).join(" "));
      original(...args);
    };
    try {
      logMemory("log: отказ 1");
      logMemory("log: отказ 2");
      await flushLog(); // очередь проглатывает ошибки записи, промис остаётся resolved
    } finally {
      console.error = original;
    }
    await rm(file, { recursive: true }); // прибираем: файл снова станет обычным
    const warnings = captured.filter((line) => line.includes("лог-файл недоступен"));
    expect(warnings.length).toBe(1); // единичное предупреждение, а не на каждый отказ
  });
});
