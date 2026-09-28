# 🏡 HomEasy — Агрегатор недвижимости Камбоджи, Telegram-бот и Mini App

> Корпоративный агрегатор недвижимости, система оповещений и интерактивное Telegram Mini App (TMA) для **Сиемреапа** и **Пномпеня**, Камбоджа.
>
> Стек: **TypeScript · Node.js 22+ (Native SQLite WAL) · grammY · Fastify · React / Vite · Camoufox под управлением Playwright · Google Gemini · Sharp (pHash) · Cloudflare Zero Trust · Docker Compose**.

---

## 🏛️ Архитектура системы (High-Level Architecture)

```
                       ┌──────────────────────────────────────────────┐
                       │          Cloudflare Quick Tunnel             │
                       │    (Free SSL, Persistent, No Domain Needed)  │
                       └──────────────────────┬───────────────────────┘
                                              │ WSS / HTTPS
                     ┌────────────────────────┴────────────────────────┐
                     │                                                 │
                     ▼                                                 ▼
      ┌─────────────────────────────┐                  ┌──────────────────────────────┐
      │      Telegram Bot UI        │                  │      Fastify API & Admin     │
      │        (homeasy-bot)        │                  │        (homeasy-api)         │
      │  grammY · Filters · Alerts  │                  │  REST API · WSS Screencast   │
      └──────────────┬──────────────┘                  └──────────────┬───────────────┘
                     │                                                │
                     │          ┌──────────────────────────┐          │
                     ├─────────►│  Shared SQLite Database  │◄─────────┤
                     │          │   (data/homeasy.db WAL)  │          │
                     │          └─────────────▲────────────┘          │
                     │                        │                       │
                     │          ┌─────────────┴────────────┐          │
                     └─────────►│ Playwright Scraper Worker│◄─────────┘
                                │    (homeasy-scraper)     │
                                │ GraphQL Relay · Stealth  │
                                └─────────────┬────────────┘
                                              │ Proxy Tunnel
                                              ▼
                                ┌──────────────────────────┐
                                │ Cambodian Resident Proxy │
                                │   (FB_PROXY / K24 Proxy) │
                                └──────────────────────────┘
```

---

## 🛡️ Ключевые архитектурные решения

### 0. ⚡ ЖЕЛЕЗОБЕТОННЫЙ ЗАКОН: ЭКОНОМИЯ ТРАФИКА РЕЗИДЕНТНЫХ ПРОКСИ
> ⚠️ **КРИТИЧЕСКИЙ ПРИНЦИП ПРОЕКТА**: Трафик резидентных прокси тарифицируется за каждый гигабайт ($2–$10+/ГБ).  
> **ИЩЕМ, ПРЕДЛАГАЕМ И ЖЕСТКО ВНЕДРЯЕМ ВАРИАНТЫ ЭКОНОМИИ ТРАФИКА В ЛЮБОМ КОДЕ С ПРОКСИ!**  
> Любая утечка трафика на загрузку медиа или нефильтрованный браузинг считается критической ошибкой.
>
> 1. **Запрет нефильтрованных контекстов**: Запрещено запускать Chromium и переходить по URL (`page.goto`) без активного роутинга (`page.route` / `attachTrafficGuard`).
> 2. **100% блокировка бинарных медиа (фото, видео, аудио)**: URL фото извлекаются строками из JSON API (GraphQL) или DOM-атрибутов. Сам браузер **никогда не должен скачивать бинарники изображений и видео** (экономия 85–95% трафика на страницу!).
> 3. **Блокировка шрифтов, стилей и телеметрии**: Шрифты, CSS и аналитические маяки (`facebook.com/ajax/bz`, `facebook.com/tr/`, Google Analytics, пиксели, falco, speed telemetry) блокируются безусловно.
> 4. **Закреплённая identity**: Ручной вход и scraper используют один host-specific Camoufox fingerprint и storage state; каждый новый browser process начинает с холодным HTTP-кэшем.
> 5. **Ротация групп Round-Robin**: Обход скользящим окном по 5 групп за цикл (с сохранением курсора в `data/scraper_state.json`) с увеличенной паузой между циклами 110 минут (~12 циклов в сутки).
> 6. **Интеллектуальный Early Exit**: Досрочная остановка пагинации (`FB_EARLY_EXIT_THRESHOLD=3`) при встрече идущих подряд дубликатов с лимитом не более 1 скролла на группу (`FB_MAX_SCROLLS_PER_GROUP=1`).
> 7. **Direct-by-default**: Facebook работает через локальный камбоджийский IP; proxy включается только явно. Khmer24, внутренние сервисы, AI API и Telegram API никогда не наследуют Facebook proxy.

### 1. Архитектура трех контейнеров (Trio-Container Architecture)
- **`homeasy-bot`**: Поллинг и UI Telegram-бота (grammY), интерактивный визард поиска, подписки, мгновенные пуш-уведомления с медиа-альбомами (до 3 фото), панель администратора `/admin`.
- **`homeasy-scraper`**: Последовательный воркер с HTTP-first Khmer24, закреплённой Camoufox-сессией Facebook, persistent checkpoint lock и ротацией групп.
- **`homeasy-api`**: Fastify HTTP API для Telegram Mini App без удалённого доступа к браузеру и сессиям.
- **SQLite WAL**: Единая база данных `data/homeasy.db` в режиме Write-Ahead Logging (14 накатываемых миграций) с поддержкой параллельного неблокирующего чтения и безопасных транзакций.

### 2. Скрапинг Facebook через перехват GraphQL (Relay Comet Interception)
- **Защита от смены верстки**: Скрапер не опирается на нестабильные CSS-селекторы HTML, которые Facebook обфусцирует еженедельно.
- **GraphQL-перехват**: Воркер перехватывает внутренние пакеты `/api/graphql/` на уровне сетевого стека Playwright и извлекает:
  - Необрезанный полный текст постов (`node.comet_sections.content.story.message.text`), исключая обрезку `... Ещё`.
  - 100% оригинальных URL фотографий высокого разрешения из вложений и подальбомов (`all_subattachments`).
  - Точные Unix-таймштампы и ID авторов.

### 3. Локальная ручная авторизация и fail-closed защита
- Логин, пароль и 2FA вводятся человеком только в headed Camoufox на scraper host.
- Login и scraper используют одни `data/fb_device.json` и `data/fb_session.json`.
- `data/fb_runtime.lock` запрещает одновременный login и scraping.
- Checkpoint и identity challenge сохраняют persistent safety lock и останавливают scheduler.
- Снять lock может только успешный локальный `npm run fb:login`; удалённый браузер и импорт cookies через Telegram отсутствуют.

### 4. Двухуровневый экстрактор (Heuristic Regex + Gemini AI Cascade из 12 моделей)
- **Tier 1 (Instant Heuristics)**: Бесплатный мгновенный разбор регулярными выражениями:
  - Камбоджийские тарифы: электричество (EDC ~$0.20/kWh, фикс `$0.25/kWh`, `1000៛/kWh`), вода (гос. тариф ~1000៛/m³, `$5/чел`, включено), уборка, депозиты.
  - Ограничения: No Pets, No Smoking, Quiet Hours, No Subleasing.
  - 3-Way Location Consensus: Кросс-валидация между текстом, GPS-меткой и категориями с привязкой к Sangkat и золотым ориентирам (Pub Street, Old Market, BKK1, Russian Market).
- **Tier 2 (Отказоустойчивый ИИ-каскад)**:
  - Пакетная обработка по 5–8 объектов в один запрос (сокращает расход квот на 85%).
  - Каскад из 12 моделей от самой умной к легковесной:
    `gemini-3.8-flash` ➔ `gemini-3.7-flash` ➔ `gemini-3.6-flash` ➔ `gemini-3.5-flash` ➔ `gemini-3.5-flash-lite` ➔ `gemini-3.1-flash-lite` ➔ `gemini-3.1-flash-lite-preview` ➔ `gemini-3-flash-preview` ➔ `gemini-flash-lite-latest` ➔ `gemini-flash-latest` ➔ `gemini-pro-latest` ➔ `gemma-4-26b-a4b-it`.
  - **Предохранитель Circuit Breaker**: Автоматический мгновенный 30-минутный кулдаун модели при ошибках `503` (High Demand) и `429` (Quota Exceeded), исключающий задержки и спам в логи.
  - Извлечение расширенных удобств (генераторы, стиральные машины, западные кухни, лифты, охрана).

### 5. Полноценная Telegram Mini App (TMA)
- SPA-приложение с нативной адаптацией под тему Telegram (Dark/Light).
- Интерактивная карта Leaflet с кластеризацией и Bounding Box фильтрацией (+20% оверскан буфер).
- Полноразмерная карусель со **всеми фотографиями объекта** с нативным мобильным свайпом.
- Фильтрация по городам (Сиемреап / Пномпень), районам, категориям (апартаменты, виллы, дома, комнаты, отели), ценам, наличию бассейна, pet-friendly.
- Просмотр контактов агента (телефон, Telegram) в один клик.

---

## 🗂 Структура репозитория

```
homeasy/
├── src/
│   ├── config/              # Переменные окружения (Zod), гео-зоны, каталог ориентиров
│   │   ├── env.ts           # Строгая валидация конфигурации
│   │   ├── locations.ts     # Координаты городов, районов и 3-way consensus
│   │   └── landmarks.ts     # База золотых ориентиров (Siem Reap / Phnom Penh)
│   ├── database/            # SQLite и накатываемые миграции (v1 - v14)
│   │   ├── db.ts            # Singleton SQLite WAL подключения (node:sqlite)
│   │   ├── migrate.ts       # Миграции схемы (поля тарифов, ориентиров, метрик)
│   │   ├── backup.ts        # Автоматическое резервное копирование SQLite базы
│   │   ├── enrich-properties.ts # Скрипт быстрого бэкфилла и очистки спама
│   │   └── repositories/    # Слой доступа к данным (Properties, Users, Metrics, Analytics)
│   ├── modules/
│   │   ├── api/             # Fastify REST API для Mini App и WebSocket Screencast
│   │   ├── bot/             # Telegram бот (grammY): визард, фильтры, уведомления
│   │   ├── matcher/         # Движок скоринга и сопоставления с подписками пользователей
│   │   └── parser/          # Скраперы (GraphQL FB, Khmer24 Stealth), экстракторы, прокси
│   └── services/
│       ├── scheduler.ts     # Последовательный планировщик и safety gates
│       ├── scheduler.ts     # Последовательный планировщик (Khmer24 -> FB -> GC -> Maintenance)
│       └── notifier.ts      # Формирование карточек и рассылка пушей в Telegram
├── scripts/
│   ├── reparse-listings.ts  # Плавный безопасный повторный парсинг и ИИ-обогащение
│   └── pack-codebase.js     # Сборщик кодовой базы в единый Repomix XML
├── webapp/                  # Исходный код Telegram Mini App (React + Vite + Tailwind CSS)
├── tests/                   # Набор тестов (23 тест-сьюта, 267 юнит- и интеграционных тестов)
├── docker-compose.yml       # Конфигурация трех микросервисов с ограничениями RAM
├── package.json
└── README.md
```

---

## 🚀 Команды управления проектом

```bash
# Сборка TypeScript
npm run build

# Запуск тестов (Jest)
npm test

# Сборка единого XML-слепка кодовой базы для ревью архитектора
npm run pack

# Запуск безопасного повторного парсинга и ИИ-обогащения
npm run reparse:listings -- --ai         # Обогащение через Gemini с отчетом
npm run reparse:listings -- --fb         # Плавный обход постов Facebook (30-60с задержки)
npm run reparse:listings -- --khmer24    # Обновление карточек Khmer24 со всеми фото

# Ручная локальная авторизация Facebook через прямой камбоджийский IP
npm run fb:login

# Smoke test одной группы и одного scroll без сдвига round-robin cursor
npm run scrape:fb:smoke -- --group=0

# Запуск в Docker
docker compose up -d --build
```

---

## 🔒 Безопасность и отказоустойчивость
1. **Только локальная авторизация**: Facebook credentials, 2FA и storage state не принимаются через Telegram или HTTP API.
2. **Лимиты памяти**: В `docker-compose.yml` заданы жесткие лимиты памяти (API: 150M, Bot: 200M, Scraper: 750M), предотвращающие OOM на серверах с 1 GB RAM (AWS t3.micro).
3. **Безопасность учетных записей**: При обнаружении любых признаков капчи или чекпоинта скрапер немедленно останавливает обход и отправляет тревожное уведомление администратору.

