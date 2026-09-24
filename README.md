# Spaces Radio

A radio dial for live X Spaces: rooms full of real people talking about what they care about.
Pick a station, tune in, work while it plays in the background, and let it drift to the next
room every few minutes. Speak in a room only if you feel like it.

Built Sep 23, 2026 for winter: when the park is too cold, a way to still be around people.

## Run it

```bash
cd ~/Morrow/showcase/spaces-radio && python3 -m spaces_radio.server
```

Open http://127.0.0.1:8740. Without an X key it runs in **saved-rooms mode**, which is free:
paste a Space link you found (on the phone's Spaces tab, in a post, from a friend) and it goes on
your dial. "Look for rooms people are sharing on X" opens an X search for posts with Space links.

## Let it find live rooms itself (costs money, capped)

X's web site can't search Spaces, but the X API can (`GET /2/spaces/search?state=live`).
The API is pay-per-use: **$0.005 per room returned**, and each room is charged only once per UTC day.

1. In the X Developer Console (https://developer.x.com) create an app, buy a small amount of credit, and copy its **Bearer Token**.
2. `python3 ~/Morrow/tools/mo_keys.py add X_BEARER_TOKEN --service X --url https://developer.x.com --used-by spaces-radio`
3. Start with the key:
   ```bash
   cd ~/Morrow/showcase/spaces-radio && python3 ~/Morrow/tools/mo_keys.py run --project spaces-radio -- python3 -m spaces_radio.server
   ```

The server stops itself at **$0.50 a day** (about 100 distinct rooms). Change it with
`SPACES_RADIO_DAILY_CAP=1.00`. Searches are cached for 10 minutes. Each station runs 1 to 3 searches
of up to 20 rooms, so a first tune costs at most 10 to 30 cents and later tunes that day cost less.
The spend shows at the bottom of the page. Ticketed (paid) Spaces are skipped.

## How it's built (Head First, chapter 1: Strategy)

- `spaces_radio/sources.py`: the dial asks a `SpaceSource` for rooms without caring where they came
  from. `XApiSource` (paid, behind a `Budget`) and `SavedSource` (free) today. Clubhouse or Telegram
  voice chats would be one new class each.
- `budget.py`: the daily spend ledger. If the ledger file is damaged it assumes the day is spent
  (fails closed) rather than reset to zero.
- `stations.py`: station → search words. Edit these to change the dial.
- `server.py`: stdlib HTTP on 127.0.0.1 only, JSON replies `{success, data, error, meta}`.
- `web/`: the dial. It opens rooms in one named window and steers that same window for Next and Drift.
- Tests: `python3 -m unittest discover -s tests -t .` (21 tests, no network).

## Limits, honestly

- Audio plays on x.com, not in this page: X has no public audio stream for Spaces. You need to be
  signed in to X in that browser, and X may ask you to click "Start listening" on each new room.
- Saved rooms don't know whether they're still live until you tune in.
- It runs on the Mac. A phone version (swipe to the next room) is a later step.
- The live-search path is tested against a fake X API only; it hasn't made a real paid call yet.
