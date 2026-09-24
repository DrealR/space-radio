# Spaces Radio SR-26

A walkie-talkie radio for live X Spaces. Each channel is a room of real people talking right now.
Flip through rooms like a feed, listen while you work, and grab the mic if you want to.
Built Sep 23, 2026 for winter nights, when the park is too cold. The why: [STORY.md](STORY.md).

- **BAND** keys choose the topic. The **glass** shows every live room on that band: taller means busier.
- **TUNE** knob, swipe or ← → flips rooms, with static in between.
- **Speaker grille**: one dot per person. Amber dots are hosts, green dots are on the mic, cream dots are listening.
- **PUSH TO LISTEN / JOIN** opens the room in X. Anyone can listen on a computer, even without an account.
- **MIC** (computer) shows a QR code that carries the room to your phone, because on X the web can only
  listen. Talking needs the X app and an account.
- **SCAN** (computer only) hops to a new room every few minutes and steers the same X window.
- **Presets** save rooms. They live in each person's own browser.

## Run it locally

```bash
cd ~/Morrow/showcase/spaces-radio && python3 -m spaces_radio.server
```

Open http://127.0.0.1:8740. Add `X_BEARER_TOKEN` to the environment for live search (see below).

## Hosting (Vercel)

- `public/` is the static site. `api/tune.py` and `api/status.py` are Python functions that call `spaces_radio/`.
- The X key lives only in the Vercel environment (`X_BEARER_TOKEN`). Listeners never need a key.
- **One key, many listeners.** `/api/tune` answers carry `Vercel-CDN-Cache-Control: max-age=600`,
  so everyone on the same band in the same 10 minutes shares one answer, and X is asked once.
  Any extra query parameter is refused, so nobody can bypass that cache and run up the bill.
- Add the key: `vercel env add X_BEARER_TOKEN production`, paste the token, then redeploy.

## What it costs

X's API is pay-per-use: **$0.005 per room returned**, and a room is charged once per UTC day
no matter how often it's seen. So cost follows *how many distinct rooms show up*, not how many people listen.

- Every search asks for up to 10 rooms, and each band runs 1 to 3 searches.
- If one person listens a few hours a day, expect roughly $0.50 to $2 a day. This is a guess; measure the first week.
- **The hard cap lives at X.** In the X Developer Console, set a spending limit per billing cycle (for example $10)
  and leave auto-recharge off. When the limit is hit, X blocks calls and the radio shows "signal trouble".
- The server also keeps a soft daily guard (`SPACES_RADIO_DAILY_CAP`, default $0.50), but on Vercel
  each instance keeps its own, so don't rely on it as the cap.

## How it's built (Head First, chapter 1: Strategy)

- `spaces_radio/sources.py`: the radio asks a `SpaceSource` for rooms and doesn't care where they
  come from. `XApiSource` today. A shared community list, Clubhouse or Telegram voice chats would be
  one new class each.
- `service.py`: what the radio answers (and how long it may be cached), shared by the local server and Vercel.
- `stations.py`: band → search words. Edit these to change the dial.
- `public/js/rooms.js`: pure helpers (sorting, the FM dial, the crowd in the grille, presets).
  `handoff.js`: the MIC-to-phone QR (uses the vendored MIT `qrcode-generator` 2.0.4 in `public/vendor/`).
  `sfx.js`: static and roger beep made with Web Audio. `app.js`: state and drawing.

Tests (no network): `python3 -m unittest discover -s tests -t .` and `node --test tests/*.mjs`.

## Roadmap

- **Favorite hosts.** X's Activity API sends `spaces.start` / `spaces.end` events for chosen accounts
  (webhook or stream). A webhook function plus a small store would let the radio light up the moment
  a host you love goes live. Needs storage and a webhook secret; billing for these events is unstated.
- **Community rooms.** Anyone who finds a live room can add it to a shared list (free, needs storage and light moderation).
- **Preset check.** Mark presets live or ended with one Spaces lookup, $0.005 per room per day.

## Limits

- Audio plays in X, not in this page, because X offers no public audio stream for Spaces.
  X may ask you to click "Start listening".
- X's pages may cut the radio off from the X window it opens (`Cross-Origin-Opener-Policy`).
  The radio detects this. If it can steer the window, the dial and SCAN switch rooms for you.
  If it can't, flipping queues the next room and the button reads PUSH TO SWITCH, so two rooms never play at once.
- Presets don't know whether a room is still live until you join it.
- The live X path is tested against a fake API only until a real key is added.
