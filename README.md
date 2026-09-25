# Space Radio SR-26

Live: https://space-radio-fm.vercel.app · Code: https://github.com/DrealR/space-radio

A walkie-talkie radio for your ship. Each channel is a live X Space: another ship full of real people talking right now.
Flip through rooms like a feed, listen while you work, and grab the mic if you want to.
Built Sep 23, 2026 for winter nights, when the park is too cold. The why: [STORY.md](STORY.md).

**The dial browses. The button boards. X plays the sound.**

- **BAND** keys choose the topic. The **glass** shows every live room on that band: taller means busier.
- **TUNE** knob, swipe or ← → lines up a room, with static in between. Tuning never touches X.
- **Speaker grille**: one dot per person. Amber dots are hosts, green dots are on the mic, cream dots are listening.
  Press the speaker (or C) for the **crew manifest**: who's aboard, by name.
- **PUSH TO LISTEN / JOIN** boards the room. Then press X's own **▶ Start listening** (see below).
- **OPEN IN X ↗** shows the room on X itself, in its own tab. Free, always one tap away.
- **MIC** (computer) shows a QR code that carries the room to your phone, because on X the web can only
  listen. Talking needs the X app and an account.
- **SCAN** (computer only) lines up a new room every few minutes; you push to jump.
- **Presets** save rooms. They live in each person's own browser.
- Keys: ← → tune · L listen · H I hear it · C crew · O open in X · ? manual · Esc close.

## The two-key launch

X gives no public audio stream for Spaces, so the sound always plays inside X. Browsers only let a site
make sound after you press something *on that site*, and X's room page (`x.com/i/spaces/<id>` redirects to
`/peek`) waits for its own **Start listening** button ("Start listening anonymously" when logged out).
So every room takes two presses:

1. **PUSH** on the radio. On a computer, X opens docked beside the radio (a 440px pop-up at `/peek`).
   On a phone, the button is a plain same-tab link to the room, so the X app can catch it.
2. **▶ Start listening** in X, once per room.

The radio can't hear X, so it never claims to. After a push it stands by (lamp **STBY**, rail lamp 2
blinking violet) and teaches key 2 in the airlock panel. Only you can put it **ON AIR**, by pressing
**I HEAR IT** (or **I'M IN** on a phone). If you come back without answering, it asks. If nothing plays,
**NO SOUND?** walks through the fixes in order.

- Pressing PUSH again on the same room brings the X window forward; it never reloads it or opens a second one.
- On another room, PUSH steers the X window the radio still holds, or opens a fresh one.
- A blocked pop-up turns PUSH into a plain **OPEN IN X ↗** link, which always works. The radio remembers
  the block for the session, so later rooms go straight to a new tab instead of wasting a press.
- If the radio loses track of the X window, it never says the room stopped: it asks whether you hear it,
  and PUSH reopens only if you don't (otherwise two rooms would play).
- Phone trips: the page remembers the room you left for however long you listen, and asks "did it play?"
  when you return. If the page was reloaded meanwhile, the trip rides in `sessionStorage` for 30 minutes.
  If X played in the radio's own tab (no X app, or the home-screen radio), coming back stopped the sound,
  and the radio says so instead of offering I'M IN. In-app browsers (Instagram, TikTok…) get a banner,
  because they can't hand rooms to X.

## Run it locally

```bash
cd ~/Morrow/showcase/spaces-radio && python3 -m spaces_radio.server
SPACES_RADIO_FAKE=1 python3 -m spaces_radio.server   # fake rooms and a fake crew: no key, no network, no cost
```

Open http://127.0.0.1:8740. Add `X_BEARER_TOKEN` to the environment for live search (see below).
Fake mode serves six sample rooms and a sample crew for any room; `0000000ended` and `0000000limit`
exercise the "ended" and "busy" crew states. It is ignored on Vercel.

## Hosting (Vercel)

- `public/` is the static site. `api/tune.py` and `api/status.py` are Python functions that call `spaces_radio/`.
- The X key lives only in the Vercel environment (`X_BEARER_TOKEN`). Listeners never need a key.
- **One key, many listeners.** `/api/tune` and `/api/search` answers carry `Vercel-CDN-Cache-Control: max-age=1800`,
  so everyone on the same band in the same 30 minutes shares one answer, and X is asked once.
  (Every deploy clears that cache, so a deploy costs one fresh search per band someone opens.)
  Any extra query parameter, or any other spelling of the same one (`%6dusic`, a trailing `&`), is refused,
  so nobody can bypass that cache and run up the bill.
- Add the key: `vercel env add X_BEARER_TOKEN production`, paste the token, then redeploy.
- `api/crew.py` serves the crew manifest (`/api/crew?id=<space id>`, plus the room's `&t=<ticket>`), with the
  same one-spelling rule.

## Docking (two radios, one tunnel)

Rocky and Grace in *Project Hail Mary* couldn't breathe the same air, so they met at a clear xenonite
wall and spoke in chords. **DOCK ⟷** does that for two radios:

- One radio opens a port (a Hail Mary star code like `ERID-42`, plus a secret) and sends the link.
  The friend's radio clamps on. Each keeps its own dial and its own X.
- The tunnel strip shows both ships across the wall, and the partner's ship appears violet on the radar.
- Four tones play as chords: **✊ FIST MY BUMP**, **✦ AMAZE ×3**, **↑ COME HERE** (carries your room;
  they get GO TO YOUR ROOM), **↓ ONWARD**. There's no chat box: the talking happens inside the Space.
- Relay: `POST /api/dock`, one slot per ship (`dock-<code>-a|b`). Each beat writes yours and reads theirs.
  On Vercel it's the **Runtime Cache** (strict: a 503 if it's missing, never a silent per-instance
  fallback); locally it's memory. A third radio gets DOCK FULL; UNDOCK frees the slot; idle slots
  expire after 30 minutes. Nothing touches X, so docking has no X cost.

## Fuel: what spends money, and the gauge that shows it

- **⛽ gauge** (next to ◎ RADAR) shows today's estimated X spend against the day's cap. Tap it for the
  fuel log: spend by kind, a cost sheet, and what's always free. `GET /api/fuel` serves it (no X, no cache).
- **One shared tank.** The band, crew-room and crew-name ledgers live in Vercel's Runtime Cache, so every
  instance adds up to one real daily cap: 60¢ bands + 10¢ crew rooms + 40¢ names = **$1.10/day** by default
  (`SPACES_RADIO_DAILY_CAP`, `SPACES_RADIO_CREW_SPACE_CAP`, `SPACES_RADIO_CREW_DAILY_CAP`).
- **One paid search per word per hour.** Each word's rooms are shared from the Runtime Cache for an hour
  (surviving deploys) and kept six hours as a fallback: when fuel or X credits run out, the dial shows the
  last rooms found.
- **Priciest tap:** WHO'S HERE, at about 1¢ per person (a busy room is 10–15¢). OPEN IN X shows the same
  crew for free.

## What it costs

X's API is pay-per-use: **$0.005 per room returned**. The docs say each room is billed once per UTC day,
but the first real day (Sep 24, 2026) showed **576 billed items from 51 requests ($2.92)**: in practice X
billed nearly every room on every request. So cost follows **how many searches reach X**, which the
shared cache keeps independent of how many people listen.

- Each search asks for up to 10 rooms (up to about $0.05), and each band runs 2 searches (up to about $0.10).
- A band's answer is shared for 30 minutes, and an open radio refreshes only every 30 minutes, only while visible.
- One person listening a few hours on one or two bands: roughly $0.20 to $0.60 an hour of fresh searches at most,
  often less, because the cache is shared. Browsing all ten bands once costs up to about $1.
- Your own bands work the same way: two words, two searches.
- **The hard cap lives at X.** In the X Developer Console, set a spending limit per billing cycle (for example $10)
  and leave auto-recharge off. When the limit is hit, X blocks calls and the radio shows "signal trouble".
- The server also keeps a soft daily guard (`SPACES_RADIO_DAILY_CAP`, default $1.00, counting every room on
  every call), but on Vercel
  each instance keeps its own, so don't rely on it as the cap.

### Crew names cost more

The crew manifest asks X for one Space plus its people: **$0.005 per Space and $0.010 per person**
(user reads are billed per user returned). Assume every scan is billed in full: a typical room (1 host,
2 co-hosts, 8 speakers) costs about $0.12 per scan. So names load only when someone asks:

- **Only a press scans**: the speaker, the C key, TRY AGAIN or REFRESH. Never on load, tuning, band
  switches, SCAN, the 10-minute refresh or PUSH.
- **Shared and cached**: the server keeps each roster 120 s (600 s for ended rooms) and the CDN shares
  it with everyone. Each browser also remembers it for 120 s, scans one room at a time, and at most
  6 rooms per 10 minutes.
- **Priced before it's bought**: each scan first asks X for the Space alone (its state and plain id
  lists, no names, one Space read). A room that isn't live stops there and pays for no names. A live
  room is priced from those id lists, and the whole crew is fetched only if it fits under the cap.
- **Only rooms the radio found**: `/api/tune` gives each room a ticket (an HMAC of the id and a
  half-hour window, keyed from `X_BEARER_TOKEN` or `SPACES_RADIO_TICKET_KEY`). Without a valid ticket,
  such as a preset or a scripted request for any id, the crew scan names only the host.
- **Its own caps**: `SPACES_RADIO_CREW_DAILY_CAP` (default **$0.50** of names) and
  `SPACES_RADIO_CREW_SPACE_CAP` (default **$0.10** of Space reads made for names), separate from the band
  cap, so names can never starve the dial. A room the dial already paid for today is read for free. Near
  the cap it degrades to host-only (about $0.01), then rests until midnight UTC. `SPACES_RADIO_CREW=off`
  switches names off.
- **Safe under load**: every paid call reserves its worst case before asking X and settles what X billed
  afterwards, under a lock, so requests arriving together can't all spend the same last dollar. Two
  requests for one room share one scan. After X answers busy (429), out of credits (402) or refused (401/403),
  nobody asks X again for 30 to 60 seconds; cached rosters still show.
- **Per instance on Vercel**: like the band cap, these ledgers live in each instance's `/tmp`, so they are
  soft guards. **X's spending limit is the only hard cap** (keep auto-recharge off). A Vercel WAF rate limit
  on `/api/crew` (about 10 requests a minute per IP) is the recommended next guard.
- **OPEN IN X ↗** is always there and free: X's own page shows everyone aboard.
- Logs keep only the Space id, the person count, the mode and today's crew spend. Never names.

## How it's built (Head First, chapter 1: Strategy)

- `spaces_radio/sources.py`: the radio asks a `SpaceSource` for rooms and doesn't care where they
  come from. `XApiSource` today. A shared community list, Clubhouse or Telegram voice chats would be
  one new class each.
- `service.py`: what the radio answers (and how long it may be cached), shared by the local server and Vercel.
- `stations.py`: band → search words. Edit these to change the dial.
- `public/js/rooms.js`: pure helpers (sorting, the FM dial, the crowd in the grille, presets, room links).
  `handoff.js`: the MIC-to-phone QR (uses the vendored MIT `qrcode-generator` 2.0.4 in `public/vendor/`).
  `sfx.js`: small Web Audio sounds (static, roger beep, hail, lock). `app.js`: state and drawing.
- The launch is a state machine (Head First, chapter 10: State). `airlock.js` is the pure reducer
  (`airNext`), `airlock-copy.js` turns a state into every word on screen, `listener.js` plans a push
  and reads the X window, `dock.js` places it, `xwindow.js` owns the one mutable thing (the window
  handle), `launch.js` wires presses to all of it, and `airlock-view.js` draws it.
- `crew.js` (loaded only when asked, via `aboard.js`) draws the crew manifest. If it can't load, the
  radio keeps working and points at OPEN IN X. On the server, `crew_parse.py` reads X's answer (pure),
  `crew.py` does the paid lookup, `budget.py` keeps the ledgers and `ticket.py` signs the rooms.

Tests (no network): `python3 -m unittest discover -s tests -t .` and `node --test tests/*.mjs`.

## Roadmap

- **Favorite hosts.** X's Activity API sends `spaces.start` / `spaces.end` events for chosen accounts
  (webhook or stream). A webhook function plus a small store would let the radio light up the moment
  a host you love goes live. Needs storage and a webhook secret; billing for these events is unstated.
- **Community rooms.** Anyone who finds a live room can add it to a shared list (free, needs storage and light moderation).
- **Preset check.** Mark presets live or ended with one Spaces lookup, $0.005 per room per day.

## Limits

- Audio plays in X, not in this page, because X offers no public audio stream for Spaces.
  **Every room needs one press of X's Start listening.** The radio can't press it for you.
- **The dial never steers X.** Tuning, band keys, SCAN and refresh only line a room up; PUSH jumps.
  Steering a playing room would silence it until you pressed Start listening again.
- X's pages may cut the radio off from the X window it opens (`Cross-Origin-Opener-Policy`). The radio
  watches for it: if it keeps the window, PUSH steers and focuses it; if not, it says so and offers a
  plain link. When the window disappears, the radio says it lost track, never that the room stopped.
- **I HEAR IT is self-reported.** If you skip it, the radio stays at STBY, which is honest.
- Pop-up placement is a request: browsers may ignore it on other monitors or in full screen.
- X names hosts and speakers, and counts listeners (signed-in ones only). It never says who's listening.
- Presets don't know whether a room is still live until you join it or open its crew.
- The live X path is tested against a fake API only until a real key is added.

Still to check by hand on one live Space, in Chrome and Safari, logged in and out: whether pressing
Start listening inside the `/peek` pop-up keeps the radio's handle; whether logged-in users also land on
`/peek`; whether the 440×780 pop-up is readable; whether a same-tab tap opens the X app on an iPhone;
the first real `/api/crew` answer (host and speaker ids, creator id) and its charge in the X console;
and whether Safari and Firefox honor the pop-up placement.
