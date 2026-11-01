import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { resolveMemoryRoot } from "./paths";

const testXdgPrefix = "opencode-memory-991-test-xdg-";

function requireIsolatedXdg(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg === undefined) {
    throw new Error("XDG_DATA_HOME не задан: preload tests/setup-xdg-data-home.ts не подключён");
  }
  return xdg;
}

describe("изоляция XDG_DATA_HOME", () => {
  test("preload задаёт XDG_DATA_HOME во временный каталог с префиксом", () => {
    const xdg = requireIsolatedXdg();
    expect(xdg.startsWith(tmpdir())).toBe(true);
    expect(basename(xdg).startsWith(testXdgPrefix)).toBe(true);
    expect(existsSync(xdg)).toBe(true);
  });

  test("resolveMemoryRoot() без аргументов указывает внутрь изолированного каталога", () => {
    const xdg = requireIsolatedXdg();
    expect(resolveMemoryRoot()).toBe(join(xdg, "opencode-memory"));
  });
});
