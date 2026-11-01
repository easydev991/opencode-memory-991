/**
 * Перенесено из opencode-working-memory (https://github.com/sdwolf4103/opencode-working-memory),
 * лицензия MIT — Copyright (c) 2026 OpenCode Working Memory Contributors.
 * Синхронизация с апстримом — вручную.
 */

import { randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

// Таймаут ожидания кросс-процессного файлового лока; значение зафиксировано и закреплено
// тестом (specs/memory-storage: «Деградация при таймауте лока»), переопределяется через
// опцию timeoutMs у withFileLock.
export const LOCK_WAIT_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 1_000;

async function isLockStale(lockPath: string, now = Date.now()): Promise<boolean> {
  try {
    const stats = await stat(lockPath);

    if (now - stats.mtimeMs > LOCK_STALE_MS) return true;

    const content = await readFile(lockPath, "utf8");
    const [, createdText] = content.split("\n");
    const createdAt = Number(createdText);

    return Number.isFinite(createdAt) && now - createdAt > LOCK_STALE_MS;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

async function writeLockInfo(handle: FileHandle): Promise<void> {
  const content = `${process.pid}\n${Date.now()}\n`;
  await handle.truncate(0);
  await handle.write(content, 0, "utf8");
}

/**
 * Удаление лока в finally только если он всё ещё наш: после stale-перехвата (isLockStale)
 * лок может принадлежать новому держателю — безусловный rm удалил бы чужой лок и впустил
 * бы третий процесс в критическую секцию параллельно со вторым. Чужой pid или ошибка чтения
 * — лок не трогаем: зависший наш лок позже снимет stale-логика (LOCK_STALE_MS).
 */
async function removeOwnLock(lockPath: string): Promise<void> {
  try {
    const [pidText] = (await readFile(lockPath, "utf8")).split("\n");
    if (Number(pidText) !== process.pid) return;
  } catch {
    return;
  }
  await rm(lockPath, { force: true });
}

export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? LOCK_WAIT_TIMEOUT_MS;
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const started = Date.now();

  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      let heartbeat: NodeJS.Timeout | undefined;
      let heartbeatWrite: Promise<void> = Promise.resolve();
      const queueHeartbeat = (): void => {
        heartbeatWrite = heartbeatWrite
          .catch(() => undefined)
          .then(() => writeLockInfo(handle))
          .catch(() => undefined);
      };

      try {
        await writeLockInfo(handle);
        heartbeat = setInterval(queueHeartbeat, LOCK_HEARTBEAT_MS);
        return await fn();
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        await heartbeatWrite.catch(() => undefined);
        await handle.close();
        await removeOwnLock(lockPath);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;

      if (await isLockStale(lockPath)) {
        // Атомарный перехват stale-лока: rename успешен ровно у одного из нескольких
        // ожидающих процессов. rm+continue гонялся: двое проходили isLockStale, второй rm
        // удалял свежий лок, пересозданный первым open(wx), — и оба оказывались
        // в критической секции.
        const stalePath = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
        try {
          await rename(lockPath, stalePath);
        } catch (renameError) {
          // Лок уже снят держателем или перехвачен другим процессом — обычная
          // повторная попытка open(wx) на следующей итерации.
          if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw renameError;
        }
        await rm(stalePath, { force: true }).catch(() => undefined);
        continue;
      }

      if (Date.now() - started > timeoutMs) {
        throw Object.assign(new Error(`Timed out waiting for lock ${lockPath}`), {
          code: "ELOCKTIMEOUT",
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

export async function atomicWriteText(path: string, text: string): Promise<void> {
  // Atomic text write primitive (transplanted from owm evidence-log): temporary
  // file + rename, temporary file removed if the write or rename fails.
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}
