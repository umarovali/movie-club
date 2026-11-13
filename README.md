# Movie Club — голосование

- `/` — страница для учеников (имя, фамилия, фильм, «почему» — необязательно)
- `/admin.html` — админка (фильмы, открыть/закрыть, результаты, график по времени, все голоса, CSV, архив)
- `/api/*` — Netlify Function, данные в Netlify Blobs
- Telegram-бот: уведомление о каждом голосе + команды `/stats`, `/last`, `/open`, `/close`

## Деплой

⚠️ Простое перетаскивание папки на Netlify **не** загружает функции. Нужен Git или CLI.

**Через GitHub:** залить папку в репозиторий → Netlify → Add new site → Import from Git. Настройки сборки подтянутся из `netlify.toml`.

**Через CLI:**
```
npx netlify-cli login
npx netlify-cli deploy --prod
```

## Переменные окружения
Netlify → Site configuration → Environment variables:

| Имя | Что это |
|---|---|
| `ADMIN_PASSWORD` | пароль для админки (обязательно) |
| `TG_BOT_TOKEN` | токен бота от @BotFather (необязательно) |
| `TG_CHAT_ID` | ваш chat id, узнать у @userinfobot (необязательно) |

После изменения переменных — Deploys → Trigger deploy. Затем в админке нажать «Подключить бота».

## Локально
Создайте `.env` с `ADMIN_PASSWORD=...`, затем:
```
npm run dev
```
Откройте http://localhost:8888 и http://localhost:8888/admin.html.
Данные хранятся в папке `.local-data/`; чтобы начать с нуля, удалите её.
