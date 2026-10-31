import { describe, expect, test } from "bun:test";

import { resolveMemoryRoot } from "./paths";

describe("resolveMemoryRoot", () => {
  test("XDG_DATA_HOME перенаправляет корень", () => {
    expect(resolveMemoryRoot({ XDG_DATA_HOME: "/tmp/xdg" })).toBe("/tmp/xdg/opencode-memory");
  });

  test("без XDG_DATA_HOME — $HOME/.local/share/opencode-memory", () => {
    expect(resolveMemoryRoot({ HOME: "/home/u" })).toBe("/home/u/.local/share/opencode-memory");
  });

  test("без HOME — фолбэк на ~", () => {
    expect(resolveMemoryRoot({})).toBe("~/.local/share/opencode-memory");
  });
});
