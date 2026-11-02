# AGENTS.md

Плагин памяти для opencode v2 (`opencode-memory-991`; в npm публикуется как `ocm991`). Потребление — через npm-имя `ocm991` в `plugin`-массиве конфига opencode; при разработке — локальный путь в глобальном `~/.config/opencode/opencode.json` (hot-reload).

- Стек: TypeScript, Bun. Без runtime-зависимостей. Тесты: `bun test` из корня (в этом репо можно, в отличие от monorepo opencode).
- Планы и актуальная документация — в `openspec/` (главные спеки `openspec/specs/`, завершённые change — `openspec/changes/archive/`); не расширяй скоуп без запроса.
- Формат на диске — 1:1 zcode: `~/.local/share/opencode-memory/projects/<slug>-<hash16>/memory/`, `MEMORY.md` + `*.md` с frontmatter `name`/`description`/`metadata.type` (user|feedback|project|reference). Не менять без явного запроса.
- Обязательные инварианты:
  - у каждого инструмента `options: { codemode: false }`;
  - инжект в `session.hook("context")` детерминирован на сессию (снапшот MEMORY.md, не перечитывать каждый ход);
  - никакой сети, eval, install-скриптов; креды редакдируются на входе (`src/redaction.ts`).
- `src/storage.ts` и `src/redaction.ts` — трансплантаты из `~/Documents/GitHub/opencode-working-memory/src/` (без evidence-хуков). Не переусложнять; синк с апстримом вручную.
- Промпт-текст секции Memory брать из zcode (`ZCode/apps/zcode-cli/packages/core/src/context/sections/memory.ts`), не сочинять заново.
- Стиль: минимум сущностей, `const`, без `any` и без alias-импортов, Bun API (`Bun.file`) где уместно.
- Формат/линт: Biome (`biome.json` — двойные кавычки, `;`, trailing commas all, ширина 100, сортировка импортов, пресет recommended; область — `src/**` + корневые конфиги). Автофикс: `bun run lint:fix`.
- Гейт перед коммитом: `bun run check` = `biome check` + `tsc --noEmit` + `bun test`. DevDeps (`@biomejs/biome`, `typescript`, `@types/bun`) разрешены; runtime-зависимости — нет. Bun живёт в `~/.bun/bin` (в чистом шелле добавь в PATH).
- Коммиты: conventional (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`), сообщения по-русски. Ветки: до трёх слов через дефис, без слэшей и префиксов типа `feat/`.
