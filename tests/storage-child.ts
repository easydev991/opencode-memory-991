// Хелперы кросс-процессных тестов storage: сборка скриптов дочерних `bun -e`-процессов,
// импортирующих трансплантат src/storage.ts по абсолютному пути, и их запуск через Bun.spawn.
// Файлы tests/ не входят в область biome; типы проверяются транзитивно через импорты из src/.

import { existsSync } from "node:fs";

/** Дочерний писатель: `updates` параллельных инкрементов под withFileLock со случайным окном ожидания. */
export function writerScript(
  storageModule: string,
  target: string,
  updates: number,
  maxDelayMs: number,
): string {
  return `
import { readFile, rename, writeFile } from "node:fs/promises";
import { withFileLock } from ${JSON.stringify(storageModule)};
const path = ${JSON.stringify(target)};
await Promise.all(
  Array.from({ length: ${updates} }, () =>
    withFileLock(path, async () => {
      await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * ${maxDelayMs})));
      let count = 0;
      try { count = JSON.parse(await readFile(path, "utf8")).count; } catch {}
      const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
      await writeFile(tmp, JSON.stringify({ count: count + 1 }), "utf8");
      await rename(tmp, path);
    }),
  ),
);
`;
}

/** Дочерний «медленный писатель»: держит файловый лок `holdMs` мс, затем коммитит инкремент. */
export function slowUpdateScript(storageModule: string, target: string, holdMs: number): string {
  return `
import { readFile, rename, writeFile } from "node:fs/promises";
import { withFileLock } from ${JSON.stringify(storageModule)};
const path = ${JSON.stringify(target)};
await withFileLock(path, async () => {
  await new Promise(resolve => setTimeout(resolve, ${holdMs}));
  let current = { count: 0, order: [] as string[] };
  try { current = JSON.parse(await readFile(path, "utf8")); } catch {}
  const updated = { count: current.count + 1, order: [...current.order, "child"] };
  const tmp = path + ".tmp-" + process.pid + "-" + Date.now();
  await writeFile(tmp, JSON.stringify(updated), "utf8");
  await rename(tmp, path);
});
`;
}

/** Дочерний держатель лока: берёт файловый лок напрямую (тем же протоколом wx + pid/created) и держит `holdMs` мс. */
export function holdLockScript(target: string, holdMs: number): string {
  const lockPath = JSON.stringify(`${target}.lock`);
  return `
import { open, rm } from "node:fs/promises";
const lockPath = ${lockPath};
const handle = await open(lockPath, "wx", 0o600);
await handle.write(process.pid + "\\n" + Date.now() + "\\n", 0, "utf8");
await new Promise(resolve => setTimeout(resolve, ${holdMs}));
await handle.close();
await rm(lockPath, { force: true });
`;
}

/** Запускает скрипт дочерним bun-процессом; ненулевой код выхода — ошибка с stderr дочернего процесса. */
export async function runChildScript(script: string): Promise<void> {
  const proc = Bun.spawn([process.execPath, "-e", script], { stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const stderr = await new Response(proc.stderr).text();
    throw new Error(`дочерний процесс завершился с кодом ${code}: ${stderr}`);
  }
}

/** Ждёт, пока дочерний процесс возьмёт файловый лок (детерминизм: родитель стартует после захвата лока). */
export async function waitForLockFile(target: string, timeoutMs = 5000): Promise<void> {
  const lockPath = `${target}.lock`;
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(lockPath)) {
    if (Date.now() > deadline) throw new Error(`файл лока ${lockPath} не появился за ${timeoutMs} мс`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
