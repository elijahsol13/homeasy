# Homeasy — проверяемая сборка, выпуск и откат

Утверждённый первый этап модернизации описан в [modernization_plan.md](modernization_plan.md). Production требует отдельного явного решения о релизе. Этот документ задаёт техническую процедуру, проверяемую по Git SHA и хэшам. Текущие состояние VPS и Pages, включая отступления, фиксируются в [latest_session_work.md](latest_session_work.md).

## 1. Идентификатор версии

- Единственный источник кода для релиза — полный Git SHA коммита с успешными проверками CI. `develop` — интеграция. `main` — утверждённый production-код. Мерж `develop` → `main` проводится отдельно от выкладки.
- Два пользовательских артефакта `web` и `tma` собираются отдельно из **того же SHA**. Команда `node scripts/write-release-manifest.cjs web|tma` записывает `release-manifest.json` рядом с `index.html`. Манифест включает SHA, режим, список файлов и SHA-256 каждого файла, общий хэш набора файлов.
- Для Docker всегда фиксируются `org.opencontainers.image.revision`, имя тега и `docker image inspect ... --format '{{.Id}}'` — идентификатор локального образа. Если образ загружен в Registry, дополнительно фиксируется *registry digest* `repository@sha256:...`. Image ID и registry digest имеют разный смысл.
- Для Cloudflare Pages дополнительно фиксируются **project name, deployment ID, deployment URL, source commit SHA, branch, UTC-дата и загруженный manifest hash**. Не считать совпадение только имени ветки доказательством совпадения опубликованной версии.

CI собирает и сохраняет артефакты по SHA. Официальные страницы и VPS не обновляются самим CI.

## 2. Изолированная проверка на `develop`

В GitHub Actions workflow `.github/workflows/ci.yml` запущен на `develop`, `main` и PR. Он выполняет установку зависимостей из lockfile, статические проверки, тесты и сборки. CI использует фиктивный Telegram-токен, in-memory SQLite, и не содержит prod-секретов. Артефакты Web и TMA маркируются commit SHA.

Для ручной проверки в чистой копии после `npm ci` и `npm --prefix webapp ci`:

```bash
npm run typecheck
npm run lint
npm run build
npx tsc -p tsconfig.brightdata.json
BOT_TOKEN='123456789:CI_dummy_token' TELEGRAM_MINIAPP_URL='https://t.me/homeasy_ci_bot/test' DATABASE_PATH=':memory:' npm test -- --runInBand --silent
npm --prefix webapp run lint
npm --prefix webapp run test
npm --prefix webapp run build:web
node scripts/write-release-manifest.cjs web
# Сохранить каталог webapp/dist отдельно перед второй сборкой
npm --prefix webapp run build:tma
node scripts/write-release-manifest.cjs tma
```

`vite build` перезаписывает `webapp/dist`: артефакты Web и TMA должны сохраняться в разные каталоги. Runtime URL и аналитические VITE_* переменные публичны в браузерной сборке. Проверять используемые настройки каждого Pages-проекта отдельно. CI не подменяет его конфигурацию.

## 3. Сборка образов из фиксированного SHA на VPS

Выполнять только после утверждения релиза и проверки бэкапа. Подготовить **чистую** копию выбранного коммита отдельно от текущего dirty checkout. Не менять `.env`, `data/`, текущие контейнеры и туннель при подготовке.

```bash
SHA="$(git rev-parse HEAD)"
test -z "$(git status --porcelain --untracked-files=no)" || { echo 'Dirty source tree'; exit 1; }
docker build --target api-runner --label "org.opencontainers.image.revision=$SHA" -t "homeasy-api:$SHA" .
docker build --target runner --label "org.opencontainers.image.revision=$SHA" -t "homeasy-scraper:$SHA" .
docker image inspect "homeasy-api:$SHA" --format '{{.Id}}'
docker image inspect "homeasy-scraper:$SHA" --format '{{.Id}}'
```

Сохранить SHA и image ID в отдельном журнале релиза. Повторная сборка может получить другой image ID из-за обновившихся внешних пакетов. **Откат опирается на сохранённый локальный image ID/тег или digest Registry**, а не на повторную сборку старого Git SHA.

После сохранения образов текущего релиза и проверки совместимости схемы/данных при санкционированном переключении использовать overlay `deploy/vps/compose.release.yml`:

```bash
export HOMEASY_API_IMAGE="homeasy-api:$SHA"
export HOMEASY_SCRAPER_IMAGE="homeasy-scraper:$SHA"
docker compose -f docker-compose.yml -f deploy/vps/compose.release.yml config --quiet
# Только во время утверждённого релиза:
docker compose -f docker-compose.yml -f deploy/vps/compose.release.yml up -d --no-build
docker compose -f docker-compose.yml -f deploy/vps/compose.release.yml ps
```

После запуска проверить `/health`, фильтры API, выдачу каталога и Telegram, статус фоновых сервисов, резервный снимок и отсутствие ошибок. Настройки Docker Compose и переменные окружения следует взять из утверждённой версии того же SHA. До release-переключения зафиксировать точные прежние image IDs и команды для возврата.

## 4. Откат VPS

Сначала остановить меняющие состояние службы в случае ошибки релиза, затем сделать отдельный резервный снимок **актуальной** SQLite, сохранив WAL/SHM. При изменении схемы или данных между релизами проверять совместимость перед возвратом прежнего кода. Вернуть `HOMEASY_API_IMAGE` и `HOMEASY_SCRAPER_IMAGE` к сохранённым проверенным образам, исполнить утверждённый `docker compose ... up -d --no-build`, проверить API/бота/фоновую очередь и состояние БД. Не переключать два экземпляра Telegram-бота одновременно. Не удалять старые образы до завершения периода проверки.

Восстановление более раннего состояния **базы** — отдельное действие с проверкой целостности и возможной потерей новых записей. Процедура сохранения SQLite/остановки писателей приведена в [OPERATOR_GUIDE_RU.md](OPERATOR_GUIDE_RU.md). Любой rollback с изменением реальных данных должен быть отдельно одобрен.

## 5. Cloudflare Pages Web и TMA

Проверка Dashboard 2026-11-21 установила, что действующий Web `homeasy.rustycat.cc` принадлежит Pages-проекту `homeasy-web-preview-20261110`, а TMA `tma.rustycat.cc` — `homeasy-tma-20261111`. **У обоих нет Git connection**. Метка `Source main` для ручной загрузки не означает автоматическую сборку из GitHub. Отдельный прежний проект `homeasy-app` привязан к GitHub `elijahsol13/homeasy` с production branch `main`, корневым каталогом `webapp`, командой `npm run build` и автоматическими деплоями. Он не обслуживает указанные выше публичные Web/TMA домены. Перед каждым релизом проверять актуальные доменные привязки снова.

До публикации каждого из двух актуальных проектов сохранить предыдущие deployment ID и URL, а также выписать прежний SHA, если его можно подтвердить. После отдельного утверждения выпуска использовать соответствующие Web (`--mode web`) и TMA (`--mode telegram`) CI-артефакты **одного проверенного SHA** и штатный Pages upload/deploy. Проверить в загруженном `release-manifest.json` поля `gitSha` и `contentTreeSha256`, записать deployment ID/URL и проверить публичную страницу, навигацию, карточки и контакты. Git push в `main` или `develop` сам по себе не обновит эти два проекта.

В случае неисправного релиза использовать штатный Rollback соответствующего Pages-проекта к заранее сохранённому успешному deployment, проверить активный deployment ID и публичный URL. Такой откат не затрагивает VPS или SQLite. **Реальный rollback актуальных Pages-проектов пока не репетировали.**

## 6. Контроль веток

**Выполнено 2026-11-21.** После проверки истории коммитов, успешного CI, Cloudflare Pages и текущего VPS checkout удалены удалённые refs `codex/vps-migration-ready` (`9d57576`) и `feature/telegram-mini-app` (`23c6bd2`) с `--force-with-lease` по точному SHA. `git ls-remote --heads origin` вернул только `main` (`7ad0ec7`) и `develop` (`16cf564` до последующих документационных коммитов). Удалённые ветки остаются восстановимы из истории surviving branches.

На VPS работающий checkout остаётся локально на исторической ветке `codex/vps-migration-ready` при SHA `07bf9eb` с 20 изменёнными/новыми путями и прежним tracking-метаданными. Не переключать и не делать `git pull` в этом каталоге ради уборки Git. Его согласование с `main` и deployment image digest требует отдельного утверждённого выпуска с сохранением локальных overlay, образов и состояния данных. Mac main и три detached worktree сохранены.
