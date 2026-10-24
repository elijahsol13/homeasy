# Homeasy: развёртывание на VPS своими руками с откатом

Цель: перенести **API, Telegram-бота, сбор Khmer24, SQLite и резервные копии** на VPS в Сингапуре (2 vCPU / 4 ГБ RAM / ~40 ГБ NVMe). Сайт и Mini App уже размещаются на Cloudflare Pages. **Facebook/Camoufox остаётся на Mac с домашним IP, своей сессией и отпечатком устройства.** Bright Data запускается по требованию отдельно, если потребуется.

Эта инструкция предназначена для **ручного выполнения владельцем**. Скрипты и конфигурация подготовлены, но фактическая миграция и VPS пока не проверялись. Ветка опубликована на GitHub: `codex/vps-migration-ready`; в ней должен присутствовать проверенный commit с кодом миграции `83c921a0a5178ba5ad7b33572c9dee61911f0b57`. Перед продолжением проверьте его наличие в истории ветки. В командах замените `USER`, `VPS_IP` своими значениями. Не публикуйте `.env`, ключи Cloudflare, базы или Facebook-сессии в Git, чате либо логах.

## 0. Как работает откат

До переключения Mac остаётся исходным рабочим сервером. Мы **останавливаем, но не удаляем** на нём существующие контейнеры и оставляем его SQLite/WAL/SHM и секреты нетронутыми. Снимок делаем средствами SQLite через уже существующую команду `npm run db:backup`. На VPS переносим **только проверенный снимок** базы, а не живой `homeasy.db` с Mac.

При ошибке до начала новой записи на VPS достаточно остановить серверные службы, отключить новый Cloudflare Tunnel и запустить сохранённые старые контейнеры Mac. После начала работы VPS базы могут разойтись: **автоматического обратного слияния нет**. При возвращении на Mac записи, появившиеся только на VPS, будут отсутствовать; перед откатом обязательно сохраните VPS-снимок и решите, допустима ли потеря изменений.

На VPS **не копировать** `data/fb_session.json`, `data/fb_device.json`, `data/fb_safety_state.json`, `data/fb_runtime.lock`, `data/fb_outbox/`, `data/k24_device.json` и целиком каталог `data/`. Для Khmer24 своя новая сессия может потребовать инициализации на Linux по штатной процедуре. Живую SQLite по сетевому диску между Mac и VPS не использовать.

## 1. Подготовить VPS без переключения трафика

Подключитесь из Terminal на Mac:

```bash
ssh USER@VPS_IP
```

Предполагается **Ubuntu или Debian**. Поставьте Git, curl, sqlite3, Python и Docker Engine/Compose по [официальной инструкции для Ubuntu](https://docs.docker.com/engine/install/ubuntu/) или [для Debian](https://docs.docker.com/engine/install/debian/). Не используйте случайные установочные скрипты. Убедитесь, что Docker запускается (`sudo docker version`, `sudo docker compose version`). При необходимости запускайте последующие команды Docker через `sudo`; добавление пользователя в группу `docker` даёт ему права, фактически равные root. Если система уже подготовлена, установку пропустите.

```bash
sudo apt-get update
sudo apt-get install -y git curl python3 sqlite3
free -h
df -h
sudo docker version
sudo docker compose version
```

При установленном и настроенном для текущего пользователя Docker следующие команды идут без `sudo`. Если `docker` сообщает permission denied — сначала настройте доступ к Docker; не меняйте права на системный сокет `chmod 666`.

В SSH-сессии на VPS:

```bash
git clone --branch codex/vps-migration-ready --single-branch https://github.com/elijahsol13/homeasy.git ~/homeasy
cd ~/homeasy
git show -s --format='%H %s' HEAD
git merge-base --is-ancestor 83c921a0a5178ba5ad7b33572c9dee61911f0b57 HEAD
git config --local core.hooksPath .githooks
mkdir -p data/incoming
cp deploy/vps/env.vps.template .env
chmod 600 .env
nano .env
```

`codex/vps-migration-ready` — опубликованная ветка с подготовленным кодом. Команда `git merge-base --is-ancestor 83c921a0a5178ba5ad7b33572c9dee61911f0b57 HEAD` должна завершиться с кодом 0. Это подтверждает, что в клоне есть проверенный код миграции; если команда завершилась с ошибкой, остановитесь и сверьте ветку. **Не клонируйте `main` вслепую.** Не копируйте Mac `.env` целиком; перенесите значения по ключам из шаблона и замените все `CHANGE_ME`.

В шаблоне перечислены все ключи из текущей конфигурации Mac, которые нужны VPS-сервисам: Telegram и администраторы; три настроенных AI-провайдера (`GROQ_API_KEY`, `GEMINI_API_KEY`, `CLOUDFLARE_API_KEY` с ID аккаунта); backend PostHog; публичные URL Mini App/tracking; `ADMIN_REVIEW_ALERTS_ENABLED` и `LOG_LEVEL`. Если на Mac задан `CLOUDFLARE_ACC_ID`, перенесите его значение под именем `CLOUDFLARE_ACCOUNT_ID`. `VITE_POSTHOG_API_KEY` и `VITE_POSTHOG_HOST` скопируйте в настройки сборки Cloudflare Pages для Mini App, не в серверный `.env`. `FB_PROXY` не используется текущим runtime — не переносите его. `BRIGHTDATA_API_KEY` заполните только если будете отдельно запускать одобренные ручные Bright Data-скрипты на VPS; поскольку Compose передаёт общий `.env` контейнерам api, bot и scraper, ключ окажется доступен каждому из них.

Создайте `FB_INGEST_TOKEN` длиной минимум 32 символа; удобно сгенерировать 64 шестнадцатеричных символа командой `openssl rand -hex 32`. Позже запишите **тот же** токен в Mac `.env`. `FB_INGEST_URL` на VPS не нужен. Compose сам задаёт `NODE_ENV`, `DATABASE_PATH`, `HOMEASY_DEPLOYMENT_ROLE`, API bind/port, canonical read path, canary IDs и canonical alerts, перекрывая одноимённые значения из `.env`.

Файл Cloudflare Tunnel `deploy/cloudflared/config.yml` уже входит в код и содержит существующие хосты `api.rustycat.cc` и `go.rustycat.cc`. С Mac отдельно и защищённо передайте на VPS **существующий** файл учётных данных туннеля `deploy/cloudflared/7d65861e-355d-45ce-8adf-498432aa148f.json` в тот же каталог. Команда с Mac (после замены адреса):

```bash
scp deploy/cloudflared/7d65861e-355d-45ce-8adf-498432aa148f.json USER@VPS_IP:homeasy/deploy/cloudflared/
```

На VPS: `chmod 600 deploy/cloudflared/*.json`. Не создавайте новый Cloudflare Tunnel и не меняйте DNS: используется **тот же named tunnel**. **Пока не запускайте сервис `tunnel` на VPS**, чтобы старый Mac-коннектор продолжал обслуживать трафик.

Соберите образы заранее (этап сборки скрапера с Camoufox может оказаться самым тяжёлым для 4 ГБ RAM):

```bash
docker compose config --quiet
docker compose build api bot backup
docker compose build scraper
docker image ls
free -h
df -h
```

При ошибке сборки смотрите её вывод, свободную память и место; не начинайте переключение. **В Docker Compose сняты старые лимиты RAM**, но 4 ГБ — физический предел VPS; возможен OOM в пике. Не запускайте пока ни один из контейнеров, так как ещё не перенесена база.

## 2. Сделать защищённую точку отката на Mac

Вернитесь в Terminal на Mac (в каталог проекта):

```bash
cd '/Users/lacr0s/!Projects/homeasy'
npm run db:backup
```

Это предварительная online-копия. Проверьте, что команда сообщила `Backup created successfully`. Убедитесь, что заранее подготовленный VPS действительно собрал образы, что вы можете подключиться по SSH и что на Mac остаются старые Docker-контейнеры.

В **момент согласованного простоя** остановите все пишущие в базу службы Mac, включая API и bot, чтобы не потерять записи, сделанные после финального снимка. Предварительно проверьте реальные имена запущенных контейнеров командой `docker ps --format 'table {{.Names}}\t{{.Status}}'`: ниже приведены имена действующего проекта, и если они отличаются, сначала уточните соответствие сервисам. Дополнительные процессы Node вне Docker, пишущие в эту базу, тоже должны быть остановлены:

```bash
docker stop homeasy-scraper homeasy-bot homeasy-api homeasy-backup
docker ps --format 'table {{.Names}}\t{{.Status}}'
BACKUP_LOG="$(mktemp)"
if ! npm run db:backup >"$BACKUP_LOG" 2>&1; then cat "$BACKUP_LOG"; exit 1; fi
cat "$BACKUP_LOG"
```

> ВАЖНО: текущий `docker-compose.yml` предназначен для VPS. На Mac останавливаем **именно существующие контейнеры по их проверенным именам**. Не делайте `docker compose up`, `build`, `down`, `rm` или `docker system prune` на Mac до окончания миграции: это усложнит восстановление старых контейнеров.

Зафиксируйте снимок вне каталога с ротацией и проверьте его. Команды ниже выполняются **на Mac**; при нестандартном `DATABASE_PATH` предварительно проверьте путь и используйте соответствующий каталог резервных копий:

```bash
FINAL_BACKUP="data/backups/$(sed -n 's/^.*File:[[:space:]]*\(homeasy_backup_[^[:space:]]*\.db\).*$/\1/p' "$BACKUP_LOG" | tail -n 1)"
test -s "$FINAL_BACKUP" || { echo 'СТОП: невозможно однозначно найти только что созданный снимок'; exit 1; }
rm "$BACKUP_LOG"
mkdir -p data/migration-rollback
ROLLBACK_COPY="data/migration-rollback/homeasy_before_vps_$(date -u +%Y%m%dT%H%M%SZ).db"
cp -p "$FINAL_BACKUP" "$ROLLBACK_COPY"
chmod 600 "$ROLLBACK_COPY"
sqlite3 "$ROLLBACK_COPY" 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
shasum -a 256 "$ROLLBACK_COPY"
```

Ожидается **`ok`** и отсутствие строк с ошибками foreign-key. Запишите SHA-256. Если есть ошибка — **не продолжайте**. Если `sqlite3` отсутствует на Mac, установите его либо выполните эквивалентную проверку через SQLite API. Не удаляйте `.db-wal` и `.db-shm` исходной Mac-базы.

## 3. Передать финальный снимок на VPS

С Mac, с тем же значением `ROLLBACK_COPY`:

```bash
scp -p "$ROLLBACK_COPY" USER@VPS_IP:homeasy/data/incoming/homeasy-cutover.db
```

На VPS:

```bash
cd ~/homeasy
test -s data/incoming/homeasy-cutover.db
sha256sum data/incoming/homeasy-cutover.db
sqlite3 data/incoming/homeasy-cutover.db 'PRAGMA integrity_check; PRAGMA foreign_key_check;'
if test -e data/homeasy.db; then echo 'СТОП: на VPS уже есть база, файл не тронут'; exit 1; fi
mv data/incoming/homeasy-cutover.db data/homeasy.db
chmod 600 data/homeasy.db
```

**Сверьте SHA-256 с Mac побуквенно**, а проверку SQLite — с результатом `ok` без ошибок внешних ключей **до выполнения `mv`**. Если файл `data/homeasy.db` уже существует, команда завершает SSH-сессию с ошибкой; выясните происхождение файла перед продолжением. Не переносите исходную Mac SQLite с её активным WAL вместо снимка.

## 4. Запустить API и бэкап без переключения DNS

На VPS:

```bash
docker compose up -d --no-deps api backup
docker compose ps
curl -fsS http://127.0.0.1:3000/health
docker compose logs --tail=80 api backup
```

Проверьте, что `api` отвечает, а backup после первого запланированного снимка становится `healthy`. Пока `tunnel` и `bot` не запущены, публичный трафик обслуживал прежний Mac до остановки API. В этой фазе небольшой простой публичного API ожидаем. **Не запускайте два Telegram-бота с одним токеном.**

## 5. Переключить Cloudflare Tunnel и Telegram-бота

Только после проверки VPS API — на Mac:

```bash
docker stop homeasy-tunnel
```

Затем на VPS:

```bash
docker compose up -d --no-deps tunnel
docker compose logs --tail=80 tunnel
curl -fsS https://api.rustycat.cc/health
curl -fsS https://api.rustycat.cc/api/v1/filters/metadata
docker compose up -d --no-deps bot
docker compose logs --tail=80 bot
```

Проверьте вручную Telegram-бота, сайт `https://homeasy.rustycat.cc/`, выдачу объявлений, фильтры и карточку. Проверьте, что **на Mac bot/scraper/API/backup и tunnel остановлены**, и что единственный работающий Cloudflare-коннектор этого туннеля теперь на VPS. Одновременный запуск старого Mac и нового VPS-коннектора к одному туннелю распределит запросы между ними и может нарушить доступность API.

## 6. Включить Khmer24 и передачу Facebook с Mac

Khmer24 **не проверялся** с IP дата-центра Сингапура. Даже HTTP 200 с сайта ещё не гарантирует, что Camoufox извлекает объявления. Сначала выполните **один ограниченный проход по одной категории, максимум одно объявление**, через уже существующий CLI Khmer24. Он использует временную SQLite и `--dump-raw`, поэтому не импортирует найденное в рабочую базу и не вызывает AI-обогащение. Команда запускает отдельный одноразовый контейнер, а не постоянный сервис:

```bash
curl -I --max-time 10 https://www.khmer24.com/
docker compose run --rm --no-deps scraper node dist/modules/parser/khmer24.scraper.js --target=0 --limit-listings=1 --no-enrich --dump-raw=/tmp/k24-smoke.json --db-path=/tmp/k24-smoke.db
```

**Смотрите фактический итог в stdout:** нужно `Total Scraped` больше нуля при `Errors: 0`. Нулевое число объявлений или успешный код выхода сами по себе ничего не доказывают. При Cloudflare 403, отсутствии объявлений или иных ошибках не запускайте постоянный скрапер. `npm run k24:login` предполагает интерактивное графическое окно Camoufox: на обычном VPS без графической сессии этот сценарий автоматически не заработает; понадобится отдельный ручной способ входа на Linux. Если ограниченный проход действительно успешен, включите штатный цикл:

```bash
docker compose up -d --no-deps scraper
docker compose logs --tail=160 -f scraper
```

Остановите наблюдение `Ctrl+C` (контейнер продолжит работу). При повторяющихся ошибках выполните `docker compose stop scraper`. **Facebook не запускается на VPS:** отдельная точка входа принудительно исключает его из расписания, а локальные Facebook-команды проверяют роль VPS.

Только после успешного API-переключения дополните **локальный Mac `.env`**:

```dotenv
FB_INGEST_URL=https://api.rustycat.cc/api/v1/internal/facebook/ingest
FB_INGEST_TOKEN=ТОТ_ЖЕ_64_СИМВОЛЬНЫЙ_ТОКЕН_ЧТО_НА_VPS
```

На Mac при необходимости отправьте накопившиеся пакеты **без запуска Facebook-браузера** командой `npm run fb:flush-outbox`. Следующий запуск `npm run scrape:fb` должен выполняться только на Mac и только при штатном состоянии аккаунта и Camoufox; проверять его на VPS нельзя. Пакеты сохраняются в `data/fb_outbox/` до полного подтверждения сервером. Смена токена/адреса или отсутствие связи сохраняют очередь; не удаляйте её вручную. После перехода Mac больше не пишет новые Facebook-посты в локальную SQLite. Отдельного расписания Facebook на Mac пока нет.

## 7. Контроль и ограничения

На VPS из `~/homeasy`:

```bash
bash scripts/vps-status.sh
docker compose ps
docker compose logs --tail=80 api bot scraper backup tunnel
free -h
df -h
```

Мониторинг ручной: проверяйте ежедневно первую неделю, затем хотя бы раз в неделю. Сигналы: диск ≥85%, OOM/restarts, API без ответа, просроченный бэкап (>24 ч), ошибки Khmer24/Telegram и рост очереди `data/fb_outbox/` на Mac. Если сервис `scraper` ещё намеренно не запущен, `vps-status.sh` покажет общий статус CHECK — это ожидаемо на промежуточном этапе. Бэкапы на VPS хранятся **на том же диске** (примерно каждые 12 часов, с ротацией): они не защищают от полной потери VPS. Снимок на Mac — отдельная миграционная точка восстановления. Новый платный мониторинг и резервный сервер не требуются.

## 8. Откат

**Если VPS ещё не принимал новые данные**, восстановление простое. На VPS:

```bash
cd ~/homeasy
docker compose stop scraper bot tunnel api backup
```

На Mac:

```bash
docker start homeasy-api homeasy-backup
docker start homeasy-tunnel
docker start homeasy-bot homeasy-scraper
```

Проверьте `docker ps`, `curl -fsS https://api.rustycat.cc/health`, бота и выдачу. Это запускает **старые сохранённые контейнеры с прежними образами**, не пересоздавая их из нового VPS Compose. Если успели настроить `FB_INGEST_URL` на Mac, отключите его перед следующим ручным Facebook-запуском, чтобы вернуть локальный режим. Локальную SQLite не перезаписывайте: старая база и WAL остались на Mac.

**Если VPS уже принимал новые объявления, изменения настроек, избранное или данные пользователей**, перед остановкой VPS сделайте дополнительный проверенный снимок сервера:

```bash
docker compose stop scraper bot tunnel
docker compose exec -T api node dist/database/backup.js
```

Найдите созданный снимок в `data/backups/`, проверьте целостность и сохраните отдельную копию **вне VPS** (например, по `scp` на Mac). Только затем останавливайте VPS API/tunnel и возвращайтесь к Mac. Выбор между потерей появившихся на VPS изменений и отдельным переносом данных — ручное решение; безопасного автоматического объединения двух SQLite нет. Никогда не запускайте одновременно двух писателей на разных копиях базы с расчётом потом их слить.

**Граница проверки на момент подготовки:** тесты/линтер/сборка и конфигурация Compose выполняются локально. Реальная сборка образа на Linux VPS, Telegram cutover, Cloudflare Tunnel и Mac→VPS HTTPS ingestion нуждаются в ваших наблюдениях на указанном этапе. При любой нестыковке остановитесь на текущем шаге, пришлите вывод ошибки **без секретов** и не начинайте следующие этапы.
