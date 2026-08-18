# Handoff — start here

Rewritten 2026-08-18. This is the **forward-looking** document: where things stand, what is
open, what to be careful of. The narrative of how each decision was reached moved to
[`docs/HISTORY.md`](docs/HISTORY.md), which is indexed and deliberately not loaded until needed.

Read order for a new session: this file → [`CLAUDE.md`](CLAUDE.md) (auto-loaded anyway) → then
only the document the task actually needs.

## Where things stand

**v0.14.0, M0–M5 complete, installed and working in the user's own browser.**

- The click half has been stable since v0.9.0 and is verified against all five click fixtures.
- The preference half (capture, replay, re-assertion, early drift repair, the loss watcher) was
  built across v0.12.0–v0.14.0 and verified against four preference fixtures plus Wikipedia's own
  served markup.
- **2026-08-18: the user ran the first rounds of [`docs/TESTING.md`](docs/TESTING.md) in
  Violentmonkey and reported them working.** That closes the largest gap — the script runs under
  real Violentmonkey with real GM storage, and the Wikipedia flow behaves. Recorded as reported;
  no trace was reviewed here, so treat it as "works" rather than "measured".
- The old GateSkip script is uninstalled, so the two-copies click-collision hazard is gone.

## What is still unverified

Rounds 4–9 of `docs/TESTING.md`, in rough order of how likely they are to find something:

1. **Re-assertion's own `touched` gate** (Round 2, step 12). Inspected, never measured — the
   automated tooling could not deliver a trusted click inside the first second of a page load.
   This is the single most likely thing to be wrong.
2. **First paint against a real network.** Every timing number on record came from localhost,
   where DOMContentLoaded is ~50ms. A cold cache moves everything, and `watchEarlyDrift` is
   bounded at `EARLY_FIXES` (5).
3. **The click runner on framework-generated markup.** All five click fixtures are hand-written
   HTML. `jackdaniels.com` (Round 5) is its first real test — React-generated ids, an age gate and
   a OneTrust banner in one document.
4. **The classifier against real telemetry** (Round 4b, MDN's Glean keys).
5. **The `body`-attribute deferred replay path** (Round 4c, Material for MkDocs) — the entry that
   cannot be written at document-start.
6. **Cross-frame** (Round 6). May be untestable from a US IP, since most CMP-in-an-iframe walls
   are EU-only. Say so rather than forcing it.

## Outstanding issues

**Replay does not re-run on SPA navigation.** Found 2026-08-18 by reading the code:
`onUrlMaybeChanged` calls `arm()` only, so the click runner re-arms per URL change and the
preference half does not. Preferences are replayed once at document-start and never again for the
life of an SPA session — and `touched` is true after the first click anyway, so re-assertion would
be off regardless. Probably harmless (the root class usually survives an in-page navigation), but
untested. The case that would break it is a site whose route changes rewrite the root element.
Round 7 settles it with one measurement.

**The local fixtures collide with the installed script.** Every fixture loads the userscript itself
via `<script src="../Forget-Me-Not.user.js">` on top of a `localStorage` GM shim, so with v0.14.0
installed and matching `*://*/*` a fixture page runs **two copies**. Separate rule stores, so they
mostly ignore each other — but they share the `__forgetmenot__` postMessage tag, so any teaching
test involving `fixture-iframe.html` records **duplicate steps**, and the real trace fills with
`localhost` noise. Turning the master switch off does not fix it: the message handler that starts
the recorder is not gated on `isOn()`.

> **Decision owed:** add `// @exclude http://localhost:8731/*` (one line, permanent, costs the
> ability to run Forget Me Not on the user's own localhost dev pages), or keep disabling the script
> in Violentmonkey by hand while running fixtures. Not decided.

**Per-host rules only.** A CMP like OneTrust ships the same `#onetrust-accept-btn-handler` on
thousands of sites, and today it has to be taught on each one separately. Host keying is
deliberate and well-reasoned (see `CLAUDE.md`), so this is a feature request, not a bug — but it is
the most obvious source of repeated labour once real browsing starts.

## Deliberately deferred

- **Rung 1 vs rung 2 sufficiency.** At capture time both a DOM diff and a storage diff may be
  present, and knowing which is *sufficient* needs a reload to test. v1 replays whatever was ticked
  and lets the user trim. An automatic "try fewer entries" pass can come later, once there is
  evidence about how often it matters. One data point so far: on Wikipedia rung 1 is sufficient
  alone. Material for MkDocs (Round 4c) offers both and would be the second.
- **IndexedDB-backed preferences.** Out of v1. Async, awkward, unmeasured — wait for a site that
  needs it.
- **Request headers.** A userscript cannot touch them. If server-rendered preferences ever become
  important, that is an extension, not a feature.
- **The `ss` entry kind.** The weakest of the four and known to be so. Drop it the moment it costs
  anything.

## Standing lessons that keep paying off

These are the ones that have caught real bugs more than once. The full set of engineering rules is
in `CLAUDE.md`; these are the meta-ones about *how to investigate*.

- **A false positive is far worse than a false negative** in any "did it work?" test. A false
  negative costs a few extra clicks; a false positive writes the step off permanently *and* logs an
  event that never happened, which destroys the only instrument there is.
- **Every verdict must name the signal that fired.** A verdict you cannot audit is how three
  versions of misdiagnosis happened.
- **A before/after comparison cannot detect a change that was undone.** When the question is "does
  this site fight us?", the instrument has to be an observer, not a diff.
- **"It only works when debug is on" is about the delay, not about debug**, and the cause has been
  different every single time. Reproduce in a fixture and run the control against the previous
  version before believing any theory.
- **Nothing in this script may alter timing in order to explain itself.**
- **Rule loss is not a cost and may never appear in a design argument.** Reshape storage whenever
  it is convenient; the only reason to split work is regression attribution.
- Driving fixtures does not need the teach flow — write `GM:fmn_rules` straight into
  `localStorage`. Recipe in `docs/TESTING.md`, Part 2.
