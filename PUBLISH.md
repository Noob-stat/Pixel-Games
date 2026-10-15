# Publishing Pixel Games (free)

Three routes, easiest first. The code is already deploy-ready: it reads `$PORT`,
ships a `render.yaml` and a `Dockerfile`, and the client auto-switches to `wss://`
on HTTPS.

Once deployed, the **root URL is your hub** — friends land on the game list and
pick a game from there. Fake Artist itself lives at `/games/fake-artist/`.

---

## Option A — Instant public link (no account, ~2 minutes)

Best for playing with friends **right now**. Works while your PC is on.

1. Start the server (leave this window running):
   ```powershell
   cd "F:\Project\Open COde\testing\pixel-games"
   npm.cmd start
   ```
2. Download `cloudflared` (one `.exe`, nothing to install):
   - https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe
   - Save it as `cloudflared.exe` in this folder.
3. In a **second** terminal, from this folder:
   ```powershell
   .\cloudflared.exe tunnel --url http://localhost:3000
   ```
4. It prints a link like `https://random-words-1234.trycloudflare.com`.
   Share that. It's **HTTPS**, so "Add to Home Screen" works for everyone.

**Trade-offs:** the link dies when you close the terminal, and your PC must stay on.
Not a real publish — just the fastest way to get a shareable URL.

---

## Option B — Permanent free hosting on Render (recommended)

Free forever (with caveats below), reachable from anywhere, no PC required.

### B1. Put the code on GitHub — **no git needed**

1. Create a free account at https://github.com
2. Click **New repository** → name it `pixel-games` → **Public** → Create.
3. On the empty repo page click **uploading an existing file**.
4. Drag in these files/folders from `F:\Project\Open COde\testing\pixel-games`:

   ```
   server.js
   package.json
   package-lock.json
   render.yaml
   Dockerfile
   .gitignore
   README.md
   PUBLISH.md
   public\        (the whole folder)
   tools\         (optional)
   test\          (optional)
   ```

   **Do NOT upload `node_modules`** — Render runs `npm install` for you.
   (If the browser won't let you drag dot-files, `.gitignore` is optional.)

5. Click **Commit changes**.

> Alternative if you install git later:
> ```powershell
> git init && git add -A && git commit -m "Pixel Games"
> git branch -M main
> git remote add origin https://github.com/<you>/pixel-games.git
> git push -u origin main
> ```

### B2. Deploy on Render

1. Sign up at https://render.com **with your GitHub account**.
2. Click **New +** → **Blueprint**.
3. Pick the `pixel-games` repo → **Apply**.
4. Render reads `render.yaml`, runs `npm install` then `npm start`, and gives you
   a URL like `https://pixel-games.onrender.com`.

That's it. Every future `git push` (or web upload) auto-deploys. The root URL is
the hub; share it and friends pick a game. Deep links work too:
`https://pixel-games.onrender.com/?game=fake-artist`.

### Free tier — what to expect

| Limit | Value |
|---|---|
| RAM / CPU | 512 MB / 0.1 CPU (plenty for this) |
| Sleep | Spins down after **15 min** with no traffic |
| Wake time | ~30–60 seconds on the next visit |
| Hours | 750 instance-hours per workspace / month |

Good news: since Feb 2026 **WebSocket traffic counts as activity**, so an active
game keeps the service awake. Only a fully idle lobby will let it doze off.

---

## Option C — Other hosts (same code, no changes)

The server respects `$PORT`, so it runs anywhere that hosts Node with WebSockets:

- **Railway** — https://railway.app (free trial credit)
- **Koyeb** — https://koyeb.com (free tier)
- **Fly.io** — https://fly.io (free allowances)
- **Docker anywhere**:
  ```powershell
  docker build -t pixel-games .
  docker run -p 3000:3000 pixel-games
  ```

Avoid plain serverless platforms (Vercel/Netlify functions) — they don't hold
long-lived WebSocket connections well.

---

## Pre-publish checklist

- [x] Reads `process.env.PORT`
- [x] `render.yaml` + `Dockerfile` included
- [x] Uses `wss://` automatically under HTTPS
- [x] No secrets or API keys in the code
- [x] `node_modules` excluded (`.gitignore`)
- [x] `npm test` passes locally (playtest + features + resilience)
- [ ] Confirm `node_modules` is **not** in the GitHub repo

## After publishing

- **Custom domain** — Render → your service → Settings → Custom Domains.
- **Install as an app** — open the URL on a phone → Share → *Add to Home Screen*.
- **Update the site** — edit files, push/upload, Render redeploys automatically.
- **Add another game** — drop it in `public/games/<id>/` and add an entry to
  `public/games.json`; the hub picks it up with no code changes.
