import { afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousXdgDataHome = process.env.XDG_DATA_HOME;
const testXdgDataHome = await mkdtemp(join(tmpdir(), "opencode-memory-991-test-xdg-"));

process.env.XDG_DATA_HOME = testXdgDataHome;

afterAll(async () => {
  if (previousXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdgDataHome;

  await rm(testXdgDataHome, { recursive: true, force: true });
});
