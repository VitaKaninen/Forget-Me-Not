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
- **Rung 1 alone is sufficient for Wikipedia's theme and layout preferences. Measured
  2026-08-17** on `en.wikipedia.org/wiki/Cat`, anonymous. Swapping only the root class —
  `skin-theme-clientpref-day` → `skin-theme-clientpref-night` — moved `body`'s computed
  background from `rgb(248, 249, 250)` to `rgb(32, 33, 34)`, with **localStorage untouched and
  empty throughout**. So dark mode needs no rung 2 at all: the CSS is already served and keyed
  off that class, and nothing has to be told anything. Same shape for the TOC pin
  (`vector-feature-toc-pinned-clientpref-1` → `-0`).

  The full set of `clientpref` classes on a default anonymous visit, all on `:root`, is:
  `vector-feature-toc-pinned-clientpref-1`, `vector-feature-limited-width-clientpref-1`,
  `vector-feature-custom-font-size-clientpref-1`,
  `vector-feature-appearance-pinned-clientpref-1`, `skin-theme-clientpref-day`,
  `skin-thumbsize-clientpref-standard`. Low-entropy and enumerable — every one should arrive
  **pre-ticked** from the classifier, and together they are the whole M5 target.

  Note the Appearance panel's radio controls are **not in the served HTML** — `skins.vector.js`
  populates them, and it had still not done so 4s after load in a background tab. That is the
  same late-binding module that beat the click runner's retry ladder in v0.5.0, and it is a
  concrete argument for prefs over clicks on this site: rung 1 does not care whether the
  control ever appears.

## Data model

`gs_rules` gains a version and splits into two independent halves. The click half is exactly
today's rule, moved down a level.

```js
{
  "en.wikipedia.org": {
    v: 2,
    host, subdomains, enabled,
    clicks: [                                              // ARRAY — see below
      { id, label, steps: [...], watchMs, fires, lastFired, created }
    ],
    prefs: {
      captured: "2026-08-17T…",
      entries: [ /* see below */ ]
    }
  }
}
```

**`clicks` is an array of independent sequences, corrected 2026-08-17** — this section
originally drafted it as a single object. One host routinely needs a second, unrelated
dismissal taught several pages deeper, and that cannot be expressed as extra *steps*: a
sequence blocks on step N before hunting N+1, so a deep-page popup appended as "step 3" fires
on neither page. Each sequence arms simultaneously and self-selects by whether its step 1
resolves — no URL matching. Implemented in v0.11.0; reasoning in `../CLAUDE.md`.

Entry kinds, smallest-blast-radius first:

```js
{ kind:'class', sel:':root', add:['…-clientpref-0'], remove:['…-clientpref-1'] }
{ kind:'attr',  sel:':root', name:'data-theme', value:'dark' }
{ kind:'ls',    key:'…', value:'…' }        // localStorage
{ kind:'ss',    key:'…', value:'…' }        // sessionStorage
```

Every entry also carries `enabled` (the tick box), `flag` (`'ok'` or `'idlike'`) and `why` (the
classifier's one-line reason). **There is no cookie kind, deliberately** — see CLAUDE.md for
why, and do not add one.

Three things settled while building the capture side (v0.12.0), all reasoned in `../CLAUDE.md`:

- **One entry per class**, so the arrays are always length 0 or 1. Six of Wikipedia's
  `clientpref` classes in a single tick box could not be trimmed, and trimming is the workflow.
  A class entry's identity is the class **name**; the sign is its state, exactly as an
  attribute's name is identity and its value is state.
- **`attr` `value: null` means "remove it".** DOM removals are replayable because the document
  is served the same way every visit. **Storage removals are not offered at all** — the key was
  never there in a fresh container — and are counted in the panel footer instead.
- **An unticked `idlike` entry is stored without its value** (`redacted: true`). Keeping a copy
  of a session id in the one store the container cannot reach is the harm this project exists
  to prevent, and replay would never have read it.

`ss` is the weakest of the four and it is worth saying so, since it was listed above with no
argument attached. Unlike `ls`, sessionStorage dies with the tab whatever the container does —
so replaying it is not restoring something the container destroyed, it is manufacturing a
resumed session that never existed. It survives the counterfactual test anyway (you would have
dismissed that session-scoped banner by hand in every fresh tab) and it shares the `ls` code
path entirely, so it is nearly free. Drop it the moment it costs anything.

**There is no migration, and no v1 read path. Corrected 2026-08-17.** This section used to say
a v1 rule (bare `steps`) is rewritten on read, and to "keep the migration for a long time; rules
are hand-taught and expensive to lose". The premise was wrong — the user settled it, twice, the
second time emphatically: rules cost seconds to recreate and will be wiped 30–50 times before
this project is done. **Rule loss is not a cost and must not appear in any design argument** —
including the seductive one that a schema should be settled early "while the shape is open".
Reshape storage whenever it is convenient. See `../HANDOFF.md` for the full statement.

## Capture — "Remember this site"

The user sets the site up how they like it, then hits one menu command. No step recording.

### The baseline problem, and the settled baseline

A capture is a diff, so it needs a "before". The obvious choice — snapshot at document-start
— is wrong, and wrong in a way this project has already paid for twice. The diff would then
contain everything that happened during the visit, including the site's own start-up: on
Wikipedia that is `client-js`, `mw-ready`, `vector-sticky-header-visible`, plus whatever
session and analytics keys the page wrote. The signal (`…-clientpref-0`) would be buried in
noise, exactly as the v0.6.0 success test was.

So: **the baseline is "the state of the page at the last moment before you touched
anything".** Everything the site did during start-up is inside it and cannot appear in the
diff. Everything the user did is after it, and does.

    baseline := ONE snapshot, taken in a window capture-phase listener on the first
                pointerdown / keydown / click

**Built 2026-08-17 as a single frozen snapshot, not the rolling ~500ms poll this section
originally specified.** Same definition; the polling was not needed to reach it. The capture
path starts at `window`, so the listener runs before the site's own handler and the page has
not yet reacted to the click — which makes freezing *at* the interaction strictly more accurate
than a poll up to 500ms stale, and free on a page nobody touches. The argument that decided it:
a single frozen snapshot can tell **"you never interacted with this page"** apart from **"you
interacted and nothing changed"**, and rolling collapses both into an empty diff. The first is
common — a preference set inside a cross-origin frame, whose events the top frame never sees —
and it deserves an honest refusal rather than a silent shrug.

**An earlier draft had this as "`load`+2000ms, or first interaction, whichever comes first",
and that is broken.** Scroll at 500ms and the baseline freezes before the site has finished
starting up, so all the remaining start-up noise lands in the capture diff — the exact thing
the baseline exists to exclude. Rolling-then-freeze is both simpler and correct, and it
handles the open-a-tab-walk-away-come-back-and-click case for free: whatever the site did at
t=30s is in the baseline, because the user had not touched anything yet.

Residual: a site that changes something on its own *after* the user's first interaction will
have that land in the diff. Unavoidable, and what the review step is for.

### What the snapshot covers

Settled 2026-08-17: the class list and **all** attributes of `:root` and `body`, plus the
complete localStorage and sessionStorage key/value maps. Capture is **top frame only** — the
menu commands are already gated on `isTop` — while replay is per frame. That asymmetry is
intended: a frame gets the rule for its own host, or it gets nothing.

### Review

The diff is presented as a list. Nothing is saved until confirmed.

**One panel, built once, shown in two places** (settled 2026-08-17): immediately after
"Remember this site" with the diff pre-ticked, and re-openable per host from Settings. Both are
needed — the decision wants the context you have at capture time, but the trim-until-it-breaks
workflow below is impossible if review only ever happens once. Do not build two UIs.

**The question this UI asks is "which of these did you mean to set?"** — not "which of these
look risky?". That framing is load-bearing, not cosmetic. The diff necessarily mixes
*user-caused* state (the preferences, which cost nothing to replay because the user would
have clicked them anyway) with *site-caused* state (session ids, analytics keys, consent
blobs — which the container was going to destroy, and which replay would resurrect). Only
the user can separate those, and they can do it at a glance if asked the first question.
Asked the second, they are being made to audit entropy, which they cannot do and should not
have to. See the counterfactual section in `../CLAUDE.md`.

- Short, enumerable-looking values arrive **pre-ticked**.
- UUIDs, base64 blobs, long mixed-case tokens, 10+ digit numbers (timestamps), and keys whose
  *name* contains `id` / `uid` / `session` / `token` / `visitor` arrive **unticked**, with a
  one-line reason. Overridable in both directions.
- The classifier annotates and pre-decides; it never blocks. The user is the gate. It is a
  labour-saver for the "did you mean this?" question, not an authority on safety.

**Prefer the smallest entry set that works.** Unticking and re-testing must be one click,
because the intended workflow is to trim until it stops working and then step back one. The
reason is robustness rather than privacy: fewer entries mean less to break at the site's next
redesign and less to debug.

## Replay

At document-start, per frame, for the matching host, in this order:

1. `ls` / `ss` entries — written before any site script runs, so the site reads them as if
   they had always been there. This is the whole trick.
2. `class` / `attr` entries on `:root` — `<html>` exists at document-start.
3. `class` / `attr` entries on `body` — deferred to DOMContentLoaded.

**v1 supports only `:root` and `body` as DOM targets.** Every preference measured so far
lives on the root element, and arbitrary selectors drag in the whole resolution-and-retry
problem the click runner already owns. Widen it only when a real site demands it.

**Storage entries are written only if the key is absent** (added v0.13.0). Replay restores what
the container destroyed; a value still sitting there was not destroyed, so this browser kept it
and the user may have changed it since. Overwriting would stamp an old preference over a newer
one.

### Re-assertion, and how we find out it stopped working

Some sites will normalise the root element during start-up and overwrite what we wrote. So
DOM entries are re-applied at DOMContentLoaded, at `load`, and at `load`+1000ms — and
**every re-application writes a trace line naming the entry**. That line is the health
signal: a site that needs re-asserting is a site that is fighting us, and one that suddenly
starts needing it has changed under the rule. (A pass that changed nothing writes no line: it
was not a re-application, and a heartbeat on every quiet pass would bury the ones that matter.)

Re-assertion **stops at the first user interaction**. Otherwise a preference the user
deliberately changes mid-visit gets stamped back, which is the same class of harm as
re-clicking a toggle that stayed on screen. **Trusted events only** — the click runner
dispatches its own pointer events, and without that guard a host with both halves taught froze
its baseline at ~7ms and lost re-assertion entirely.

**The scheduled points are not soon enough on their own** (learned on Wikipedia, v0.14.0). It
reassigns the whole root `className` about a millisecond after our document-start write, and the
DOMContentLoaded pass is ~50ms behind that — long enough for first paint to land in the wrong
theme. So drift during start-up is repaired **on the mutation that causes it**, bounded by a fix
cap and handing over to the scheduled passes at DOMContentLoaded.

Immediately after the last re-application, one line states what actually held — **including how
many held only because they were put back**, since "it holds" and "it holds because we kept
fighting for it" are different results. Everything after that moment is covered by a read-only
observer that reports the first loss and disconnects; it never re-applies. A fixed-time audit was
tried first and was worse than nothing: on `fixture-pref-hostile.html?reset=6000` it reported
success three seconds before the site took the preference back.

### Interaction with the click runner

None, by design. Replay runs at document-start; the click runner arms as it does today. If
replay makes a gate not appear, the runner simply never matches step 1 and says so in the
trace — a path it already handles. Keep this seam clean: the two halves share the settings
UI, the host-keyed storage, and the trace, and nothing else.

## Testing

**Written and verified 2026-08-17, before any pref code.** Four fixtures, one mechanism each,
plus the shared instrument `tests/pref-probe.js`. Full description in `../CLAUDE.md`; what each
one asserts is also written on the page itself.

- `fixture-pref-ls.html` — served with `theme-light` on `<html>`; its head script derives the
  class from `localStorage['fmnfix.theme']` **authoritatively**, overwriting whatever was there.
  Proves rung 2, and discriminates: a class-only replay is erased before first paint.
  `sawAtParse` is `"dark"` only if the value was in storage before any site script ran. Also
  carries the `ss` case, as a session banner.
- `fixture-pref-dom.html` — nothing reads or writes storage; `html[data-theme]` and
  `body.sidebar-hidden` are the entire preference. Proves rung 1 is sufficient on its own, and
  that we notice — a capture here must yield two DOM entries and `ls`/`ss` of `{}`.
- `fixture-pref-hostile.html?reset=<ms>[,<ms>…]` — rewrites the whole root class list at each
  listed moment (default `1000`). Proves re-assertion and that the trace names the entry.
  `?reset=6000` lands after the last re-assertion point: the preference is then genuinely lost,
  and the requirement is that the loss is *visible*, never a claim of success over a page
  sitting in light mode.
- `fixture-pref-noise.html?startup=<ms>` — writes three root classes, a root attribute, a body
  class, four `ls` and two `ss` keys during start-up, none of which may reach a capture. One
  click on Toggle theme then yields exactly four entries, two of them site-caused and required
  to arrive **unticked** (`analytics.lastSeen`, a 13-digit bump; `clickId`, a UUID) because the
  site writes them in the same handler. Proves both the settled baseline and the classifier.
  Interacting before start-up finishes reproduces the documented residual.

Then the real target: Wikipedia, anonymous, in a fresh container — sidebar closed and dark
theme, from first paint, with nothing sent.

## Build order

**Corrected 2026-08-17 — the fixtures used to sit at step 4 here, which contradicted
`../HANDOFF.md` M2 in the same package.** Fixtures-first wins, and the reason is the one
HANDOFF gives: four versions of this project were burned on never having stated precisely what
"working" means. The four pages describe *site* behaviour, so none of them needs the storage
shape or any pref code to exist first.

1. Schema v2 + `fmn_*` keys, no behaviour change, no migration. ✅ v0.10.0 / v0.11.0.
2. **The four fixtures**, before any pref code is written. ✅ 2026-08-17.
3. Baseline + capture + review panel. ✅ v0.12.0.
4. Replay + re-assertion + trace lines. ✅ v0.13.0.
5. Wikipedia. ✅ v0.14.0 — measured live and run end to end against its own markup and modules.
   Rung 1 alone, two entries, both pre-ticked, nothing transmitted. It reassigns `className`
   during start-up, so early drift repair was needed to hit "from first paint"; the note in
   `../CLAUDE.md` also records the measurement that got this wrong first time.

## Open, deliberately deferred

- **IndexedDB-backed preferences.** Out of v1. Async, awkward, and unmeasured — wait for a
  site that actually needs it.
- **Rung 1 vs rung 2 sufficiency.** At capture time both a DOM diff and a storage diff may be
  present, and knowing which is *sufficient* needs a reload to test. v1 replays whatever was
  ticked and lets the user trim; an automatic "try fewer entries" pass can come later, once
  there is evidence about how often it matters. **First data point in: on Wikipedia rung 1 is
  sufficient on its own and rung 2 is not needed at all** (measured 2026-08-17, above). One
  site is not a pattern, but it is the M5 target, so M5 does not depend on resolving this.
- **Request headers.** A userscript cannot touch them. If server-rendered preferences ever
  become important, that is an extension, not a feature — keep the seam clean rather than
  half-emulating it.
