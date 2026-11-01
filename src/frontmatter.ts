export const MEMORY_TYPES = ["user", "feedback", "project", "reference"] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export interface FrontmatterFields {
  name: string;
  description: string;
  type: MemoryType;
}

export interface ParsedFrontmatter {
  /** Поле name (undefined — отсутствует в блоке). */
  name: string | undefined;
  /** Поле description (undefined — отсутствует в блоке). */
  description: string | undefined;
  /** metadata.type, если значение входит в enum; undefined — отсутствует или вне enum. */
  type: MemoryType | undefined;
  /** Сырая строка metadata.type (undefined — поля нет): различает «вне enum» от «отсутствует». */
  typeRaw: string | undefined;
  /** Всё после закрывающего «---», дословно. */
  body: string;
}

/**
 * Парс первых строк файла: открывающий «---» первой строкой, записи «ключ: значение»
 * до закрывающего «---», всё после — тело. Структурно повреждённый блок (нет разделителей,
 * мусор вместо маппинга) — явный throw; частичный блок (разделители на месте, полей нет
 * или type вне enum) — без throw, отсутствие/невалидность полей различимы в результате.
 * Минимальный парсер ровно под поля name/description/metadata.type, не общий YAML.
 */
export function parseFrontmatter(source: string): ParsedFrontmatter {
  const lines = source.split("\n");
  const openIndex = lines.findIndex((line) => line.trim() === "---");
  if (openIndex !== 0) {
    throw new Error("Повреждённый frontmatter: первая строка файла не «---»");
  }
  const closeIndex = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (closeIndex === -1) {
    throw new Error("Повреждённый frontmatter: нет закрывающего «---»");
  }

  let name: string | undefined;
  let description: string | undefined;
  let typeRaw: string | undefined;
  let metadataOpen = false;
  for (const line of lines.slice(1, closeIndex)) {
    if (line.trim() === "") {
      continue;
    }
    const colonIndex = line.indexOf(":");
    if (colonIndex === -1) {
      throw new Error(
        `Повреждённый frontmatter: строка «${line.trim()}» не является записью «ключ: значение»`,
      );
    }
    const key = line.slice(0, colonIndex).trim();
    const value = scalarValue(line.slice(colonIndex + 1));
    if (line.startsWith(" ") || line.startsWith("\t")) {
      if (metadataOpen && key === "type") {
        typeRaw = value;
      }
    } else {
      metadataOpen = key === "metadata" && value === "";
      if (key === "name") {
        name = value;
      } else if (key === "description") {
        description = value;
      }
    }
  }

  const type = typeRaw !== undefined && isMemoryType(typeRaw) ? typeRaw : undefined;
  return { name, description, type, typeRaw, body: lines.slice(closeIndex + 1).join("\n") };
}

/** Канонический вид zcode: «---», name, description, вложенный metadata.type, «---», тело. */
export function serializeFrontmatter(fields: FrontmatterFields, body: string): string {
  return [
    "---",
    `name: ${fields.name}`,
    `description: ${fields.description}`,
    "metadata:",
    `  type: ${fields.type}`,
    "---",
    body,
  ].join("\n");
}

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}

/** Значение скаляра: обрезка пробелов, снятие одной пары обрамляющих кавычек. */
function scalarValue(raw: string): string {
  const value = raw.trim();
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}
