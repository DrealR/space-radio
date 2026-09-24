// The bridge's extras: making your own bands and beaming a friend aboard.
// They reach the radio only through the app door (state, set, select, flash, say, tuneBand).
import { bandKey, findBand, isMine } from "./mybands.js";
import { openBandMaker } from "./mybands-view.js";
import { beamUrl, sendBeam } from "./beam.js";
import { writeJson } from "./store.js";

export const MYBANDS_KEY = "spaces-radio:bands";

export function makeBand(app) {
  openBandMaker(app.state.myBands, {
    save: (myBands) => {
      writeJson(MYBANDS_KEY, myBands);
      app.set({ myBands });
      const { band, bands } = app.state;
      if (isMine(band) && !findBand(myBands, band)) app.tuneBand(bands[0] || "anything");
    },
    tune: (band) => app.tuneBand(bandKey(band)),
  });
}

const BEAM_WORDS = { shared: "BEAM SENT", copied: "BEAM LINK COPIED · SEND IT", cancelled: "", failed: "COPY BLOCKED · USE OPEN IN X" };

export async function beamCurrent(app) {
  const room = app.current();
  if (!room) return;
  const band = isMine(app.state.band) ? null : app.state.band; // your bands live in your browser only
  const sent = await sendBeam(beamUrl(location.origin, room, band), room.title, { phone: app.device.kind === "phone" });
  if (BEAM_WORDS[sent]) app.flash(BEAM_WORDS[sent], 3200);
}

/** Arriving on a beam link: land on its room (added to the deck if it isn't live here) and tidy the address bar. */
export function landBeam(app, beam) {
  history.replaceState(null, "", location.pathname);
  if (!app.deck().some((r) => r.id === beam.id)) app.set({ beam: { id: beam.id, title: beam.title } });
  app.select(beam.id, { quiet: true });
  app.flash("BEAMED IN · PUSH TO JOIN", 6000);
  app.say(`A friend beamed you into ${beam.title}. Push to join.`);
}
