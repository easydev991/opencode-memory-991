import { createHash } from "node:crypto";
import { basename } from "node:path";

export function resolveMemoryRoot(env: Record<string, string | undefined> = process.env): string {
  // Пустая строка XDG_DATA_HOME/HOME считается отсутствующей: иначе путь ушёл бы в корень ФС.
  const base = env.XDG_DATA_HOME || `${env.HOME || "~"}/.local/share`;
  return `${base}/opencode-memory`;
}

export function resolveProjectMemoryDir(
  projectCanonical: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const hash = createHash("sha256").update(projectCanonical).digest("hex").slice(0, 16);
  const slug = sanitizeProjectSlug(basename(projectCanonical) || "project");
  return `${resolveMemoryRoot(env)}/projects/${slug}-${hash}/memory`;
}

function sanitizeProjectSlug(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "project";
}
