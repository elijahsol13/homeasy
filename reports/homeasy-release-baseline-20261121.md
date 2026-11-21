# Homeasy: release baseline и план сведения Git

**21 ноября 2026, read-only Git / локальные сборки.** Это инвентаризация и порядок действий, а не опубликованный релиз. Продакшен, SQLite, сессии, скраперы, Docker-контейнеры и GitHub refs не менялись.

## Выбранная схема

| Ветка | Назначение | Точка до сведения |
| --- | --- | --- |
| `main` | Production: только проверенный и намеренно выпущенный код; оставить default branch | `7ad0ec7b08ab28d4d24cfd638a2be48303bb3774` |
| `develop` | Интеграция исходников, тесты и следующий релиз; начать от девяти уникальных коммитов VPS-подготовки | `9d57576cbf398d32cde2b73d246a63a33d8bca57` |

`feature/telegram-mini-app` (`23c6bd2`) целиком является предком `main` (behind 7/ahead 0). `codex/vps-migration-ready` (`9d57576`) на 9 коммитов впереди `main` без расхождения назад; его нельзя удалить до переноса истории в `develop`. После сохранения обоих путей в `develop` и проверки актуальных Pages Git-настроек обе временные удалённые ветки можно убрать. Никакого принудительного переписывания `main` не требуется. Старые формулировки в `agent_docs/decisions.md` о ветке Mini App описывают конфигурацию до последующих переключений и нуждаются в проверке перед удалением.

## Состав локального кандидата

- Текущий checkout: `main` в `7ad0ec7`, 58 изменённых отслеживаемых файлов. Незакоммиченный diff включает VPS/ingest, Bright Data control/worker, moderation v13, Khmer24, Web/TMA, тесты и эксплуатационные документы; `git diff --binary` SHA-256: `27b7e3a01b0681f79ae7dea5da9d07973af01ce48ad9ef7c0be31aaf0d884ae6` на момент инвентаризации. Это отпечаток только *tracked diff*, он не включает untracked.
- Ещё 795 untracked путей в выводе `git status --porcelain -uall`: 288 `.playwright-mcp/`, 340 `dist-tools/`, 3 `generated_images/`, 6 `qa/`, 97 `reports/`, 61 других. Первые четыре группы — локальные результаты браузера/сборки/QA, не исходники релиза. Среди остальных есть нужные новые `src/`, `tests/`, `scripts/`, `deploy/vps/`, `webapp/`, статические hero `.webp` и документация. `reports/` содержит как сводки, так и необезличенные исходные материалы/JSON/скриншоты; нельзя добавлять каталог целиком.
- `data/` игнорируется, `git ls-files data` пуст; текущий hook `.githooks` включён. Перед commit нужны явные списки путей, `git diff --cached --name-only`, `git diff --cached --check` и проверка `scripts/check-staged-private-files.cjs`; никаких `git add .`, `git clean` или reset.
- Три detached Codex worktree вне проекта: `analytics-page-type` чистый; `3cb7` имеет 4 пути; `public-nav-links` имеет 7 путей. Их frontend-изменения не равны соответствующим файлам в текущем checkout (кроме идентичного `PublicNavigation.test.tsx`). Перед архивированием двух грязных worktree нужно отдельно просмотреть/сохранить их diff и новые файлы; удалять их автоматически нельзя.

## Локальная проверка кандидата

| Проверка | Результат |
| --- | --- |
| `npm test -- --runInBand --silent` | 99 suites / 1092 tests PASS; Jest сообщает об открытом async handle после завершения |
| `npm --prefix webapp run test -- --run` | 14 files / 185 tests PASS |
| `npm run typecheck`, `npm run lint`, `npm run build` | PASS |
| `npx tsc -p tsconfig.brightdata.json` | PASS; `dist-tools/` локально генерируется |
| `npm --prefix webapp run build:web`, `build:tma` | PASS, предупреждение MapView chunk 1.21 MB |
| `git diff --check` | PASS |
| Compiled moderation | В `dist/modules/parser/canonical-dedupe.js` есть `reviewDefaultPending(this.db, scope ? [...new Set(listingIdByCandidate.values())] : undefined)`; Dockerfile копирует `dist/` из builder |
| Docker image | **Не проверен**: локальный Docker daemon/socket не запущен, а SSH-доступ к действующему VPS из этой среды блокируется до входа |

Локальные сборки подтверждают исходники, но **не** равенство с текущим VPS-образом или Pages-публикацией. Нельзя пересоздавать старый worker image: задокументированный hotfix находится лишь в его работающем контейнере. Manifest из Git SHA + image digest + Web/TMA artifact hashes и проверка rollback появятся только после зафиксированного source commit и реальной сборки образа.

## Порядок завершения при доступной записи в `.git`

1. Проверить свежие `origin/*`, актуальную Cloudflare Pages привязку веток и сохранность трёх worktree. Зафиксировать базу `main` и `9d57576` без принудительных pushes.
2. Создать `develop` от `codex/vps-migration-ready`. Аккуратно перенести текущий tracked diff и **выбранные** untracked исходники/документацию поверх девяти коммитов, разбирая пересечения. Сверить runtime-файлы и тесты; `data/`, приватные raw отчёты, секреты и generated output не stage.
3. Запустить перечисленные проверки на фактическом staged дереве, выполнить pre-commit guard, создать осмысленные коммиты. Убедиться, что рабочее дерево чистое, а исходный `main` не изменён; опубликовать `develop` без production deploy.
4. Сохранить отличающиеся правки двух Codex worktree (если нужны — в `develop`, если нет — в recoverable archive), затем убрать только проверенные пустые worktree. После подтверждения, что Pages не потребляет старые refs, удалить две временные remote ветки. Проверить локальные и remote refs: только `main`/`develop`.
5. После восстановления SSH-доступа к действующему VPS (`ssh ovh`, `/home/ubuntu/homeasy`) собрать проверяемый API/worker image из конкретного source SHA в безопасном окружении, проверить scoped moderation в image, записать image digest и оба frontend artifact hashes. Локальный Docker на Mac для этого не обязателен. До отдельного контролируемого выкладывания `main` остаётся текущим production baseline; после успешного релиза fast-forward `main` к проверенному коммиту и записать rollback SHA.

## Блокировка среды

Запись в `.git` исходного checkout запрещена политикой текущей среды. `git fetch origin --prune` прервался на `cannot open '.git/FETCH_HEAD': Operation not permitted` ещё до сетевого обращения; `git ls-remote origin` отдельно не смог разрешить `github.com`. GitHub connector успешно читает репозиторий, показывает `admin/push` права и три ветки, но его отдельные write-операции не решают локальное dirty tree; частичное изменение удалённых refs оставило бы работу несведённой. SSH-профиль `ovh` настроен на действующий VPS, предыдущие handoff подтверждают операции в `/home/ubuntu/homeasy`, но текущая попытка `ssh -o BatchMode=yes -o ConnectTimeout=8 -o StrictHostKeyChecking=yes ovh ...` получила `connect to host ... port 22: Operation not permitted` ещё до аутентификации. Это ограничение текущей среды, **не** доказательство отказа VPS. Здесь нельзя создать локальную ветку, stage/commit, довести checkout до clean status, проверить Docker image на VPS или безопасно завершить удаление веток. Для продолжения нужен доступ к локальному `.git` и исходящий SSH к VPS; локальный Docker не обязателен.
