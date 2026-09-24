# Why I built Spaces Radio

## The problem

All summer I played guitar in the park, around people. Winter is coming, and I just started a
full-time remote job. I still go out to events and see family, but on a lot of nights and workdays
it's just me at home.

I didn't want to fill that with more scrolling. On X you read text and can't always tell whether a
real person wrote it. Livestreams are mostly one person talking to a crowd, and a lot of them are
about donations.

Then I stumbled into a random X Space: twenty people, five or six of them talking, about something
they cared about. I didn't share their politics, and it didn't matter. They were real people, live,
talking, and anyone could speak up. It made me happy. It felt like a third place, the way a café
or a park is, and I could have it in the background while I worked.

## What was missing

- X's website can't search Spaces at all. The phone app has a Spaces tab, but you can't flip through
  rooms the way you flip through Shorts or TikTok Live.
- Nothing lets you **drift**: sit in a room for a few minutes, then move on to the next one, like a
  radio station you don't have to program.

## The solution

A radio for Spaces, designed like a 1970s handheld that learned to talk: part radio, part
walkie-talkie. The difference from a radio is that you're allowed to talk back.

- **Bands** are topics. The **glass dial** shows every live room on that band.
- **Tune** flips rooms: knob, swipe or arrow keys, with static in between.
- The **speaker grille** shows the crowd: one dot per person, hosts in amber, people on the mic in green.
- **Push to listen** opens the room in X. **Scan** drifts to a new room every few minutes.
- **MIC** hands the room to your phone with a QR code, because on X the web can only listen and
  talking happens in the app.

## How it works

```
browser (the radio) ──▶ /api/tune?station=music ──▶ X API: search live Spaces
                          │  one server key, never sent to the browser
                          └─ answer cached 10 min on Vercel's CDN, shared by every listener
```

- One key serves every listener. Listeners never need a developer account.
- X charges $0.005 per room, once per day, so the cost follows how many rooms show up, not how many
  people listen. X's spending limit is the hard cap.
- Written with *Head First Design Patterns*, chapter 1 (Strategy): the radio asks a `SpaceSource`
  for rooms and doesn't care where they come from. Clubhouse or Telegram voice chats would be one
  new class each.

## Use it or build your own

- Live: https://spaces-radio.vercel.app
- Your own copy: deploy this folder to Vercel, add your X API bearer token as `X_BEARER_TOKEN`,
  and set a spending limit in the X Developer Console. The README has details and tests.

It's a small thing, built to fix one real problem: wanting to be around people when you can't be.
If it helps you too, use it.
