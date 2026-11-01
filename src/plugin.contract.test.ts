import { describe, expect, test } from "bun:test";

import pluginDefault, { type MemoryTool, type PluginContext } from "./plugin";

// Контракт-тест (tasks 5.1): плагин регистрирует ровно memory_save + memory_list,
// оба с options: { codemode: false } — инструменты видны модели в нативном тул-листе.
// setup вызывается с mock-ctx, собирающим вызовы tools.add.

function emptyEventFeed(): AsyncIterable<never> {
  return (async function* () {})();
}

function createContractContext(): { context: PluginContext; added: MemoryTool[] } {
  const added: MemoryTool[] = [];
  const context: PluginContext = {
    location: { project: { canonical: "plugin-contract-test-project" } },
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
    event: { subscribe: () => emptyEventFeed() },
  };
  return { context, added };
}

describe("plugin: контракт регистрации инструментов", () => {
  test("default-экспорт — { id, setup }", () => {
    expect(typeof pluginDefault.id).toBe("string");
    expect(pluginDefault.id.length).toBeGreaterThan(0);
    expect(typeof pluginDefault.setup).toBe("function");
  });

  test("setup регистрирует ровно memory_save + memory_list, оба с codemode: false", async () => {
    const { context, added } = createContractContext();
    const cleanup = await pluginDefault.setup(context);
    expect(typeof cleanup).toBe("function");

    expect(added.map((tool) => tool.name).sort()).toEqual(["memory_list", "memory_save"]);
    for (const tool of added) {
      expect(tool.options).toEqual({ codemode: false });
      expect(typeof tool.description).toBe("string");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(typeof tool.execute).toBe("function");
      expect(tool.input.type).toBe("object");
    }

    await cleanup();
  });

  test("setup возвращает cleanup, который можно вызвать повторно без ошибки", async () => {
    const { context } = createContractContext();
    const cleanup = await pluginDefault.setup(context);
    await cleanup();
    await cleanup();
  });
});
