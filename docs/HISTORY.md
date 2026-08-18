# Forget Me Not — history

The long version. **Nothing here is needed to start a session**, and none of it describes how
the script works today — `../CLAUDE.md` does that, and it is the one that is always loaded.

This is where the *reasoning* lives: how each rule in `../CLAUDE.md` was arrived at, which
diagnoses were wrong first, and which arguments were made and then withdrawn. Read a section
when you are about to change the thing it is about, or when a rule in `../CLAUDE.md` looks
arbitrary and you are tempted to ignore it. Every one of them cost at least one version.

`../CLAUDE.md` carries an index pointing here by topic.

## Contents

| Version | What happened | Read it when |
|---|---|---|
| [v0.3.0](#v030--a-click-is-not-an-outcome) | A click and an outcome were the same thing, and they are not | Touching click verification |
| [v0.4.0](#v040--the-watch-window-was-measured-from-the-wrong-end) | The watch window was spent while the page was still loading | Touching `arm` / `extendWatch` / the restart test |
| [v0.5.0](#v050--the-retry-ladder-has-to-outlast-the-pages-start-up) | The retry ladder ran out before the site bound its handlers | Changing `CLICK_TRIES` / `RETRY_WAIT` |
| [v0.6.0](#v060--the-success-test-was-reading-the-pages-start-up-as-success) | Ancestor sizes and `<body>` classes read as proof a click worked | Touching `clickState` / `ancestry` |
| [v0.7.0](#v070--the-last-over-generous-signal-was-the-elements-own-size) | The clicked element's own box size was the last false positive | Same |
| [v0.9.0](#v090--debug-mode-is-gone) | Debug mode removed; why a narration mode that alters timing is harmful | Tempted to add any diagnostic that changes timing |
| [v0.11.0](#v0110--several-sequences-per-host-all-armed-at-once) | Why `clicks` is an array and why there is no URL matching | Touching the rule shape or the runner's arming |
| [v0.12.0](#v0120--capture-baseline-classifier-review-panel) | The baseline, the classifier, the review panel | Touching capture |
| [v0.13.0](#v0130--replay-rungs-1-and-2-re-assertion-and-the-loss-watcher) | Replay, re-assertion, and why a timed audit was worse than nothing | Touching replay |
| [v0.14.0](#v0140--wikipedia-and-the-measurement-that-was-wrong) | Wikipedia, and a before/after diff that could not see what it was looking for | Measuring whether a site fights us |
| [The rename](#the-rename-gateskip--forget-me-not-v080) | GateSkip → Forget Me Not | Chasing a stale path or an old URL |
| [Milestone log](#milestone-log-m0m5) | M0–M5, what each shipped and why it was split that way | Wondering why a change was sequenced the way it was |
| [Privacy reasoning](#privacy-reasoning--the-long-form) | The long form of the two withdrawn arguments | Tempted to re-open the cookie rung or the review step |

---

## v0.3.0 — a click is not an outcome


The bug that forced this: **"clicked it" and "clicked it and something happened" were the
same thing here, and they are not.** Markup is routinely served with its handler attached
seconds later — the control is present, visible and completely inert in the meantime — and
every click into that dead window was counted as a dismissal. The log said *"dismissed the
gate (2 clicks)"* over a gate that was still on screen. Reproduced and pinned down with
`../tests/fixture-late.html` (wires its handlers at 2000ms); v0.2.0 fails it exactly that way.

This is also why debug mode "fixed" it: `DEBUG_DELAY` put 5 seconds in front of every click,
which is long enough for anything to hydrate. **Debug mode changing the outcome is itself
the diagnosis** — the only thing it varies is time.

So every click now goes fire → wait → check (`fireClick` / `commitClick`, and the
`run.verify` block in `tick`), retried up to `CLICK_TRIES` with `RETRY_WAIT` backoff, and a
step counts as done only once the page demonstrably moved.

- **What counts as "the page moved" is the hard part, and one level up is not enough.**
  `clickState` looks at the element (gone / visible / checked / disabled / aria-*) *and*
  `ancestry()` — class **and size** for 6 levels up. Sizes matter because a section
  collapsing is often the only consequence there is. *(Both halves of that sentence were
  wrong and are gone: ancestor sizes went in v0.6.0, the element's own size in v0.7.0 —
  layout noise during load reads as a result. Do not put either back.)* First cut compared the element and its
  immediate parent, which caught Wikipedia's panel toggle (class lands on the parent) and
  missed `fixture-late.html`'s (grandparent) — and the miss is not harmless: it burned all
  four attempts on a *toggle*, so the panel ended up clicked back open. **A false negative
  here is actively destructive, a false positive is merely the old behaviour.** Bias
  detection toward generous.
- **Never let a retry loop near a control without a working effect test.** The project rule
  "never re-click a gate that stayed on screen" is what the verification is for; retries
  reintroduce that hazard the moment detection goes blind.
- Exhausting the attempts is **reported, not swallowed** — `run.noop` downgrades the
  completion line to "ran all N clicks, but at least one of them changed nothing".

---

## v0.4.0 — the watch window was measured from the wrong end


`arm()` runs at document-start, so the ten-second window was spent *while the page was still
loading*. A gate that arrives with a vendor script at ~12s was never seen on a normal visit —
but opening Settings or toggling debug called `arm(true)`, which opened a fresh window with
the gate already on screen, so it fired **instantly**. The reported symptom was "it only works
when debug is on or I change a setting", which sounds like a state bug and is not one.

`extendWatch()` renews the budget at DOMContentLoaded and at `load`; hunting still starts at
document-start. Default raised 10s → 15s. **The tell for this class of bug: a fix that works
when you look at it and not otherwise is about time, not state.** Same tell as v0.3.0's
`DEBUG_DELAY`.

**A vanish during the verify window used to be lost.** The restart test is "step 1 stopped
resolving and then started again" — necessary because plenty of sites re-attach the *same*
node, where identity says nothing. `run.vanished` was only ever set inside the `run.done`
branch, but the verify/retry cycle put a 450ms gap between the click and `run.done`, and a gate
that vanished and returned inside that gap was never recorded as having gone. `commitClick`
now records it. Caught on `fixture-simple.html`, which detaches and re-attaches its gate at
400ms — end state was the gate still up with the log claiming a dismissal.

**The Browser pane throttles timers when hidden** (`document.visibilityState === 'hidden'`),
which stretches every sub-second timing in these tests and makes the first click land in the
un-wired window far more often than on a visible tab. Do not read a flaky sub-second fixture
result as a script bug without checking `visibilityState` first.

**The icon inside the button is not the button.** A step recorded as `path (no text)` is a
click that landed on an `<svg>` child. Two fixes, because old rules already store the
`<path>`: `clickableFrom` (teach time) falls back to the nearest ancestor with
`cursor: pointer` when nothing matches `CLICKABLE` — which is what a `<div>`-with-a-listener
close button looks like from outside — and `clickCandidates` (click time) builds the same list
for an old rule that already stored the `<path>`. Note `el.click()` is `HTMLElement`'s, so on
an SVG node it **throws** — the `dispatchEvent` fallback in `realClick` is load-bearing, not
belt-and-braces.

- **`cursor` is an INHERITED CSS property, so this fallback lands on the icon unless you stop
  it.** The `<svg>` and the `<path>` inside a `cursor: pointer` wrapper both compute to
  `pointer` themselves, so "walk up and take the first match" returns the very element it
  exists to walk out of. Both passes skip `INERT_TAG`. This silently defeated the whole fix —
  teaching still recorded `path (no text)` — and looked like the fallback not running at all.
- **The retries work through the candidates instead of repeating one guess** (`fireClick`
  cycles `v.cands` modulo, so a single candidate still means "click the same thing again",
  which is what the not-yet-wired case needs). Order: declared control, then thing that merely
  looks like a control, then the node taught, then its parent.
- **Exhausting them now says "re-teaching this step will record a better target"**, because
  for an old rule that is the actual cure.

`realClick` also sends real `clientX/clientY` now. A bare `new MouseEvent('click')` reports
0,0, and handlers that hit-test or position themselves off the pointer can reasonably ignore
that.

---

## v0.5.0 — the retry ladder has to outlast the page's start-up


Third time the same confound produced the same misleading symptom, so it is worth stating as
a rule: **when the reported symptom is "it only works with debug on", the variable is
`DEBUG_DELAY`, not debug.** Twice now the user's own experiment settled it — toggling debug
*either direction* made it work, which cannot be about debug's behaviour, only about the five
seconds it inserts and the `arm(true)` the toggle performs.

Here the ladder (4 attempts over ~3.5s) ran out before Wikipedia's `skins.vector.js` bound its
panel toggles. The step was then written off permanently while **the watch window still had ten
seconds left and the control was sitting right there**. Giving up was terminal: `commitClick`
marks the sequence done, and the restart test needs the gate to vanish and return, which a
panel toggle that stays visible never does.

Now 8 attempts over ~16s, gaps growing 400 → 3000ms, and the verify grace grows with them
(450 → 1200ms) because a busy page can take longer than 450ms to show a reaction. The debug
line reports `document.readyState` at click time — a click landing while the document is still
`loading`/`interactive` is the one most likely to hit an unbound handler, and that is invisible
from anywhere else.

**What is NOT a fix for this: waiting for readyState before clicking.** It would forfeit
dismissing a server-rendered gate before first paint, which is the whole reason hunting starts
at document-start. And it would not have helped here anyway — Vector binds long after
`complete`. Nor can a MutationObserver help: `addEventListener` produces no mutation, so
"handler attached" is unobservable by construction. Time-based retry is the only lever.

Test it with `../tests/fixture-late.html?wire=8000`; v0.4.0 fails it, logging that it clicked
step 1 four times with the gate still up.

---

## v0.6.0 — the success test was reading the page's start-up as success


**This was the actual bug behind "only works with debug on", and v0.3.0–v0.5.0 all
misdiagnosed it as timing.** The click with debug off lands while the document is still
loading. `clickState` compared ancestor **sizes** — which change constantly while a page lays
out — and walked up as far as `<body>` and `<html>`, whose class list MediaWiki rewrites all
through start-up (`client-js`, `vector-feature-*`, `mw-ready`). So the verification saw motion
and counted the dead click as a dismissal: no retries, `sequence complete`, and a log line
claiming success over a gate that never moved. The five-second `DEBUG_DELAY` pushed the click
past the noisy window, which is the entire reason debug mode "fixed" it.

`ancestry()` now takes **classes only**, of at most 5 ancestors, and **stops before `<body>`
and `<html>`**. The clicked element's own box size is still compared — that one is a fair
signal, since collapsing or hiding is the consequence.

- **A false positive here is far worse than a false negative**, and the earlier note in this
  file saying the opposite ("a false positive is merely the old behaviour") was wrong. A false
  negative costs a few extra clicks. A false positive writes the step off permanently *and*
  logs a dismissal that never happened — it destroys the log's credibility, which is the only
  instrument there is.
- **Every commit now names the signal that fired** (`counted as done — 'anc' changed`, or
  `— the step stopped resolving`). A verdict you cannot audit is how three versions of
  misdiagnosis happened; do not remove this.
- Reproduce with `../tests/fixture-late.html?wire=8000&churn=1`. v0.5.0 fails it while logging
  "dismissed the gate (2 clicks)" with the gate still up.

---

## v0.7.0 — the last over-generous signal was the element's own size


Same false positive as v0.6.0, one field further in. `clickState` still compared the clicked
element's own `size`, on the reasoning that "collapsing or being hidden is the consequence".
But a control's box also moves for reasons that have nothing to do with being clicked — a web
font swapping in, a stylesheet finishing, an icon decoding — and every one of those lands in
the first few hundred milliseconds, which is exactly the window the first click is fired and
judged in. Verdict: `counted as done — 'size' changed`, log line "dismissed the gate (1
click)", step written off, control still sitting there working.

**The user's symptom named the cause precisely and it was not timing:** first load on a fresh
tab does nothing, *reloading the same page works*. A reload has the font in cache, so the box
never moves, the retries run, and the click eventually lands on a wired handler. Only the cold
first load has the noise in it. Anything that says "works on refresh, not on a fresh tab" is
about **load-time noise being read as a result**, not about how long the script waits.

Second tell from the same report: closing the panel by hand and reopening it made Forget Me Not
close it. That is the vanish-and-return restart path, which can only run once `run.done` is
set — i.e. proof that a click had already been committed on first load, silently and wrongly.
**"It did nothing" plus "the restart path works" means a false positive, not a missed match.**

`size` is now `collapsed` (width or height under 1px), which keeps the part that was meant and
drops the part that was noise.

- **Reproduce with `../tests/fixture-late.html?wire=8000&grow=1`.** v0.6.0 fails it at +615ms with
  `'size' changed`; v0.7.0 retries through the dead window and commits on attempt 5 at +9811ms
  with `'anc' changed` and the panel actually collapsed.
- **The first `grow` knob was wrong and the wrongness is instructive:** it added a class to
  `#panel`, which moved the button's box *and* changed an ancestor's class list — and an
  ancestor gaining a class is exactly what a working panel-collapse looks like, so no rule
  could ever separate the two. It made the fix look like it had failed. A fixture for layout
  noise has to be layout and **nothing else** — it now writes an inline style on the button.
- That leaves a known blind spot with no detection built for it: **a late class landing on a
  container the taught element sits in is genuinely indistinguishable from a real effect.** If
  a site turns out to do that, the lever is a control sample (does a nearby element that was
  NOT clicked show the same change?) — but note a sibling shares the parent a real toggle
  marks, so a naive control sample kills the true signal too. Do not build it speculatively.

---

## v0.9.0 — debug mode is gone


Debug mode (v0.2.0) marked the element about to be clicked, waited 5s (`DEBUG_DELAY`), and
narrated to a HUD. It was always scaffolding, and it was **actively harmful as a diagnostic**:
the delay was long enough that failures stopped happening while you watched, so the case that
actually broke was never the one being observed. That confound produced three rounds of
misdiagnosis (v0.3.0, v0.4.0, v0.5.0 all blamed timing; the real causes were a missing effect
test, a watch window measured from the wrong end, and two over-generous success signals).

The trace replaced it and is strictly better: always on, costs nothing, and records the failing
run rather than a run perturbed into succeeding. **Nothing in this script may alter timing in
order to explain itself.** If a future subsystem needs narration, it writes trace lines.

Removed: `DEBUG_KEY` / `DEBUG_DELAY` / `isDebug`, the whole Debug HUD section, `run.debug` /
`run.pending` / `run.mark`, the `dbg` cross-frame message case, the Settings tickbox, the menu
command, and `.big` / `.l` / `gs-pulse` CSS with the label-and-handle half of `hlPaint`.
209 lines. `performClick`'s split from `tick` was kept — it is an improvement either way.

- **The cleanup list in this file had gone stale, and following it literally would have gutted
  the trace.** It said to delete "the `dbg` calls in `arm`/`tick`/`performClick`" — true when
  written at v0.2.0, when `dbg()` only drove the HUD. The trace arrived at v0.6.0 and made
  `dbg()` call `trace()` **unconditionally, before** the `isDebug()` early-return, so those 13
  call sites had quietly become the trace's only source of content. `../HANDOFF.md`'s newer
  "keep the trace" is what caught it. **A cleanup list written when a feature was added goes
  stale the moment any of that feature is repurposed — re-read the code before executing one.**
- `trace()` was only ever called by `dbg()`, so the wrapper was deleted and `trace` took the
  name `dbg`. All 13 call sites are untouched, which keeps the removal diff purely subtractive.
- Resist adding a trace line "while you are in there". A MATCHED line was written and then
  removed during this pass because `fireClick` already emits `clicked step N of M` — a
  scaffolding-removal commit that also changes trace output is not attributable.

Two lessons from building it are worth keeping, because they outlive it:

- **The frame prefix cannot be inferred from the hostname.** A same-host iframe (which
  `fixture-iframe.html` is) produces "armed … / never matched" lines identical to the top
  frame's. The trace prefixes `⧉` from `isTop` directly, which is why it survived the removal.
- **Teaching from a frame is asynchronous.** A test that calls `startTeaching()` and then
  clicks in the frame synchronously records nothing — the `teach-on` broadcast has not
  landed. Looked exactly like a broken relay; it was the test. Wait a tick.

---

## v0.11.0 — several sequences per host, all armed at once


The requirement, from the user: a site has a gate on its landing page, and *a different*
popup several pages deeper. Teaching the second must not wipe the first, and both need to
work. Two things fall out, and only the first is obvious.

**Teaching APPENDS** (`saveTaught` concatenates onto `seqsOf(prev)`). Deleting is Settings'
job and is per-sequence there — each block has its own Test and ✕, and removing the last
sequence only deletes the host entry if it has no `prefs` either.

**Every sequence arms simultaneously, and the page decides which one runs.** `runs` is a
list of independent run objects — separate `idx`, `deadline`, `verify`, `clicked`,
`restarts` — sharing one interval and one MutationObserver, because those are properties of
the document and N copies would be N× the wake-ups for nothing. `tick()` iterates; `retire()`
drops one run and stops the shared watcher only when the last one goes.

- **Folding a second gate in as extra STEPS cannot work, and this is the thing to understand
  before touching the shape.** A sequence is ordered and blocks: step N+1 is not hunted until
  step N commits. So a deep-page popup appended as "step 3" never fires on the landing page
  (steps 1–2 completed, step 3 isn't there, window closes), and on the deep page it never
  fires either, because steps 1–2 don't resolve so step 3 is never reached. They are not one
  sequence; they are two, and the data model has to say so.
- **No URL matching, deliberately.** A sequence self-selects by whether its step 1 resolves,
  which is information the page hands you for free and which survives the site reorganising
  its paths. A `urlPattern` field would be a second thing to teach, a second thing to get
  wrong, and a second thing to re-teach after a redesign.
- **`NEVER MATCHED` is the normal, expected outcome for all but one sequence on any page.**
  It is not an error and must not be read as one — with 3 sequences taught, a clean visit
  produces 2 of those lines. Trace lines are prefixed `[sequence name]` **only when more than
  one is armed**, so a single-sequence host's trace stays byte-identical to v0.10.0's and old
  comparisons still hold.
- **Counters are per sequence**, located by `id` and not by index, because Settings can
  delete a sequence while a run still holds a reference to it. "Is *this* one still working?"
  is the only question `fires`/`lastFired` answer, and a host-level counter cannot.
- `extendWatch` renews every run that is not `done`, each against its own `watchMs`. A
  completed sequence is skipped so reaching `load` cannot reopen a window on a gate already
  dealt with, while its siblings still waiting on a slow popup get the full extension.
- Known and accepted: two sequences whose step 1 resolves to the **same** element will both
  click it, since `clicked` is per-run. Don't teach that; no guard built.
- `seqName()` unwraps `describe()`'s `button — “Enter site”` label to just the caption,
  because the log quotes it again and `“button — “Enter site”” saved` is unreadable.

---

## v0.12.0 — capture: baseline, classifier, review panel


M3. The preference half now has a capture side: a baseline, a diff, a classifier, and the
review panel — all in the `Preferences:` sections between Toast and "Testing a rule". Replay
does not exist yet, so nothing captured does anything on a later load; that is M4.

**The baseline is one snapshot taken in a `window` capture-phase listener on the first
pointerdown / keydown / click — not the rolling 500ms poll `PREFS.md` specifies.** The
definition is unchanged ("the state of the page at the last moment before you touched
anything"); the polling turned out not to be needed to reach it. Freezing *at* the interaction
is strictly more accurate — the capture path starts at `window`, so it runs before the site's
own handler and the page has not yet reacted — and it costs nothing on a page nobody touches.

- **The reason that actually decided it:** freeze-at-interaction can tell "you never interacted
  with this page" apart from "you interacted and nothing changed". Rolling collapses both into
  an empty diff. The first case is common — a preference set inside a cross-origin frame, whose
  events the top frame never sees — and it now produces an honest refusal (`capture asked for
  with no baseline`) instead of a silent shrug. Verified.
- The rejected `load`+2000ms design stays rejected for the reason PREFS gives: an early scroll
  would freeze it mid-start-up, which is the one thing the baseline exists to prevent.
- **Not gated on the master switch.** Off means nothing *fires*; a snapshot fires nothing, and
  gating it would mean switching Forget Me Not on mid-visit silently left you with no
  before-state.

**A class entry is identified by the class NAME, not by whether this capture added or removed
it.** On one element a class is present or absent, so `+theme-dark` and `−theme-dark` are two
states of one entry. Getting this wrong is not theoretical — it was measured: with the sign in
the identity, flipping the theme and capturing again stored *both* `+theme-dark` and
`−theme-dark`, an instruction set that contradicts itself. Fixed by making a class behave like
an attribute: name is identity, sign is state. Re-verified across a reload — the two class
entries flip in place and the count stays at 5.

**One entry per class, never one entry carrying `add:[…]` and `remove:[…]` arrays.** The
workflow is to trim until it stops working and step back one, and that is impossible if six of
Wikipedia's `clientpref` classes arrive welded into a single tick box. The stored shape still
matches `PREFS.md` — the arrays are just always length 0 or 1.

**A DOM removal is replayable; a storage removal is not.** The document is served identically
on every visit, so an attribute or class the user cleared is back next time and has to be
cleared again — those are real entries. A storage key they deleted was never there to begin
with in a fresh container, so replaying its deletion is a no-op at best and mistimed at worst.
Storage deletions are counted and mentioned in the panel footer rather than offered as entries;
dropping them silently would be worse than either.

**A second capture MERGES, and the two halves of an entry are owned by different people:** the
value is the site's and is always updated, the tick is the user's and is always preserved.
Dropping the new value means changing a preference and re-capturing silently keeps the old one;
dropping the decision means every re-capture re-ticks something deliberately excluded. Same
"must not wipe what came before" rule teaching got in v0.11.0.

**An unticked entry the classifier called id-like is stored WITHOUT its value** (`redacted:
true`, key and reason kept). Keeping a copy of a session id — in the one store the container
cannot reach — is exactly the harm this project exists to prevent, and replay would never have
used it. The rule in one line: *the value is kept when the entry is enabled, or when the
classifier saw nothing id-like about it.* An unticked but ordinary value keeps its value, which
is what makes the trim-and-step-back workflow work. Re-ticking a redacted entry needs a fresh
capture, and the panel says so where the value would be.

- **The classifier matches whole words in a key name, split on punctuation AND camelCase
  humps.** A substring test is unusable: `id` is inside `sidebar`, `hidden`, `width` and
  `provider`, so `body.sidebar-hidden` — a preference this feature exists to keep — would
  arrive unticked. Value rules are checked before name rules, because "looks like a UUID" tells
  the user more than "the key is called clickId".
- Values over `PREF_MAX_VALUE` (4096) are not offered at all, and counted in the footer. That is
  the capture declining to carry a payload, not the classifier blocking a risky value — the
  classifier still never blocks.

**Trap the fixtures caught, worth repeating: a second capture *within one page life* shows
`GM:fmn_rules` / `GM:fmn_log` / `GM:fmn_trace` as storage entries** — the first capture's own
save, which under `../tests/gm-shim.js` lands in the page's localStorage. `GM:fmn_log` is short
enough to arrive **ticked**. This is the shim, not the differ; real GM storage is invisible to
the page. Take the second capture after a reload. The one production concession made for it is
that `freeze()` writes its trace line *before* taking the snapshot rather than after, which
costs nothing in the real script and keeps first captures clean.

**Rejected: reworking `gm-shim.js` to keep GM values in memory and flush at `pagehide`.** It
would remove the artefact above, and it would break something real — GM storage is shared
across frames, which is how a frame's trace lines reach the top document, and an in-memory map
is per frame with last-flush-wins. Do not break a working instrument to tidy an artefact that
appears in one flow and has a one-word workaround ("reload").

---

## v0.13.0 — replay: rungs 1 and 2, re-assertion, and the loss watcher


M4. Replay runs at document-start in **every frame** for that frame's own host — capture is
top-frame only, replay is not. It registers its own load listeners rather than joining
`boot()`, because the seam between the two halves is meant to stay clean.

**Storage entries are written only if the key is ABSENT.** Replay exists to restore what the
container destroyed; a value still sitting there was not destroyed, which means this browser
kept it and the user may have changed it since. Overwriting would stamp an old preference back
over a newer one — the same harm as re-clicking a toggle that stayed on screen. Verified both
ways: `wrote 1, left 0` on a wiped store, `wrote 0, left 1` when the user had changed the value
on the site itself, and the page then came up with *their* value.

**The click runner's own synthetic click was freezing the preference baseline.** On a host with
both a taught gate and preferences, `realClick`'s dispatched pointerdown froze the baseline at
+7ms — document-start in all but name, the exact design the baseline exists to replace — and set
`touched`, switching re-assertion off before the page had finished loading. Fix: the interaction
watcher ignores untrusted events. Real user input is always trusted; another userscript clicking
the page is not the user either. Measured on `fixture-simple.html` with both halves on one host,
before and after.

- **This is the "two halves must not interfere" seam failing quietly**, and it would never have
  shown up on a host with only one half taught. When adding anything to either half, ask what it
  does on a host that has both.

**A timed audit cannot see a loss that happens after it, and `fixture-pref-hostile.html?reset=6000`
proved it.** The first cut checked at load+3s, reported *"all 2 page preferences still hold"*,
and the site took them back at +6s — a trace line claiming success over a page sitting in light
mode, which is the precise failure mode that cost this project three versions on the click side.

So the audit's positive line is scoped to what it can actually see — `hold as re-assertion
finishes` — and everything after it is covered by a **read-only MutationObserver that reports the
first loss and disconnects**. It never re-applies: re-assertion is deliberately bounded, and an
observer that put things back would be an endless fight with the site and with the user.
Measured: `LOST 2 of 2 … the site has put them back` at +6007ms, in the trace and in Recent
activity.

**"It holds" and "it holds because we kept putting it back" are different results and the audit
says which.** A site that overwrites will win as soon as it moves its overwrite past the last
re-assertion, so the summary line carries a re-assert count: `all 2 page preference(s) hold as
re-assertion finishes (2 of them only because they were put back after the site overwrote them)`.

- **This matters because re-assertion can mask a wrong-rung choice.** On `fixture-pref-ls.html`,
  replaying only the class entries *works* — the site wipes the class at parse time and
  re-assertion restores it at DOM ready. The end state is identical to the correct rung-2 choice.
  Only `sawAtParse === null`, the flash, and the re-assert line distinguish them. Do not judge a
  rung by the end state alone.

**A pass that changed nothing writes no trace line.** `PREFS.md` asks for a line per
re-application; a heartbeat on every quiet pass would bury the one that matters under four times
as many that do not. A re-application that changed nothing was not a re-application.

Verified 2026-08-17: rung 1 (`data-theme` at document-start +3ms, `body` class deferred to DOM
ready, storage untouched); rung 2 (`sawAtParse: "dark"` — the site read our value before any of
its own script ran); the `ss` banner; re-assertion under attack; the loss watcher; the `touched`
gate silencing the watcher after the user's own change; per-frame replay with the `⧉` prefix;
master switch off killing both halves; both halves on one host; and the click half unchanged.

**Not verified live: re-assertion's own `touched` gate**, as distinct from the watcher's. It
needs a trusted interaction inside the first second of a page load and the test tooling cannot
deliver one that fast. Inspected, not measured — say so rather than implying otherwise.

---

## v0.14.0 — Wikipedia, and the measurement that was wrong


M5. Measured against `en.wikipedia.org/wiki/Cat`, anonymous, and then run end to end against
Wikipedia's own served markup and its own JavaScript.

**What Wikipedia actually does when you change the theme**, measured through
`mw.user.clientPrefs.set` (the same call the Appearance radios make):

| | |
|---|---|
| `:root` classes | `+skin-theme-clientpref-night`, `−skin-theme-clientpref-day` (and the same shape for `toc-pinned`, `limited-width`) |
| localStorage | **unchanged** — only `MediaWikiModuleStore:enwiki`, identical before and after |
| sessionStorage | empty throughout |
| what it persists | one cookie: `enwikimwclientpreferences=skin-theme-clientpref-night,…` |
| `body` background | `rgb(248,249,250)` → `rgb(32,33,34)` |

So rung 1 is the whole answer here, rung 2 is not needed, and the only thing the site keeps is
the cookie the user's container destroys — which is the entire reason this project exists.
Capture offered **exactly two entries, both pre-ticked**, and nothing else.

### The wrong measurement, and why it was wrong

Comparing the served `<html class>` (fetched raw) against the settled one showed a single
difference: `client-nojs` → `client-js`. From that I concluded MediaWiki does not rewrite the
root class list. **That conclusion was wrong, and the method could never have found it out.**

What MediaWiki actually does is **assign the whole `className` string** — from a value it
captured earlier — so it restores `skin-theme-clientpref-day` and drops whatever else was put
there. A set difference between "before" and "after" cannot see a wholesale rewrite that
restores the same values; it is invisible by construction. Only a MutationObserver sees it, and
that is exactly what `../tests/pref-probe.js` is for.

> **A before/after comparison cannot detect a change that was undone.** Whenever the question is
> "does this site fight us?", the instrument has to be an observer, not a diff.

This is the same shape as the v0.6.0 mistake — reading a snapshot as though it described what
happened in between — and it survived a whole round of confident reporting before the timeline
caught it.

### What it cost, and the fix

Timeline on the first end-to-end run: we write the theme class at **+1ms**, MediaWiki reassigns
`className` at **+2ms** (light again), and the DOMContentLoaded pass repairs it at **+54ms**.
Fifty-two milliseconds in the theme the user rejected — and on a real network load
DOMContentLoaded is far later than 54ms, so first paint can easily land inside that gap. M5's
acceptance criterion is *"dark theme from first paint"*, and the scheduled passes alone do not
meet it.

`watchEarlyDrift` repairs drift **on the mutation that causes it** rather than on a timer, hands
over to the scheduled passes at DOMContentLoaded, and is bounded by `EARLY_FIXES` (5) so a site
that rewrites on every change cannot ping-pong. Re-measured: repaired in the same millisecond,
**`longestWrongThemeMs: 0`**.

- **It repairs; `watchForLosses` only reports.** The difference is deliberate and is the whole
  boundary of this feature: before the user has touched anything, putting a preference back is
  what we are for. After re-assertion has finished, only reporting is — a repairing observer
  there would be an endless fight with the site, and with the user.
- The audit's "only because" clause earned its keep on its first real site: Wikipedia reports
  `all 2 page preference(s) hold as re-assertion finishes (2 of them only because they were put
  back after the site overwrote them)`. Without that clause the trace would read as though
  document-start replay had been sufficient, which is false.

### Also confirmed on the real site

- **The Appearance radios are not in the served HTML and never appeared in a hidden tab** —
  `skins.vector.clientPreferences` sat in state `executing` indefinitely. This is the same
  late-binding module that beat the click runner's retry ladder in v0.5.0, and it is the
  concrete argument for prefs over clicks here: **rung 1 does not care whether the control ever
  appears.**
- `MediaWikiModuleStore:enwiki` is ~447 KB. If it changes after the baseline freezes it is
  dropped by the `PREF_MAX_VALUE` cap and counted in the panel footer — the size cap validated
  on a real site the first time out.

### How this was run, and what it does not prove

The Browser pane cannot install a userscript, so `en.wikipedia.org` was measured live, and the
end-to-end run used Wikipedia's own downloaded markup served from `localhost:8731` with a
`<base href="https://en.wikipedia.org/">` and our scripts injected at the top of `<head>` — so
MediaWiki's real modules, CSS and start-up code all ran, against a real document-start replay.
The snapshot was recycled afterwards; it is not in the repo.

**What that does not prove:** real network timing (first paint against a cold cache), and the
user's actual container extension. Those need the script installed in their browser — see
`../HANDOFF.md` for the short checklist.

---

## The rename: GateSkip → Forget Me Not (v0.8.0)

Local rename is complete and committed as v0.8.0. What actually happened:

- Steps 1–4 done. The folder move was done by moving `GateSkip`'s **contents** (including
  `.git`) into the already-existing `Forget-Me-Not` folder, not by renaming the directory —
  the new folder already held a copy of this file and was a live session's cwd. History is
  intact; `git log` still reaches v0.2.0.
- **Step 5 done.** Verified 2026-08-17: `origin` is `VitaKaninen/Forget-Me-Not.git`, `main`
  is pushed and in sync, and the `@updateURL` raw URL returns 200.
- **Step 7 done** for the repo — `VitaKaninen/GateSkip` no longer resolves. The gist is
  unverified from here.
- **Step 6 is unverified from here** — whether the old GateSkip script is uninstalled from
  Violentmonkey can only be checked in the browser. Both `@match *://*/*`; two copies
  running at once is the "two userscripts fighting over the same click" hazard in
  `../../CLAUDE.md`.
- One judgement call beyond the written plan: `TAG = '__gateskip__'` → `'__forgetmenot__'`.
  It is the cross-frame postMessage discriminator, ephemeral and never persisted, so it is
  not in the same class as the `gs_*` keys below. The one way it can bite is an old and a
  new copy installed simultaneously in different frames of the same page — which step 6
  exists to prevent.

The original plan follows, kept for the record.

The project is being renamed **GateSkip → Forget Me Not**. Do it before writing anything new,
because the old name is baked into paths, headers and URLs, and fixing that afterwards is the
"moving causes problems later" the user explicitly wants to avoid.

Conventions confirmed from the sibling scripts in `Monkey Scripts`:

| | Value |
|---|---|
| Folder | `Forget-Me-Not` (hyphenated — GateSkip was the outlier) |
| Script file | `Forget-Me-Not.user.js` |
| `@name` | `Forget Me Not` (spaced) |
| `@updateURL` / `@downloadURL` | `https://raw.githubusercontent.com/VitaKaninen/Forget-Me-Not/main/Forget-Me-Not.user.js` |

`Monkey Scripts` is **not** itself a git repo — each script is its own repo. Keep the local
git history; do not start a fresh one. The commit trail v0.2.0 → v0.7.0 documents four rounds
of misdiagnosis and is the second most valuable thing here after `../CLAUDE.md`.

Order:

1. Rename the directory `Monkey Scripts\GateSkip` → `Monkey Scripts\Forget-Me-Not`. `.git`
   travels with it, history intact.
2. `git mv GateSkip.user.js Forget-Me-Not.user.js`.
3. Header: `@name`, `@description`, `@updateURL`, `@downloadURL`, and the explanatory comment
   under the header block that names the old repo. Bump `@version` and `VERSION`.
4. The four `GM_registerMenuCommand` labels (`GateSkip: …`), and the repo URL in `README.md`
   (~line 128).
5. Create the GitHub repo `Forget-Me-Not`, `git remote set-url origin …`, push, and confirm the
   raw URL actually resolves.
6. **Remove the old script from Violentmonkey BEFORE installing the new one.** Both `@match
   *://*/*`; two copies running at once would both fire clicks on every page — literally the
   "two userscripts fighting over the same click" hazard documented in `../../CLAUDE.md`.
7. Deleting the old `GateSkip` GitHub repo and the gist is **the user's to do**, and only after
   the new install is confirmed working. Do not do it for them.

Deliberately NOT part of the rename: the `gs_*` GM storage keys, the `#gs-popup` / `#gs-hud`
DOM ids, and `__gsMenu` in `../tests/gm-shim.js`. Renaming storage keys orphans the user's taught
rules, so fold that into the M1 migration below — one migration pass, and the rename stays
behaviour-neutral so any regression is attributable.

Nothing to migrate in `~/.claude/projects/…-GateSkip/memory/` — it is empty. `.claude/launch.json`
is path-independent (serves the cwd), so it needs no edit.


---

## Milestone log (M0–M5)

The build was deliberately split so that a regression would have exactly one candidate
cause. That is the only reason milestones exist here — storage compatibility never was one,
see `../CLAUDE.md` on rule loss.

**M0 — Delete debug mode. ✅ DONE 2026-08-17, v0.9.0.** 209 lines removed; all five fixtures
re-verified afterwards (see below). The trace and the `performClick` split were kept. Write-up
above under [v0.9.0](#v090--debug-mode-is-gone), including the trap that the "Cleanup owed" list it was executed from had gone
stale and, followed literally, would have deleted the trace's only source of content.

**M1 — Schema v2, new key names, NO migration. ✅ DONE 2026-08-17.** Shipped as two commits so
a regression would have one candidate cause: **v0.10.0** reshaped storage while the runner
still used `clicks[0]` (inert — all five fixtures unchanged), **v0.11.0** made the runner arm
every sequence and teaching append.

`fmn_rules` holds `{v:2, host, subdomains, enabled, clicks:[Seq], prefs:{…}}`. **`clicks` is an
array**, not the single object originally drafted in `PREFS.md` — the user needs a second,
unrelated popup taught several pages into a site without wiping the landing page's gate, and
extra *steps* cannot express that (a sequence blocks on step N before hunting N+1, so the deep
popup would fire on neither page). Each sequence arms independently and self-selects by whether
its step 1 resolves; there is no URL matching. Full reasoning above under
[v0.11.0](#v0110--several-sequences-per-host-all-armed-at-once).

Verified: two sequences running in parallel on one page with independent retry ladders; a
sequence whose control is absent reporting `NEVER MATCHED` and retiring without interfering;
teaching a third appending while the first two keep their counters; cross-frame; and the
`<path>` → `<div.x>` candidate walk. The `gs_*` keys are deleted once on first run.

**There is deliberately no v1→v2 migration, and no back-compat read path.** An earlier draft of
this plan (and of `PREFS.md`) said to keep one "for a long time; rules are hand-taught and
expensive to lose". The user settled it 2026-08-17: *"there is no need to keep any of it. It
takes about 5 seconds to recreate it."* Re-teaching is cheaper than carrying a compatibility
path forever, so the shape is written clean. This also retires the gate that used to sit here —
"ship it and confirm the user's taught rules survive a browser restart" — because there is
nothing left to survive.

Not renamed, on purpose: the DOM ids `gs-popup` / `gs-settings` / `gs-hud` and `__gsMenu` in
`../tests/gm-shim.js`. They are internal, nothing persists them, and churning them adds diff noise
to exactly the milestones where a regression has to stay attributable.

**M2 — Write the four fixtures before the feature exists. ✅ DONE 2026-08-17.**
`fixture-pref-ls.html`, `-dom`, `-hostile`, `-noise`, plus the shared instrument
`../tests/pref-probe.js`. No userscript change, so no version bump. Each page states its own pass
criteria in prose, and all four were driven in a real browser against the behaviour they claim —
see the "preference fixtures" section of `TESTING.md` for the measured numbers and the two
traps that are specific to this set.

The ordering was deliberate: four versions of this project were burned on never having stated
precisely what "working" means, and a fixture is the cheapest way to state it. (`PREFS.md`'s
own "Build order" used to list them at step 4, after capture and replay — a direct contradiction
of this milestone, in the same package. Fixtures-first won; PREFS is corrected.)

Two things worth carrying into M3/M4:

- **A fixture that only *demonstrates* a rung is not worth writing.** `fixture-pref-ls.html`
  overwrites the root class from storage on every load specifically so that a class-only replay
  visibly fails there, and `sawAtParse` reports what the site read *before* anything could
  re-assert. A fixture where both rungs pass would have told us nothing about which one worked —
  which is the open question PREFS parks under "rung 1 vs rung 2 sufficiency".
- **`gm-shim.js` backs GM storage with page `localStorage`, which is exactly what a pref capture
  snapshots.** The probe filters `GM:*` from its own views; capture code will not. Do not teach a
  click rule on a pref fixture — an armed runner writes trace lines for the life of the page, and
  those land after the baseline freezes. With no rule stored, GM writes stop at document-start
  and the diff is clean. Verified rather than assumed.

**M3 — Baseline + "Remember this site" capture + review UI. ✅ DONE 2026-08-17, v0.12.0.**
Menu command `Forget Me Not: remember this site` (also a button in Settings), the review panel,
and a `Prefs` button per host card that re-opens the same panel. Nothing captured *does*
anything yet — replay is M4 — so a regression from this can only be in the UI or the differ.

Measured on the fixtures: `fixture-pref-dom.html` yields 2 entries and no storage rows;
`fixture-pref-noise.html` yields exactly the 5 its table now names, with the start-up churn
excluded and the two site-caused rows unticked with reasons; `fixture-pref-ls.html` adds the
`ss` row; capture with no interaction refuses honestly; re-capture across a reload flips the
class entries in place instead of accumulating; unticked id-like values are stored redacted;
Settings' `Prefs` button re-opens the panel with `Captured …` and the redaction note. The click
half was re-checked on `fixture-simple.html` (dismissed, one `armed for` line).

Three design points that came out of building it are above under
[v0.12.0](#v0120--capture-baseline-classifier-review-panel) — the baseline is a single frozen snapshot rather than PREFS's rolling
poll (and `PREFS.md` is corrected), a class entry's identity is the class name rather than
the ± sign, and an unticked id-like entry is stored without its value. The second was found by
the fixture, not by reasoning: with the sign in the identity, flipping a preference and
capturing again stored both "add it" and "remove it".

**M4 — Replay at document-start + re-assertion + trace lines. ✅ DONE 2026-08-17, v0.13.0.**
Both rungs work. The two items left over from M3 are done: `arm()` now says `no taught clicks for
<host> — N preference(s) are replayed here instead`, and the prefs-only rule is handled
throughout.

Write-up above under [v0.13.0](#v0130--replay-rungs-1-and-2-re-assertion-and-the-loss-watcher). The
three things worth knowing before touching it:

- **The click runner's own synthetic click was freezing the preference baseline** on a host with
  both halves taught — +7ms, which is document-start in all but name, and re-assertion switched
  off before the page finished loading. The interaction watcher now ignores untrusted events.
  This is the "two halves must not interfere" seam failing quietly, and it could only ever show
  up on a host that has both.
- **A fixed-time audit was worse than nothing** and `fixture-pref-hostile.html?reset=6000` caught
  it: it reported "all preferences still hold" three seconds before the site took them back. The
  positive line is now scoped to `hold as re-assertion finishes`, and a read-only observer
  reports the first loss afterwards.
- **Re-assertion can mask a wrong-rung choice.** On `fixture-pref-ls.html` a class-only replay
  ends up looking identical to the correct rung-2 choice, because re-assertion restores what the
  site wiped. Never judge a rung by the end state — read `sawAtParse` and the re-assert count.

Not verified live, and stated as such in `../CLAUDE.md`: **re-assertion's own `touched` gate**, as
distinct from the watcher's. It needs a trusted interaction inside the first second of a page
load, which the test tooling cannot deliver. Inspected only.

**M5 — Wikipedia, anonymous. ✅ DONE 2026-08-17, v0.14.0.** Measured live on
`en.wikipedia.org/wiki/Cat`, then run end to end against Wikipedia's own served markup with its
own modules and CSS loading. Capture offered **exactly two entries, both pre-ticked**
(`+skin-theme-clientpref-night`, `−skin-theme-clientpref-day`); replay produced
`bg: rgb(32,33,34)` with **no cookie written by us and localStorage untouched**. Full write-up
above under [v0.14.0](#v0140--wikipedia-and-the-measurement-that-was-wrong).

One finding worth carrying everywhere, because the method failed before the code did:

> **A before/after comparison cannot detect a change that was undone.** Comparing Wikipedia's
> served `<html class>` against its settled one showed one difference (`client-nojs` →
> `client-js`) and I reported that MediaWiki does not rewrite the root class list. It does — it
> assigns the whole `className` from a string captured earlier, restoring the light theme a
> millisecond after our write. A set difference cannot see that, by construction. Whenever the
> question is "does this site fight us?", the instrument has to be an observer.

That cost 52ms in the rejected theme, which on a real network load is enough for first paint —
so `watchEarlyDrift` now repairs drift on the mutation that causes it, bounded by `EARLY_FIXES`
and handing over at DOMContentLoaded. Re-measured `longestWrongThemeMs: 0`.

**What is left, and only you can do it.** The Browser pane cannot install a userscript, so the
end-to-end run used Wikipedia's markup served from localhost. Real network timing and the
container extension are untested. In your own browser:

1. Confirm the old **GateSkip** script is uninstalled from Violentmonkey — still outstanding from
   the rename, and two copies both matching `*://*/*` is the click-collision hazard in
   `../../CLAUDE.md`.
2. Install/update to v0.14.0, open `en.wikipedia.org` in a fresh container, set the theme to dark
   in the Appearance panel, and pick **Forget Me Not: remember this site**. Expect two entries,
   both ticked.
3. Open Wikipedia in *another* fresh container. It should come up dark with no flash.
4. If there is a flash, **Save trace** and look for `re-asserted at start-up` — that line and its
   `+NNNNms` say whether early repair fired and how late. If it says `re-asserted at DOM ready`
   instead, `watchEarlyDrift` did not catch it and the fix is there, not in the timings.

**M5 — Wikipedia, anonymous, in a fresh container.** Sidebar closed and dark theme from first
paint, with nothing transmitted.


---

## Privacy reasoning — the long form

Condensed into `../CLAUDE.md` under "Why the project exists". Kept here in full because
both of these arguments were made, tested and *withdrawn*, and the withdrawal is the
valuable part — the short version states the conclusion without showing why the intuitive
answer was wrong.

### Dropping rung 3 does NOT remove the need for value review

The transport was never what mattered; the value was. A UUID replayed into localStorage,
read by the site's own script and posted home, re-establishes tracking exactly as well as a
cookie would.

> **The medium decides the blast radius. The value decides whether there is anything to leak.**

### Measure the privacy cost against the right counterfactual

An earlier version of this note argued that a fresh container arriving with preferences is
distinctive, since most cookieless visitors have none. **That is the wrong baseline and the
argument is withdrawn.** The counterfactual is not "a visitor with no preferences" — it is
*the user, having clicked*. They were going to close the panel anyway, in every fresh
container, and the site sees the identical class either way. Replay removes labour, not
anonymity. There is no linkage delta.

What genuinely differs is the **manner of arrival**, not the state: replayed preferences are
present at document-start with no input events in front of them, where a click arrives
seconds in behind real pointer events. A site that looked could tell those apart — but that
reveals "this browser runs something that sets preferences", a static category bit, not an
identifier, creating no cross-visit linkage, and userscript managers are detectable a dozen
easier ways regardless. Not worth designing around. Do not let it shape the design again.

**The line that does matter — and the one the review step exists for:**

| | Was it going to happen anyway? | Replaying it |
|---|---|---|
| **User-caused** state — the preferences they set | Yes, they would click them | Adds nothing |
| **Site-caused** state — session ids, analytics keys, consent blobs with an id inside | **No.** The container would have destroyed it | Adds tracking that would not otherwise exist |

A snapshot diff contains **both rows mixed together**, because the site wrote its own keys
during the same visit the user set their preferences. Separating them is the review's whole
job, so the question it must ask the user is **"which of these did you mean to set?"** — not
"which of these look risky?". The first is answerable at a glance; the second is not.

Still keep the entry list minimal — **replay the smallest set of values that works** — but on
robustness grounds, not privacy ones: fewer entries mean less to break at the site's next
redesign, less to debug, and less chance of carrying something whose contents nobody checked.

Full design: [`PREFS.md`](PREFS.md).

So rungs 1 and 2 keep the classifier: capture is **snapshot-and-review**, never automatic —
the user sets a site up how they like it, hits "Remember this site", and gets a list where
short enumerable values arrive pre-ticked and UUIDs / long tokens / base64 blobs / timestamps
arrive unticked with a warning. Automatic capture is rejected outright: it would silently
persist and replay the identifiers the container is there to destroy.

