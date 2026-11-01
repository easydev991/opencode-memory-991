import { describe, expect, test } from "bun:test";

import {
  type FrontmatterFields,
  isMemoryType,
  parseFrontmatter,
  serializeFrontmatter,
} from "./frontmatter";

describe("parseFrontmatter: валидный блок", () => {
  test("round-trip: сериализация → парс возвращает name/description/type и тело дословно", () => {
    const fields: FrontmatterFields = {
      name: "login-flow",
      description: "Как устроен логин в приложении",
      type: "project",
    };
    const body = "Факт о проекте.\n\n**Why:** важно.\nСвязано с [[auth]].\n";
    const parsed = parseFrontmatter(serializeFrontmatter(fields, body));
    expect(parsed.name).toBe("login-flow");
    expect(parsed.description).toBe("Как устроен логин в приложении");
    expect(parsed.type).toBe("project");
    expect(parsed.typeRaw).toBe("project");
    expect(parsed.body).toBe(body);
  });

  test("канонический вид zcode: вложенный metadata.type, тело после закрывающего --- дословно", () => {
    const parsed = parseFrontmatter(
      "---\nname: api-keys\ndescription: Где лежат ключи\nmetadata:\n  type: reference\n---\n\nТекст памяти.",
    );
    expect(parsed.name).toBe("api-keys");
    expect(parsed.description).toBe("Где лежат ключи");
    expect(parsed.type).toBe("reference");
    expect(parsed.body).toBe("\nТекст памяти.");
  });

  test("все четыре значения enum распознаются", () => {
    for (const type of ["user", "feedback", "project", "reference"] as const) {
      const parsed = parseFrontmatter(
        `---\nname: n\ndescription: d\nmetadata:\n  type: ${type}\n---\nтело`,
      );
      expect(parsed.type).toBe(type);
    }
  });

  test("двоеточие со пробелом в значении переживает round-trip", () => {
    const fields: FrontmatterFields = {
      name: "deploys",
      description: "Деплой: только через CI",
      type: "project",
    };
    const parsed = parseFrontmatter(serializeFrontmatter(fields, "тело"));
    expect(parsed.description).toBe("Деплой: только через CI");
  });

  test("кавычки вокруг значения снимаются (ручные правки)", () => {
    const parsed = parseFrontmatter(
      `---\nname: "quoted"\ndescription: 'одна строка'\nmetadata:\n  type: user\n---\n`,
    );
    expect(parsed.name).toBe("quoted");
    expect(parsed.description).toBe("одна строка");
  });
});

describe("parseFrontmatter: повреждённый блок → throw", () => {
  test("нет открывающего --- (в т.ч. пустой ввод)", () => {
    expect(() => parseFrontmatter("name: x\n---\nтело")).toThrow();
    expect(() => parseFrontmatter("")).toThrow();
  });

  test("нет закрывающего ---", () => {
    expect(() =>
      parseFrontmatter("---\nname: x\ndescription: d\nmetadata:\n  type: user\nтело"),
    ).toThrow();
  });

  test("мусор вместо маппинга внутри блока", () => {
    expect(() => parseFrontmatter("---\nпросто текст\n---\nтело")).toThrow();
    expect(() => parseFrontmatter("---\n- список\n---\nтело")).toThrow();
  });
});

describe("parseFrontmatter: частичный блок → без throw, отсутствие полей различимо", () => {
  test("пустой блок: все поля undefined, тело читается", () => {
    const parsed = parseFrontmatter("---\n---\nтело");
    expect(parsed.name).toBeUndefined();
    expect(parsed.description).toBeUndefined();
    expect(parsed.type).toBeUndefined();
    expect(parsed.typeRaw).toBeUndefined();
    expect(parsed.body).toBe("тело");
  });

  test("заполнен только name: остальные поля undefined", () => {
    const parsed = parseFrontmatter("---\nname: only-name\n---\nтело");
    expect(parsed.name).toBe("only-name");
    expect(parsed.description).toBeUndefined();
    expect(parsed.type).toBeUndefined();
    expect(parsed.body).toBe("тело");
  });

  test("metadata.type вне enum: type undefined, typeRaw отличает от отсутствующего поля", () => {
    const parsed = parseFrontmatter(
      "---\nname: n\ndescription: d\nmetadata:\n  type: secret\n---\nтело",
    );
    expect(parsed.type).toBeUndefined();
    expect(parsed.typeRaw).toBe("secret");
  });

  test("metadata.type отсутствует: type и typeRaw undefined", () => {
    const parsed = parseFrontmatter("---\nname: n\ndescription: d\n---\nтело");
    expect(parsed.type).toBeUndefined();
    expect(parsed.typeRaw).toBeUndefined();
  });

  test("посторонние ключи (в т.ч. вложенные) игнорируются без ошибки", () => {
    const parsed = parseFrontmatter(
      "---\ntags: a, b\nname: n\ndescription: d\nmetadata:\n  type: user\n  origin: manual\n---\nтело",
    );
    expect(parsed.name).toBe("n");
    expect(parsed.description).toBe("d");
    expect(parsed.type).toBe("user");
    expect(parsed.body).toBe("тело");
  });
});

describe("serializeFrontmatter", () => {
  test("канонический вид: ---, name, description, metadata.type, ---, тело", () => {
    const fields: FrontmatterFields = { name: "n", description: "d", type: "feedback" };
    expect(serializeFrontmatter(fields, "тело")).toBe(
      "---\nname: n\ndescription: d\nmetadata:\n  type: feedback\n---\nтело",
    );
  });

  test("пустое тело — файл заканчивается закрывающим --- с переводом строки", () => {
    const fields: FrontmatterFields = { name: "n", description: "d", type: "user" };
    expect(serializeFrontmatter(fields, "").endsWith("---\n")).toBe(true);
  });
});

describe("isMemoryType", () => {
  test("значения enum → true, произвольная строка → false", () => {
    expect(isMemoryType("user")).toBe(true);
    expect(isMemoryType("feedback")).toBe(true);
    expect(isMemoryType("project")).toBe(true);
    expect(isMemoryType("reference")).toBe(true);
    expect(isMemoryType("secret")).toBe(false);
    expect(isMemoryType("")).toBe(false);
  });
});
