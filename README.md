# 🎮 Pixel Games

A free, browser-based hub for party games you can play with friends on their own
phones. One server, one URL, several games. **Fake Artist** is the first.

- **Hub home page** at `/` lists every game as a card. Tap a card for how-to-play
  and features, then **Play** to launch it.
- Works on **phone and PC**, no install, no signup.
- Everyone joins with a **4-letter room code**.
- Real-time via WebSockets. **Zero cost to run** — one tiny Node dependency (`ws`).

## Adding a new game (no code changes)

Drop a folder into `public/games/<id>/` with an `index.html`, then add an entry to
`public/games.json`. Real example (this is the shape the hub actually reads):

```json
{
  "id": "my-game",
  "title": "My Game",
  "emoji": "🎲",
  "tagline": "One line that sells it.",
  "status": "live",
  "url": "/games/my-game/",
  "players": "3–8 players",
  "time": "10 min",
  "device": "Phone or PC",
  "tags": ["Drawing", "Bluffing"],
  "gradient": ["#6c8cff", "#b06cff"],
  "description": "A longer blurb shown in the details panel.",
  "howToPlay": ["Step one", "Step two"],
  "features": ["A cool thing", "Another cool thing"]
}
```

- `status` is `"live"` or `"soon"` — `soon` shows a "Coming soon" badge and no Play button.
- `url` is where the game's `index.html` lives; the hub builds the card, the details
  panel and the Play link from this file, so the game appears at `/games/my-game/`
  with **no code changes** to the hub.

---

## 🎭 Fake Artist

One player is secretly the **Fake** — they don't know the word, only the category.
Everyone draws **one line per turn** on a shared canvas, then votes for the impostor.

### How to play
1. One person taps **Create a room** and shares the 4-letter code.
2. Everyone else enters the code and joins.
3. Real players see the secret word. Fake(s) see only the category.
4. Take turns adding **one line each** to the same drawing.
5. Vote for who you think is the Fake.
   - **Caught?** The Fake gets one shot at guessing the word.
   - Caught + wrong guess → every artist **+1**.
   - Caught + right guess → Fake **+2**.
   - Fake not caught → each Fake **+2**.
6. Repeat for the configured number of **rounds**, then see the final standings.

### Rounds
A game is a series of rounds, and each round is a series of lines (one per player).

- **Rounds per game** — 1 to 10 (default 3).
- **Lines each per round** — 1 to 3 (default 2).
- **Every new round gets a fresh word.** Words never repeat inside the same game.
- **Categories rotate** — a random category each round, or pin one in settings.
- **Fakes reshuffle by default**, so the impostor changes every round (or keep the
  same Fake for the whole game).
- Scores carry across rounds. When the last round ends the host gets
  **Play again (keeps scores)** and **Back to lobby**.

---

## Features

**Customize the room** (on the create screen, and live in the lobby *and* between
rounds by the host):
- **Rounds** — 1 to 10 rounds per game; **Lines each** — 1 to 3 per round.
- **Custom words** — your own list (comma or newline separated). Overrides the built-in categories.
- **Custom hint** — the label the Fake sees when you use custom words.
- **Category** — Random or a built-in set (Animals, Food, Places, Objects, Nature, Jobs, Movies).
- **New Fakes each round** — on by default; turn it off to keep the same impostor.
- **Rotate category** — force a new category every round even if one is pinned.
- **2 Fakes** — needs 4+ players; the lobby warns if you don't have enough.
- **Turn timer** — Off / 20s / 30s / 45s / 60s / 90s / 120s. Turns auto-pass when time runs out.
- **Vote timer** — optional; missing votes are filled in so a game can never stall.
- **Fakes know each other** — optionally reveal the Fake teammates to each other.

**Party-friendly extras:**
- **Emoji reactions** — a floating reaction bar in every game screen; reactions pop up on everyone's screen with the sender's name and colour (rate-limited server-side).
- **Sound + animation** — ticking clock in the last seconds, drumroll before the reveal, win/lose jingles, your-turn chime, join/leave blips, haptics on mobile, confetti. Volume slider + quick mute.
- **The drawing is shown at the reveal**, next to the word and the scoreboard.
- **Installable app (PWA)** — "Add to Home Screen" on phone, works offline for the app shell, real icon.
- **Running leaderboard** — visible in the lobby and at the reveal, with round-win stars and a host Reset.
- **Leave / kick / disband** — anyone can leave; the host can remove players (kicked players can't rejoin) or close the room for everyone.
- **Connection status** — a live dot shows when you drop, and you auto-rejoin the room when you're back.
- **Remembers your settings** — your last room configuration is restored next time.
- **Accessible + responsive** — honours "reduce motion", keyboard-friendly, and fits phone, tablet, desktop and landscape.

---

## Run it locally

Node and npm must be installed. If they aren't on your PATH, call them by full path.

```bash
npm install
npm start
```

Then open **http://localhost:3000** — that's the hub. Fake Artist lives at
**http://localhost:3000/games/fake-artist/**.

To test multiplayer on one machine, open the site in **separate browser tabs**
(each tab is a separate player) or open it on your phone using your PC's LAN IP
(e.g. `http://192.168.1.20:3000`).

### Windows / PowerShell note
Node and npm are already on your user PATH, but PowerShell blocks `npm.ps1` by default. If `npm` gives a "running scripts is disabled" error, use any of these:

```powershell
npm.cmd start                 # use the .cmd shim
# or allow scripts for this user once:
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
# or run from cmd.exe instead of PowerShell
```

## Deploy free (least work)

The server reads `process.env.PORT`, so it works on any Node host.

### Render (recommended — free tier, WebSocket support)
1. Push this folder to a GitHub repo.
2. Go to [render.com](https://render.com) → **New** → **Blueprint**.
3. Pick the repo. Render reads `render.yaml` and deploys automatically.
4. You get a public `https://...onrender.com` link. Share it — the hub is the landing page.

> Note: Render's free tier sleeps after ~15 min idle and wakes on the next visit (takes a few seconds).

### Other free options
- **Railway / Fly.io / Koyeb** — same `npm start`; they inject `PORT`.
- **Docker** — `docker build -t pixel-games . && docker run -p 3000:3000 pixel-games`.
- **Your own PC + a tunnel** — run locally and share with `npx localtunnel --port 3000` or `cloudflared tunnel`.

---

## Files

```
server.js                              realtime server: rooms, drawing, rounds, voting, scoring, timers, reactions, moderation
public/games.json                      the game registry the hub renders from
public/index.html                      hub home page
public/portal.css / portal.js          hub styling + card grid, details modal, deep links
public/games/fake-artist/index.html    game screens (lobby, canvas, vote, guess, reveal)
public/games/fake-artist/app.js        game client: drawing, rounds UI, sound, reactions, PWA
public/games/fake-artist/style.css     game styling, animations, responsive layout
public/games/fake-artist/manifest.webmanifest + sw.js + icon-*.png
tools/make-icons.js                    regenerates the icons
test/playtest.js                       headless 3-player full-round test (Fake privacy)
test/features.js                       timers, custom words, 2 fakes, rounds, moderation, reactions
test/resilience.js                     hostile input + soft-lock protection
render.yaml                            free one-click deploy config
Dockerfile                             deploy anywhere
```

## Tests

With the server running:

```bash
npm test
```

- `playtest.js` drives a full round and checks the Fake never receives the word.
- `features.js` checks the turn timer, custom words, two Fakes, the round system
  (new word + new Fakes each round, game over, play again), moderation, reactions
  and the vote timer.
- `resilience.js` checks the server survives malformed URLs and malformed/flooding
  sockets, and that a room can't freeze when the caught Fake drops mid-guess.

---

## Performance notes

Party games get played on whatever phone is in someone's pocket, so the client is
deliberately cheap to render:

- The ballot is built **once per voting phase** and then updated in place, so
  tapping never fights a re-render and button identity is preserved.
- State updates are **coalesced into one paint per frame** in a visible tab.
- The drawing board only resizes its canvas when the element actually changed size.
- Strokes are only relayed while they're on screen, and broadcasts are coalesced
  server-side (~40 ms), so a fast vote or stroke burst becomes one message.
- No `backdrop-filter` anywhere: a blurred fixed bar over a live canvas re-blurs the
  whole screen every frame and drags low-end devices to ~1 fps.
- The reaction bar caps concurrent floaters and the render layers are contained, so
  a reaction spam-storm can't flood the compositor.

The server is written to never take the party down: message handling, the tick
loop, the broadcast flush, the HTTP handler and every socket write are guarded,
message floods are dropped, WebSocket frames are capped, and `uncaughtException` /
`unhandledRejection` are logged instead of killing the process.

## Tuning

- Words & categories: `CATEGORIES` in `server.js`.
- Player colors: `COLORS` in `server.js`.
- Player limits: `MIN_PLAYERS` / `MAX_PLAYERS` in `server.js`.
- Round/line limits: `MAX_ROUNDS` / `MAX_LINES` in `server.js`.
- Games listed in the hub: `public/games.json`.
