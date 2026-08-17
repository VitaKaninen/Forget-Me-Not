# Preference replay — design

Status: designed 2026-08-17, not yet built. Read the "Why the project exists" section of
`../CLAUDE.md` first; it carries the privacy reasoning and the replay ladder, and this
document assumes both.

Short version: hold the user's site preferences in GM storage, and reapply them at
document-start so the site behaves as if it remembered — without the site being told
anything. Rung 3 (cookies) does not exist. The existing click runner becomes the fallback
for state with no stored representation.

## Confirmed before designing

- **GM storage is not partitioned per container.** Confirmed by the user 2026-08-17. The
  whole design rests on this: it is the only store that survives the container being
  destroyed, which is what makes replay possible at all.
- Wikipedia's anonymous preferences are read **client-side**, from a cookie whose value is
  literally a CSS class name, and the served HTML is identical for everyone (CDN-cached, so
  it cannot vary). Measured 2026-08-17 — see CLAUDE.md.

## Data model

`gs_rules` gains a version and splits into two independent halves. The click half is exactly
today's rule, moved down a level.

```js
{
  "en.wikipedia.org": {
    v: 2,
    clicks: { steps: [...], watchMs, fires, lastFired },   // unchanged, may be absent
    prefs: {
      captured: "2026-08-17T…",
      entries: [ /* see below */ ]
    }
  }
}
```

Entry kinds, smallest-blast-radius first:

```js
{ kind:'class', sel:':root', add:['…-clientpref-0'], remove:['…-clientpref-1'] }
{ kind:'attr',  sel:':root', name:'data-theme', value:'dark' }
{ kind:'ls',    key:'…', value:'…' }        // localStorage
{ kind:'ss',    key:'…', value:'…' }        // sessionStorage
```

Every entry also carries `enabled` (the tick box) and `flag` (`'ok'` or `'idlike'`, from the
classifier). **There is no cookie kind, deliberately** — see CLAUDE.md for why, and do not
add one.

Migration: a v1 rule (bare `steps`) is rewritten to `{v:2, clicks:{steps:…}}` on read. Keep
the migration for a long time; rules are hand-taught and expensive to lose.

## Capture — "Remember this site"

The user sets the site up how they like it, then hits one menu command. No step recording.

### The baseline problem, and the settled baseline

A capture is a diff, so it needs a "before". The obvious choice — snapshot at document-start
— is wrong, and wrong in a way this project has already paid for twice. The diff would then
contain everything that happened during the visit, including the site's own start-up: on
Wikipedia that is `client-js`, `mw-ready`, `vector-sticky-header-visible`, plus whatever
session and analytics keys the page wrote. The signal (`…-clientpref-0`) would be buried in
noise, exactly as the v0.6.0 success test was.

So: **the baseline is taken once the page has settled, not when it started.**

    settled baseline := snapshot at `load` + 2000ms, OR at the first real user
                        interaction, whichever happens first

Start-up noise has landed by then and is excluded by construction. What remains in the diff
is overwhelmingly what the user themselves did this visit, which is what we want to keep.

Taking it at first interaction too is what makes it safe for someone who changes a setting
three seconds after load. Late-arriving site classes (a widget that adds one at 5s) will
still slip into the diff; the review step is what catches those, and they should be rare
enough not to matter.

### Review

The diff is presented as a list. Nothing is saved until confirmed.

- Short, enumerable-looking values arrive **pre-ticked**.
- UUIDs, base64 blobs, long mixed-case tokens, 10+ digit numbers (timestamps), and keys whose
  *name* contains `id` / `uid` / `session` / `token` / `visitor` arrive **unticked**, with a
  one-line reason. Overridable in both directions.
- The classifier annotates and pre-decides; it never blocks. The user is the gate.

Design rule from the privacy section: **prefer the smallest entry set that works.** Unticking
and re-testing must be one click, because the intended workflow is to trim until it stops
working and then step back one.

## Replay

At document-start, per frame, for the matching host, in this order:

1. `ls` / `ss` entries — written before any site script runs, so the site reads them as if
   they had always been there. This is the whole trick.
2. `class` / `attr` entries on `:root` — `<html>` exists at document-start.
3. `class` / `attr` entries on `body` — deferred to DOMContentLoaded.

**v1 supports only `:root` and `body` as DOM targets.** Every preference measured so far
lives on the root element, and arbitrary selectors drag in the whole resolution-and-retry
problem the click runner already owns. Widen it only when a real site demands it.

### Re-assertion, and how we find out it stopped working

Some sites will normalise the root element during start-up and overwrite what we wrote. So
DOM entries are re-applied at DOMContentLoaded, at `load`, and at `load`+1000ms — and
**every re-application writes a trace line naming the entry**. That line is the health
signal: a site that needs re-asserting is a site that is fighting us, and one that suddenly
starts needing it has changed under the rule.

Re-assertion **stops at the first user interaction**. Otherwise a preference the user
deliberately changes mid-visit gets stamped back, which is the same class of harm as
re-clicking a toggle that stayed on screen.

### Interaction with the click runner

None, by design. Replay runs at document-start; the click runner arms as it does today. If
replay makes a gate not appear, the runner simply never matches step 1 and says so in the
trace — a path it already handles. Keep this seam clean: the two halves share the settings
UI, the host-keyed storage, and the trace, and nothing else.

## Testing

Fixtures to write, each isolating one mechanism:

- `fixture-pref-ls.html` — served with `theme-light` on `<html>`; its own script reads
  localStorage on load and applies `theme-dark` if set. Proves rung 2.
- `fixture-pref-dom.html` — same look, but nothing reads storage; the class alone drives the
  CSS. Proves rung 1 is sufficient on its own, and that we notice.
- `fixture-pref-hostile.html` — actively resets the root class at 1000ms. Proves
  re-assertion, and that the trace says it happened.
- `fixture-pref-noise.html` — dumps start-up classes and session keys during load, then lets
  the test flip one real preference. Proves the settled baseline keeps the noise out of the
  captured diff. This is the fixture that would have caught v0.6.0's mistake in its new form.

Then the real target: Wikipedia, anonymous, in a fresh container — sidebar closed and dark
theme, from first paint, with nothing sent.

## Build order

1. Schema v2 + migration, no behaviour change. Ship and confirm existing rules survive.
2. Settled baseline + capture + review UI.
3. Replay + re-assertion + trace lines.
4. The four fixtures.
5. Wikipedia.

## Open, deliberately deferred

- **IndexedDB-backed preferences.** Out of v1. Async, awkward, and unmeasured — wait for a
  site that actually needs it.
- **Rung 1 vs rung 2 sufficiency.** At capture time both a DOM diff and a storage diff may be
  present, and knowing which is *sufficient* needs a reload to test. v1 replays whatever was
  ticked and lets the user trim; an automatic "try fewer entries" pass can come later, once
  there is evidence about how often it matters.
- **Request headers.** A userscript cannot touch them. If server-rendered preferences ever
  become important, that is an extension, not a feature — keep the seam clean rather than
  half-emulating it.
