import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { resolveMemoryRoot } from "./paths";
import { atomicWriteText } from "./storage";

/** Потолок лог-файла: при превышении усекается с сохранением хвоста (смоук-диагностика, не аудит). */
const LOG_MAX_BYTES = 2_000_000;
const LOG_TAIL_LINES = 500;

/** Очередь записи: строки одного процесса ложатся в файл в порядке вызова logMemory. */
let queue: Promise<void> = Promise.resolve();
/** Предупреждение о недоступности лог-файла — один раз, чтобы не шуметь на каждую строку. */
let writeWarned = false;
/** mkdir корня кэшируется: по одному разу на процесс, а не на каждую строку. */
let dirReady: Promise<void> | undefined;

/**
 * Диагностический лог плагина: дублируется на stderr и в файл `<memoryRoot>/plugin.log`
 * (строка `[<ISO-время>] [memory] <сообщение>`) — stderr живого opencode в логи хоста
 * не попадает. Fail-open: недоступность лог-файла не влияет на работу плагина, но один
 * раз сообщается в stderr, чтобы диагностика не молчала ровно тогда, когда нужна.
 */
export function logMemory(message: string): void {
  console.error(`[memory] ${message}`);
  queue = queue
    .then(() => appendLog(message))
    .catch((error) => {
      if (!writeWarned) {
        writeWarned = true;
        const text = error instanceof Error ? error.message : String(error);
        console.error(`[memory] лог-файл недоступен: ${text}`);
      }
      dirReady = undefined;
    });
}

/** Ожидание завершения всех записей лога (для тестов). */
export function flushLog(): Promise<void> {
  return queue;
}

async function appendLog(message: string): Promise<void> {
  const root = resolveMemoryRoot();
  const file = `${root}/plugin.log`;
  dirReady ??= mkdir(root, { recursive: true }).then(() => undefined);
  await dirReady;
  try {
    const stats = await stat(file);
    if (stats.size > LOG_MAX_BYTES) {
      // Хвост сохраняется: обнуление стёрло бы строки, ради которых лог ведётся.
      // Перезапись атомарная (tmp+rename): параллельный читатель не видит пустой файл.
      const content = await readFile(file, "utf8");
      const tail = content.split("\n").slice(-LOG_TAIL_LINES).join("\n");
      await atomicWriteText(file, tail);
    }
  } catch {
    // файла ещё нет — создастся append'ом ниже
  }
  await appendFile(file, `[${new Date().toISOString()}] [memory] ${message}\n`, "utf8");
}
