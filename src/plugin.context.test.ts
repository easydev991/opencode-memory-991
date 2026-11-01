import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveProjectMemoryDir } from "./paths";
import pluginDefault, {
  createSnapshotCache,
  MEMORY_PART_MARKER,
  type MemoryEvent,
  type MemoryTool,
  type PluginContext,
  type SessionContextInput,
  type SessionState,
  SNAPSHOT_CACHE_LIMIT,
} from "./plugin";

// Тесты context-хука (tasks 5.5): снапшот раз на сессию (идентичный текст между
// запросами), инжект в дочерней сессии, перечитывание после завершённой компакции,
// идемпотентность (маркер в metadata + per-prompt кэш), fail-open при битом хранилище,
// LRU-кап снапшотов и очистка по session.deleted/disposed, guard двойной регистрации.

let uniqueCounter = 0;

interface EventFeed {
  subscribe: () => AsyncIterable<MemoryEvent>;
  emit: (event: MemoryEvent) => void;
}

/** Управляемая лента событий: subscribe возвращает async-генератор, emit кладёт событие. */
function createEventFeed(): EventFeed {
  const buffer: MemoryEvent[] = [];
  let wake: (() => void) | undefined;
  return {
    subscribe: () =>
      (async function* () {
        while (true) {
          while (buffer.length === 0) {
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
          yield buffer.shift() as MemoryEvent;
        }
      })(),
    emit: (event) => {
      buffer.push(event);
      const current = wake;
      wake = undefined;
      current?.();
    },
  };
}

interface TestPlugin {
  hooks: Map<string, (input: SessionContextInput) => Promise<void> | void>;
  sessionInfo: Map<string, { parentID?: string }>;
  memoryDir: string;
  save: MemoryTool;
  emit: (event: MemoryEvent) => void;
  cleanup: () => Promise<void>;
}

async function createTestPlugin(
  wrapEvent?: (feed: EventFeed) => PluginContext["event"],
): Promise<TestPlugin> {
  uniqueCounter += 1;
  const canonical = `plugin-context-test-project-${uniqueCounter}`;
  const added: MemoryTool[] = [];
  const hooks = new Map<string, (input: SessionContextInput) => Promise<void> | void>();
  const sessionInfo = new Map<string, { parentID?: string }>();
  const feed = createEventFeed();
  const context: PluginContext = {
    location: { project: { canonical } },
    tool: {
      transform: async (apply) => {
        apply({ add: (tool) => added.push(tool) });
        return { dispose: async () => {} };
      },
    },
    session: {
      hook: async (name, handler) => {
        hooks.set(name, handler);
        return { dispose: async () => {} };
      },
      get: async ({ sessionID }) => ({ id: sessionID, ...sessionInfo.get(sessionID) }),
    },
    event: wrapEvent ? wrapEvent(feed) : { subscribe: feed.subscribe },
  };
  const cleanup = await pluginDefault.setup(context);
  const save = added.find((tool) => tool.name === "memory_save");
  if (!save) throw new Error("инструмент memory_save не зарегистрирован");
  return {
    hooks,
    sessionInfo,
    memoryDir: resolveProjectMemoryDir(canonical),
    save,
    emit: feed.emit,
    cleanup,
  };
}

function createContextInput(sessionID: string, messageID: string): SessionContextInput {
  return { sessionID, messageID, system: [] };
}

async function callContext(handle: TestPlugin, input: SessionContextInput): Promise<void> {
  const handler = handle.hooks.get("context");
  if (!handler) throw new Error("context-хук не зарегистрирован");
  await handler(input);
}

function memoryParts(input: SessionContextInput) {
  return input.system.filter((part) => part.metadata?.[MEMORY_PART_MARKER] !== undefined);
}

function snapshotText(input: SessionContextInput): string {
  const parts = memoryParts(input);
  expect(parts.length).toBe(2);
  return parts[1].text;
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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error("условие не выполнено за отведённое время");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("plugin: context-хук", () => {
  test("инжект — две system-части: секция правил + снапшот MEMORY.md", async () => {
    const handle = await createTestPlugin();
    try {
      await saveMemory(handle.save, "Alpha fact", "alpha", "project");
      const input = createContextInput("sess-1", "m1");
      await callContext(handle, input);

      const parts = memoryParts(input);
      expect(parts.length).toBe(2);
      const [rules, snapshot] = parts;
      expect(rules.type).toBe("text");
      expect(snapshot.type).toBe("text");
      expect(rules.text).toContain("# Memory");
      expect(rules.text).toContain(handle.memoryDir);
      expect(rules.text).toContain("```markdown");
      expect(rules.text).toContain("type: user | feedback | project | reference");
      expect(rules.text).toContain("[[name]]");
      expect(rules.text).toContain("<system-reminder>");
      expect(rules.text).toContain("memory_save");
      expect(rules.text).not.toContain("with the Write tool");
      expect(rules.text).not.toContain("add a one-line pointer");
      expect(rules.text).not.toContain("delete memories that turn out to be wrong");
      expect(snapshot.text).toContain("- [alpha](alpha.md) — Alpha fact");
    } finally {
      await handle.cleanup();
    }
  });

  test("пустое хранилище: инжект только секции правил, без пустого снапшота", async () => {
    const handle = await createTestPlugin();
    try {
      const input = createContextInput("sess-1", "m1");
      await callContext(handle, input);
      const parts = memoryParts(input);
      expect(parts.length).toBe(1);
      expect(parts[0].text).toContain("# Memory");
    } finally {
      await handle.cleanup();
    }
  });

  test("снапшот детерминирован между запросами, без компакции не перечитывается", async () => {
    const handle = await createTestPlugin();
    try {
      await saveMemory(handle.save, "Alpha fact", "alpha", "project");
      const first = createContextInput("sess-1", "m1");
      await callContext(handle, first);
      const second = createContextInput("sess-1", "m2");
      await callContext(handle, second);
      const third = createContextInput("sess-1", "m3");
      await callContext(handle, third);
      expect(snapshotText(second)).toBe(snapshotText(first));
      expect(snapshotText(third)).toBe(snapshotText(first));

      await saveMemory(handle.save, "Beta fact", "beta", "project");
      const fourth = createContextInput("sess-1", "m4");
      await callContext(handle, fourth);
      expect(snapshotText(fourth)).toBe(snapshotText(first));
      expect(snapshotText(fourth)).not.toContain("beta");
    } finally {
      await handle.cleanup();
    }
  });

  test("после завершённой компакции снапшот перечитывается", async () => {
    const handle = await createTestPlugin();
    try {
      await saveMemory(handle.save, "Alpha fact", "alpha", "project");
      const first = createContextInput("sess-1", "m1");
      await callContext(handle, first);
      expect(snapshotText(first)).toContain("alpha");

      await saveMemory(handle.save, "Beta fact", "beta", "project");
      handle.emit({ type: "session.compaction.ended", data: { sessionID: "sess-1" } });

      let probe = first;
      let attempt = 0;
      await waitFor(async () => {
        attempt += 1;
        probe = createContextInput("sess-1", `m-probe-${attempt}`);
        await callContext(handle, probe);
        return snapshotText(probe).includes("beta");
      });
      expect(snapshotText(probe)).toContain("alpha");
    } finally {
      await handle.cleanup();
    }
  });

  test("цикл событий перезапускается: ошибка потока не отключает обработку компакции", async () => {
    const logged: string[] = [];
    const original = console.error;
    // Capture до setup: ошибка первого потока прилетает на микротаске сразу после него.
    console.error = (...args: unknown[]) => {
      logged.push(args.map((arg) => String(arg)).join(" "));
    };
    try {
      let subscribeCalls = 0;
      const handle = await createTestPlugin((feed) => ({
        subscribe: () => {
          subscribeCalls += 1;
          if (subscribeCalls === 1) {
            // Первый поток падает на первом же next() — прежний цикл навсегда останавливался.
            return {
              [Symbol.asyncIterator]: () => ({
                next: async (): Promise<IteratorResult<MemoryEvent>> => {
                  throw new Error("event bus failure");
                },
              }),
            };
          }
          return feed.subscribe();
        },
      }));
      try {
        await saveMemory(handle.save, "Alpha fact", "alpha", "project");
        const first = createContextInput("sess-1", "m1");
        await callContext(handle, first);
        expect(snapshotText(first)).toContain("alpha");

        await saveMemory(handle.save, "Beta fact", "beta", "project");
        handle.emit({ type: "session.compaction.ended", data: { sessionID: "sess-1" } });

        let probe = first;
        let attempt = 0;
        await waitFor(async () => {
          attempt += 1;
          probe = createContextInput("sess-1", `m-probe-${attempt}`);
          await callContext(handle, probe);
          return snapshotText(probe).includes("beta");
        }, 3000);
      } finally {
        await handle.cleanup();
      }
      expect(logged.some((line) => line.includes("event loop"))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test("инжект выполняется и в дочерней сессии, независимо от наличия родителя", async () => {
    const handle = await createTestPlugin();
    try {
      await saveMemory(handle.save, "Alpha fact", "alpha", "project");
      handle.sessionInfo.set("child-1", { parentID: "root-1" });
      const input = createContextInput("child-1", "m1");
      await callContext(handle, input);
      const parts = memoryParts(input);
      expect(parts.length).toBe(2);
      expect(parts[1].text).toContain("alpha");
    } finally {
      await handle.cleanup();
    }
  });

  test("идемпотентность: маркер в metadata и per-prompt кэш не дублируют секции", async () => {
    const handle = await createTestPlugin();
    try {
      await saveMemory(handle.save, "Alpha fact", "alpha", "project");
      const shared = createContextInput("sess-1", "m1");
      await callContext(handle, shared);
      expect(memoryParts(shared).length).toBe(2);

      // Повторный проход хука по тому же запросу (части ещё в system).
      await callContext(handle, shared);
      expect(memoryParts(shared).length).toBe(2);

      // Хост пересобрал system без наших частей, messageID тот же — per-prompt кэш.
      const rebuilt = createContextInput("sess-1", "m1");
      rebuilt.system.push({ type: "text", text: "user message context" });
      await callContext(handle, rebuilt);
      expect(memoryParts(rebuilt).length).toBe(0);
      expect(rebuilt.system[0].text).toBe("user message context");
    } finally {
      await handle.cleanup();
    }
  });

  test("fail-open: нечитаемое хранилище — сессия работает, инжекта нет, ошибка в логе", async () => {
    const handle = await createTestPlugin();
    try {
      await rm(handle.memoryDir, { recursive: true, force: true });
      await mkdir(dirname(handle.memoryDir), { recursive: true });
      await writeFile(handle.memoryDir, "not a directory", "utf8");

      const logged: string[] = [];
      const original = console.error;
      console.error = (...args: unknown[]) => {
        logged.push(args.map((arg) => String(arg)).join(" "));
      };
      let input: SessionContextInput;
      try {
        input = createContextInput("sess-err", "m1");
        await callContext(handle, input);
      } finally {
        console.error = original;
      }
      expect(memoryParts(input)).toEqual([]);
      expect(logged.some((line) => line.includes("[memory]"))).toBe(true);
    } finally {
      await handle.cleanup();
    }
  });

  test("очистка по session.deleted: следующая сессия строит снапшот заново", async () => {
    const handle = await createTestPlugin();
    try {
      await saveMemory(handle.save, "Alpha fact", "alpha", "project");
      const first = createContextInput("sess-9", "m1");
      await callContext(handle, first);
      expect(snapshotText(first)).toContain("alpha");

      await saveMemory(handle.save, "Beta fact", "beta", "project");
      handle.emit({ type: "session.deleted", data: { sessionID: "sess-9" } });

      let probe = first;
      let attempt = 0;
      await waitFor(async () => {
        attempt += 1;
        probe = createContextInput("sess-9", `m-probe-${attempt}`);
        await callContext(handle, probe);
        return snapshotText(probe).includes("beta");
      });
    } finally {
      await handle.cleanup();
    }
  });

  test("dispose: после cleanup хук — no-op без исключения", async () => {
    const handle = await createTestPlugin();
    await saveMemory(handle.save, "Alpha fact", "alpha", "project");
    await handle.cleanup();

    const input = createContextInput("sess-1", "m1");
    await callContext(handle, input);
    expect(memoryParts(input)).toEqual([]);
  });

  test("guard двойной регистрации: новый setup диспозит предыдущий инстанс", async () => {
    const first = await createTestPlugin();
    const second = await createTestPlugin();

    const stoppedInput = createContextInput("sess-g", "m1");
    await callContext(first, stoppedInput);
    expect(memoryParts(stoppedInput)).toEqual([]);

    const activeInput = createContextInput("sess-g", "m1");
    await callContext(second, activeInput);
    const activeParts = memoryParts(activeInput);
    expect(activeParts.length).toBe(1);
    expect(activeParts[0].text).toContain("# Memory");

    await second.cleanup();
    await first.cleanup();
  });
});

describe("plugin: LRU-кап снапшотов", () => {
  test("лимит зафиксирован именованной константой 50 сессий", () => {
    expect(SNAPSHOT_CACHE_LIMIT).toBe(50);
  });

  test("createSnapshotCache вытесняет старейший, get освежает порядок, delete удаляет", () => {
    const cache = createSnapshotCache(2);
    const make = (): SessionState => ({
      generation: 0,
      snapshot: undefined,
      snapshotGeneration: undefined,
      prompts: new Set<string>(),
    });

    cache.set("s1", make());
    cache.set("s2", make());
    expect(cache.size()).toBe(2);

    cache.set("s3", make());
    expect(cache.get("s1")).toBeUndefined();
    expect(cache.get("s2")).toBeDefined();
    expect(cache.size()).toBe(2);

    cache.get("s2");
    cache.set("s4", make());
    expect(cache.get("s3")).toBeUndefined();
    expect(cache.get("s2")).toBeDefined();

    cache.delete("s2");
    expect(cache.get("s2")).toBeUndefined();
    expect(cache.size()).toBe(1);

    cache.clear();
    expect(cache.size()).toBe(0);
  });
});
