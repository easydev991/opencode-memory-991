import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { redactCredentials as redactCredentialsRaw } from "./redaction";

// Маркер редакции несёт отпечаток секрета ([REDACTED:<8 hex>]); для точных ожиданий
// ниже он сводится обратно к голому [REDACTED]. Формат отпечатка проверяется отдельно.
const redactCredentials = (text: string): string =>
  redactCredentialsRaw(text).replace(/\[REDACTED:[0-9a-f]{8}\]/g, "[REDACTED]");

describe("редакция паролей и PIN", () => {
  test("PIN с CJK- и ASCII-разделителями (варианты owm)", () => {
    expect(redactCredentials("Admin PIN 是 456123")).toBe("Admin PIN 是 [REDACTED]");
    expect(redactCredentials("Admin PIN = 456123")).toBe("Admin PIN = [REDACTED]");
    expect(redactCredentials("Admin PIN 456123")).toBe("Admin PIN [REDACTED]");
  });

  test("многоязычные метки пароля: ASCII, японский, корейский, испанский", () => {
    expect(redactCredentials("password: hunter2")).toBe("password: [REDACTED]");
    expect(redactCredentials("passwd=abc123")).toBe("passwd=[REDACTED]");
    expect(redactCredentials("パスワード：secret")).toBe("パスワード：[REDACTED]");
    expect(redactCredentials("비밀번호: secret")).toBe("비밀번호: [REDACTED]");
    expect(redactCredentials("contraseña: secret")).toBe("contraseña: [REDACTED]");
  });
});

describe("пара username+password", () => {
  test("CJK-пара с полноширинными разделителями (вариант owm)", () => {
    expect(redactCredentials("測試用戶名：shihlab，密碼：sushi")).toBe(
      "測試用戶名：[REDACTED]，密碼：[REDACTED]",
    );
  });

  test("ASCII-пара с запятой-разделителем", () => {
    expect(redactCredentials("username: alice, password: s3cret")).toBe(
      "username: [REDACTED], password: [REDACTED]",
    );
  });

  test("одиночный пароль обрезается по CJK-пунктуации (вариант owm)", () => {
    expect(redactCredentials("密碼：sushi，用於測試")).toBe("密碼：[REDACTED]，用於測試");
  });
});

describe("Bearer-токены", () => {
  test("голый токен и токен в заголовке Authorization (варианты owm)", () => {
    expect(redactCredentials("Bearer sk-test-123")).toBe("Bearer [REDACTED]");
    expect(redactCredentials("Authorization: Bearer sk-test-123")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
  });

  test("токен в кавычках внутри команды (вариант owm)", () => {
    expect(redactCredentials("curl -H 'Authorization: Bearer ghp_secret123'")).toBe(
      "curl -H 'Authorization: Bearer [REDACTED]'",
    );
  });

  test("метка «Bearer Token:» не обходит редакцию — значение убирает sensitive-правило (owm)", () => {
    expect(redactCredentials("Bearer Token: eyJhbGciOiJIUzI1...")).toBe("Bearer Token: [REDACTED]");
  });
});

describe("api_key/token/secret/credential/auth/private_key", () => {
  test("ASCII-лейблы и разделители (варианты owm)", () => {
    expect(redactCredentials("API_KEY: sk-123456789")).toBe("API_KEY: [REDACTED]");
    expect(redactCredentials("api key: sk-test-spaced")).toBe("api key: [REDACTED]");
    expect(redactCredentials("token=ghp_abc123")).toBe("token=[REDACTED]");
    expect(redactCredentials("api-key: sk-live-123")).toBe("api-key: [REDACTED]");
    expect(redactCredentials("GitHub Secret: ghp_abc123")).toBe("GitHub Secret: [REDACTED]");
    expect(redactCredentials("auth: abc123def")).toBe("auth: [REDACTED]");
    expect(redactCredentials("private_key: -----BEGIN")).toBe("private_key: [REDACTED]");
  });

  test("CJK-разделитель после лейбла (вариант owm)", () => {
    expect(redactCredentials("credential：abc123")).toBe("credential：[REDACTED]");
  });
});

describe("нейтральные формулировки не редактируются", () => {
  test("метка без значения после разделителя остаётся как есть (варианты owm)", () => {
    const benign = [
      "token budget is 5200 characters",
      "auth config uses OAuth",
      "secret manager is not supported",
      "private key handling is out of scope",
      "The api key is handled by the service",
      "api key concept is not a secret",
    ];
    for (const text of benign) {
      expect(redactCredentials(text)).toBe(text);
    }
  });
});

describe("идемпотентность", () => {
  test("повторная редакция уже отредактированного текста не меняет его (вариант owm)", () => {
    expect(redactCredentials("password: [REDACTED]")).toBe("password: [REDACTED]");
    const once = redactCredentialsRaw("password: hunter2");
    expect(redactCredentialsRaw(once)).toBe(once);
  });
});

describe("отпечаток редакции", () => {
  test("разные секреты с одним label дают разные маркеры, одинаковые — одинаковые", () => {
    const first = redactCredentialsRaw("api-key: AAAA1111");
    const second = redactCredentialsRaw("api-key: BBBB2222");
    const repeat = redactCredentialsRaw("api-key: AAAA1111");
    expect(first).not.toBe(second);
    expect(first).toBe(repeat);
  });

  test("формат маркера: [REDACTED:<8 hex sha256>], исходный секрет не появляется", () => {
    const out = redactCredentialsRaw("api-key: sk-live-abcdef123456");
    expect(out).toMatch(/^api-key: \[REDACTED:[0-9a-f]{8}\]$/);
    expect(out).not.toContain("sk-live-abcdef123456");
  });
});

describe("секрет не появляется в записанных файлах", () => {
  test("redactCredentials → node:fs writeFile → readFile без исходного секрета", async () => {
    const apiKey = "sk-live-abcdef123456";
    const password = "hunter2-secret";
    const text = `api_key: ${apiKey}\npassword: ${password}\n`;
    const redacted = redactCredentials(text);

    expect(redacted).not.toContain(apiKey);
    expect(redacted).not.toContain(password);
    expect(redacted).toContain("[REDACTED]");

    const dir = await mkdtemp(join(tmpdir(), "opencode-memory-991-redaction-test-"));
    try {
      const file = join(dir, "note.md");
      await writeFile(file, redacted, "utf8");
      const onDisk = await readFile(file, "utf8");
      expect(onDisk).toBe(redacted);
      expect(onDisk).not.toContain(apiKey);
      expect(onDisk).not.toContain(password);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
