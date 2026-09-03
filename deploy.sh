#!/bin/bash
# Скрипт деплоя с Мака на сервер

echo "🚀 Отправляем новые файлы на сервер..."
rsync -avz -e "ssh -i /Users/lacr0s/Documents/infernopvt.pem" --exclude 'node_modules' --exclude '.git' --exclude 'dist' /Users/lacr0s/Documents/homeasy/ root@5.61.40.201:/opt/homeasy/

echo "🔄 Пересобираем и перезапускаем Docker-контейнер..."
ssh -i /Users/lacr0s/Documents/infernopvt.pem root@5.61.40.201 "cd /opt/homeasy && docker compose up -d --build"

echo "✅ Деплой завершен!"
