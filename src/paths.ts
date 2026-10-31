export function resolveMemoryRoot(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_DATA_HOME ?? `${env.HOME ?? "~"}/.local/share`;
  return `${base}/opencode-memory`;
}
