import { describe, expect, test } from "bun:test";

import { resolveMemoryRoot, resolveProjectMemoryDir } from "./paths";

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

  test("пустая строка XDG_DATA_HOME/HOME считается отсутствующей — не корень ФС", () => {
    expect(resolveMemoryRoot({ XDG_DATA_HOME: "", HOME: "/home/u" })).toBe(
      "/home/u/.local/share/opencode-memory",
    );
    expect(resolveMemoryRoot({ XDG_DATA_HOME: "", HOME: "" })).toBe(
      "~/.local/share/opencode-memory",
    );
  });
});

describe("resolveProjectMemoryDir", () => {
  test("каталог <memoryRoot>/projects/<slug>-<hash16>/memory", () => {
    expect(resolveProjectMemoryDir("/Users/u/proj", { HOME: "/home/u" })).toBe(
      "/home/u/.local/share/opencode-memory/projects/proj-b644c69dd2152300/memory",
    );
  });

  test("хэш детерминирован: одинаковый canonical → одинаковый <hash16> из 16 hex-символов", () => {
    const first = resolveProjectMemoryDir("/Users/u/proj", { HOME: "/home/u" });
    const second = resolveProjectMemoryDir("/Users/u/proj", { HOME: "/home/u" });
    expect(first).toBe(second);
    const dirName = first.split("/").at(-2) ?? "";
    const hash = dirName.slice(dirName.lastIndexOf("-") + 1);
    expect(hash).toMatch(/^[0-9a-f]{16}$/);
    expect(hash).toBe("b644c69dd2152300");
  });

  test("разные canonical → разные каталоги (изоляция проектов)", () => {
    const a = resolveProjectMemoryDir("/a/app", { HOME: "/home/u" });
    const b = resolveProjectMemoryDir("/b/app", { HOME: "/home/u" });
    expect(a).not.toBe(b);
    expect(a).toBe("/home/u/.local/share/opencode-memory/projects/app-8463b3739d7559cc/memory");
    expect(b).toBe("/home/u/.local/share/opencode-memory/projects/app-b6bec32a2e850d8b/memory");
  });

  test("XDG_DATA_HOME перенаправляет корень для проектного каталога", () => {
    expect(resolveProjectMemoryDir("/w/p", { XDG_DATA_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/opencode-memory/projects/p-6153bc205717a804/memory",
    );
    expect(resolveProjectMemoryDir("/w/p", {})).toBe(
      "~/.local/share/opencode-memory/projects/p-6153bc205717a804/memory",
    );
  });

  test("slug: пробелы → «-», lowercase, точки сохраняются", () => {
    expect(resolveProjectMemoryDir("/w/Hello World", { XDG_DATA_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/opencode-memory/projects/hello-world-b64431b14f46790d/memory",
    );
    expect(resolveProjectMemoryDir("/w/MY.Project.Final", { XDG_DATA_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/opencode-memory/projects/my.project.final-a4cb3f47eb18ba13/memory",
    );
  });

  test("slug: кириллица в basename → «-», вырожденный slug → «project»", () => {
    expect(resolveProjectMemoryDir("/w/Мой Проект", { XDG_DATA_HOME: "/tmp/xdg" })).toBe(
      "/tmp/xdg/opencode-memory/projects/project-68e6d5b01a944832/memory",
    );
  });

  test("slug: длинный basename обрезается до 48 символов", () => {
    const long = `/tmp/${"a".repeat(60)}`;
    expect(resolveProjectMemoryDir(long, { XDG_DATA_HOME: "/tmp/xdg" })).toBe(
      `/tmp/xdg/opencode-memory/projects/${"a".repeat(48)}-bb47a225d2d90962/memory`,
    );
  });
});
