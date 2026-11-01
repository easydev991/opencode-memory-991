/**
 * Перенесено из opencode-working-memory (https://github.com/sdwolf4103/opencode-working-memory),
 * лицензия MIT — Copyright (c) 2026 OpenCode Working Memory Contributors.
 * Синхронизация с апстримом — вручную.
 */

/**
 * Shared redaction utilities for sensitive credential patterns.
 * Used by both workspace memory normalization and extraction rejection logging.
 */

// Password labels in multiple languages
const PASSWORD_LABELS =
  /password|passwd|pwd|密碼|密码|パスワード|비밀번호|contraseña|mot de passe|passwort/i;

// Username labels in multiple languages
const USERNAME_LABELS =
  /username|user name|用戶名|用户名|ユーザー名|사용자명|usuario|utilisateur|benutzer/i;

// Sensitive key labels
const SENSITIVE_LABELS =
  /api(?:[_\s-]?key)|token|bearer|secret|credential|auth|auth[_-]?key|private[_-]?key/i;

// Secret value pattern (excludes common delimiters and brackets)
const SECRET_VALUE = String.raw`[^` + "`" + String.raw`'",，,\s\[]+`;

// Prefix patterns for different credential types
const PIN_PREFIX = String.raw`(\bPIN\b(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const PASSWORD_PREFIX = String.raw`((?:${PASSWORD_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const USERNAME_PREFIX = String.raw`((?:${USERNAME_LABELS.source})(?:\s*(?:是|=|:|：)\s*|\s+(?![是=:：])))`;
const SENSITIVE_PREFIX = String.raw`((?:${SENSITIVE_LABELS.source})(?:\s*(?:推|是|=|:|：)\s*|[:：]\s*))`;
const BEARER_PREFIX = String.raw`(Bearer\s+)`;

/**
 * Отпечаток отредактированного значения: первые 8 hex-символов sha256 исходного
 * секрета. Разные креды с одним label получают разные маркеры (дедуп в plugin.ts
 * их не схлопывает), одинаковые — одинаковые (точный дубликат по-прежнему дедупится);
 * сам секрет нигде не хранится. Локальный форк от апстрима opencode-working-memory:
 * при ручном синке не затирать.
 */
function fingerprint(secret: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(secret);
  return hasher.digest("hex").slice(0, 8);
}

/** Маркер редакции с отпечатком; `[` исключён из SECRET_VALUE — повторная редакция идемпотентна. */
function redacted(secret: string): string {
  return `[REDACTED:${fingerprint(secret)}]`;
}

/**
 * Redacts sensitive credentials from text.
 * Handles:
 * - PINs in multiple formats
 * - Username/password pairs
 * - Standalone passwords
 * - Bearer tokens
 * - API keys, secrets, credentials, auth tokens, private keys
 *
 * Supports multiple languages and delimiters (ASCII and CJK).
 */
export function redactCredentials(text: string): string {
  let result = text;

  // 1. PIN
  result = result.replace(
    new RegExp(String.raw`${PIN_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    (_match, prefix: string, secret: string) => prefix + redacted(secret),
  );

  // 2. Username+password pair
  result = result.replace(
    new RegExp(
      String.raw`${USERNAME_PREFIX}[\`'"]?(${SECRET_VALUE})((?:，|,)\s*)${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`,
      "gi",
    ),
    (_match, userPrefix: string, user: string, comma: string, passPrefix: string, pass: string) =>
      userPrefix + redacted(user) + comma + passPrefix + redacted(pass),
  );

  // 3. Standalone password
  result = result.replace(
    new RegExp(String.raw`${PASSWORD_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    (_match, prefix: string, secret: string) => prefix + redacted(secret),
  );

  // 4. Bearer tokens (but not "bearer token:" labels)
  result = result.replace(
    new RegExp(String.raw`${BEARER_PREFIX}(?!token\s*[:=：])[\`'"]?(${SECRET_VALUE})`, "gi"),
    (_match, prefix: string, secret: string) => prefix + redacted(secret),
  );

  // 5. Sensitive keys/tokens
  result = result.replace(
    new RegExp(String.raw`${SENSITIVE_PREFIX}[\`'"]?(${SECRET_VALUE})`, "gi"),
    (_match, prefix: string, secret: string) => prefix + redacted(secret),
  );

  return result;
}
