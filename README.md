# AJ Uploader+ Backend

Minimal Node.js server that replaces `tikosystem.com` for the extension's
login + usage-limit system. It does **not** do any video processing, caption
injection, or TikTok signature manipulation — it only handles:

- Telegram login (device-code style: extension shows a 6-character code,
  user sends it to the bot, bot links the Telegram account)
- Plan tracking: `normal` (3 uses / week) and `vip` (10 uses / day)
- Session tokens for the extension to call `/session/validate`

## 1. Create your bot

1. Open [@BotFather](https://t.me/BotFather) on Telegram.
2. `/newbot` → follow the prompts → copy the token it gives you.
3. That token goes in `BOT_TOKEN`.

## 2. Local setup

```bash
npm install
cp .env.example .env
# edit .env and paste your BOT_TOKEN
npm start
```

The server listens on `http://localhost:3000` and the SQLite database file
`aj.db` is created automatically in the project folder.

## 3. Deploy (e.g. Render)

1. Push this folder to your GitHub repo (replace `main.py`, `requirements.txt`
   — this project is Node.js only, so remove those Python leftovers).
2. On Render: **New → Web Service** → connect the repo.
   - Build command: `npm install`
   - Start command: `npm start`
3. Add environment variable `BOT_TOKEN` (and `CHANNEL_USERNAME` if you use it)
   under **Environment**.
4. Deploy.

⚠️ **Important — avoid the `Conflict: terminated by other getUpdates request`
error:** only ONE running instance of this server may poll Telegram with the
same `BOT_TOKEN` at a time. Don't run it locally (`npm start`) at the same
time it's also running on Render with the same token — stop one before
starting the other.

## 4. Point the extension at your server

In the extension's config (`l` object in `background.js` / `popup.js`),
change:

```js
API_BASE: "https://tikosystem.com"
```

to your Render URL, e.g.:

```js
API_BASE: "https://your-app-name.onrender.com"
```

`API_PREFIX` stays `"/api/ext"` — no other change needed, the routes match
exactly what the extension already expects (`/auth/start`, `/auth/check`,
`/session/validate`, `/session/logout`, `/config`).

## Endpoints

| Method | Path                     | Auth   | Purpose                          |
|--------|--------------------------|--------|-----------------------------------|
| GET    | /api/ext/config          | none   | channel link, version, maintenance|
| POST   | /api/ext/auth/start      | none   | create a login code               |
| POST   | /api/ext/auth/check      | none   | poll login status                 |
| POST   | /api/ext/session/validate| bearer | validate session, return profile  |
| POST   | /api/ext/session/logout  | bearer | invalidate session                |
| GET    | /api/ext/usage/status    | bearer | read current usage counter        |
| POST   | /api/ext/usage/consume   | bearer | increment usage counter (429 if over limit) |

## Granting VIP manually (for now)

There's no payment flow yet. To make someone VIP, run this against `aj.db`
(e.g. with `sqlite3 aj.db` or any SQLite browser):

```sql
UPDATE users
SET plan = 'vip', vip_expires_at = strftime('%s','now','+30 days')
WHERE telegram_id = '123456789';
```

Find their `telegram_id` from the `users` table (it's filled in after they
log in once).
