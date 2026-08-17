# Forget Me Not — project notes

Violentmonkey userscript. Teach-by-clicking dismissal of age gates / cookie walls, opt-in
per site. The shared rules in `../CLAUDE.md` (version bumps, commit + push after every
finished edit, no `innerHTML` in injected UI, the two-userscripts-fighting-over-a-click
note) apply here too.

## Shape of the thing

Single file, `Forget-Me-Not.user.js`, one IIFE, `@run-at document-start`, runs in **every
frame** (no `@noframes`). Sections in order: storage → utilities → selector building →
selector resolution → runner → SPA watcher → highlight layer → cross-frame messaging →
teaching → popup → toast → testing → settings → boot.

Storage is GM: `fmn_rules` (host → rule), `fmn_on`, `fmn_watch`, `fmn_log`, `fmn_trace`.
In-progress teaching lives in **sessionStorage** (`fmn_teach`), top frame only. The `gs_*`
keys are v1 and are deleted once, on first run, by `dropDeadKeys()` — they are never read.

**Schema v2 (v0.10.0).** A host entry is
`{ v:2, host, subdomains, enabled, clicks: [Seq], prefs: {captured, entries} }`, where
`Seq` is `{ id, label, steps:[Step], watchMs, fires, lastFired, created }`.

**`clicks` is an ARRAY, and that is the whole point of v2.** One host routinely needs more
than one unrelated dismissal — an age gate on the landing page, and some other popup that
only shows up three pages deep. Those are *not* steps of one sequence: a sequence runs in
order and stops when a step stops resolving, so folding the deep popup in as "step 3" means
it never fires on the landing page, and the landing gate blocks it everywhere else. Each
sequence arms independently and hunts for its own first step, so **the page's own content
selects which sequence runs** — no URL matching is involved, deliberately, because then
nothing breaks when the site reorganises its paths. Counters (`fires`/`lastFired`) live on
the sequence, since "is this one still working?" is the only question they answer.

**There is no migration from v1 and no compatibility read path anywhere**, including the
Settings importer, which rejects a v1 export rather than converting it. See HANDOFF.md —
rule loss is explicitly not a cost on this project and must not appear in a design argument.

## Several sequences per host, all armed at once (v0.11.0, 2026-08-17)

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

## Why the project exists (settled 2026-08-17 — read before designing anything)

The user browses with a container extension that gives every tab a fresh container and
destroys it, with all cookies, on close. Nothing is logged in. That buys anonymity, and it
costs every site preference: sidebar closed, dark theme, wide layout — all forgotten on
every visit, because the only place a site knows to keep them is storage that just got
deleted.

**Forget Me Not's job is to hold those preferences itself and reapply them, without the site
learning anything.** Dismissing gates is one case of that, not the point of it. The click
runner is the *fallback*, for state that has no stored representation.

### The replay ladder — take the highest rung that works

1. **Effect** — write the DOM state directly (a class on `<html>`, a `data-theme` attribute).
   Nothing is *transmitted*. Covers most theme / layout / panel preferences, because those
   are nearly always "a class near the top of the document, and CSS does the rest".
   Not the same as unobservable — the page's JS can read a class we set exactly as easily as
   one it set itself — but see the counterfactual section below before treating that as a
   cost: the user was going to set that class by hand anyway.
2. **Local storage** — write the key/value the site would have written, at document-start,
   for its own script to read.
3. ~~**Cookie**~~ — **deliberately does not exist. Do not add it.** See below.
4. **Click** — today's runner. For state with no persisted representation at all.

### Rung 3 is out, and the reasoning is not "cookies are icky"

- **It would not work here anyway.** Cookies are blocked at the browser level for these
  sites, so `document.cookie = '…'` silently no-ops and reads back empty — a feature that
  fails indistinguishably from "the site ignored our value", on the only machine it runs on.
- **Ephemerality would not save us — but only for blob replay.** Container deletion protects
  you only while nothing re-creates the value, and replay re-creates it every visit out of GM
  storage the container cannot reach. That is a supercookie *if the value carries an
  identifier*. It is **not** one for a low-entropy flag like `-clientpref-0`, which millions
  of readers share and which distinguishes nobody — an earlier version of this note argued
  otherwise and was wrong. The hazard is wholesale replay of a captured blob whose contents
  you have not looked at, which is precisely why capture is snapshot-and-review.
- **An invariant beats a heuristic.** "Forget Me Not never writes a cookie; nothing it does is
  transmitted to the host" is one sentence, checkable by grepping for `document.cookie`.
  The alternative — "we transmit only what our entropy classifier judged safe" — is a thing
  you must keep trusting on every future site forever. The project exists to avoid trusting
  things.

Known cost, accepted: **server-rendered preferences are permanently out of scope.** The
white-flash-then-dark-theme case can only be fixed after the flash, and a server-enforced
age gate falls to rung 4. Also note a userscript cannot touch outgoing request headers at
all — if that ever becomes necessary it is an extension-shaped problem, so keep the seam clean.

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

Full design: [`docs/PREFS.md`](docs/PREFS.md).

So rungs 1 and 2 keep the classifier: capture is **snapshot-and-review**, never automatic —
the user sets a site up how they like it, hits "Remember this site", and gets a list where
short enumerable values arrive pre-ticked and UUIDs / long tokens / base64 blobs / timestamps
arrive unticked with a warning. Automatic capture is rejected outright: it would silently
persist and replay the identifiers the container is there to destroy.

## Decisions that are not obvious from the code

**Rules are keyed on the hostname of the document the gate is in — not the top page's.**
A frame cannot read a cross-origin parent's hostname, and keying on the frame's own host
means a vendor's player widget is taught once and fixed everywhere it is embedded. The
cost is that you cannot scope a rule to "this widget, only on this site".

**Teaching does not intercept clicks.** Forum-Stumbler's teach mode is modal and
`preventDefault`s everything; that is wrong here, because a gate's confirm button is
usually disabled until the checkbox is genuinely ticked, so a blocked first click makes
the second one unrecordable. Letting clicks through means the page may navigate mid-teach,
which is why the recorded steps sit in sessionStorage and the popup is restored on load.

**Matching requires selector AND text.** Chosen over the more forgiving alternatives on
purpose: the desired failure mode after a redesign is "stops working" rather than "clicks
whatever now sits there".

## Gotchas found while building it (2026-08-16)

- **`arm()` must be idempotent per URL.** It is called at document-start (so a
  server-rendered gate can be gone before first paint) and again from `boot()` at
  DOMContentLoaded. Without the `armedUrl` guard those are two independent watch windows,
  and a gate that is torn down and re-shown during load gets clicked by both — measured
  as `fires: 2` for one page load on `tests/fixture-simple.html`.

- **"Did the gate come back?" cannot be answered by node identity.** The first attempt at
  the re-render retry tested whether step 1 now resolved to a DOM node we had not clicked.
  That misses the very common case of a site detaching and re-attaching the *same* node
  (which `fixture-simple.html` does) — the retry never fired and the overlay stayed up
  while the log claimed success. The reliable signal is that step 1 stopped resolving and
  then started again. Both tests are kept, ORed.

- **A click can land on markup the page has not wired up yet.** Server-rendered gate +
  later hydration means the button exists, is visible, and does nothing. This is why the
  runner does not disarm on completion.

- **Never re-click a gate that stayed on screen.** On a checkbox step the second click
  unticks what the first ticked. Only "vanished then returned" earns a retry.

- **A checkbox's `value` is the string `"on"`.** Reading it as the element's caption
  records `text: "on"` for every checkbox — a fingerprint that says nothing and narrows
  everything. `value` is only used for `input[type=submit|button|reset]`.

- **`el.click()` is what does the work**, not `dispatchEvent(new MouseEvent('click'))`:
  only the former toggles a checkbox, forwards a `<label>` to its input, and submits a
  form. The pointer/mouse events dispatched in front of it are for frameworks that act on
  `mousedown` and never listen for `click`. Everything needs `composed: true` or the event
  never leaves a shadow root.

- **`composedPath()`, not `e.target`,** to find what was clicked: inside a shadow root
  `e.target` is retargeted to the host, so the real element is invisible without it.

- **Test-result messages must only report positives.** Every frame that lacks the element
  would otherwise answer "not found", and the first of those wins the race against the one
  frame that has it. Absence of a positive within 800ms is the negative.

## A click is not an outcome (v0.3.0, 2026-08-16)

The bug that forced this: **"clicked it" and "clicked it and something happened" were the
same thing here, and they are not.** Markup is routinely served with its handler attached
seconds later — the control is present, visible and completely inert in the meantime — and
every click into that dead window was counted as a dismissal. The log said *"dismissed the
gate (2 clicks)"* over a gate that was still on screen. Reproduced and pinned down with
`tests/fixture-late.html` (wires its handlers at 2000ms); v0.2.0 fails it exactly that way.

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

## The success test was reading the page's start-up as success (v0.6.0, 2026-08-17)

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
- Reproduce with `tests/fixture-late.html?wire=8000&churn=1`. v0.5.0 fails it while logging
  "dismissed the gate (2 clicks)" with the gate still up.

## The last over-generous signal was the element's own size (v0.7.0, 2026-08-17)

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

- **Reproduce with `tests/fixture-late.html?wire=8000&grow=1`.** v0.6.0 fails it at +615ms with
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

## The trace: the broken case is the one with no observer in it

`dbg()` writes to `fmn_trace` (GM, capped at `TRACE_MAX`) **whether or not debug is on**, and
Settings has **Save trace** (Blob download) / **Clear trace**. This exists because of the
structural problem that made this bug take four attempts: turning debug on to find out why
something fails changes the timing enough to make it succeed, so the failing case was never
the one being watched. Each line carries `+NNNNms` since that document started, because "how
long after the page began" is the number that has mattered every single time. Frames write
straight to GM storage (shared across frames), so no messaging is involved.

## The retry ladder has to outlast the page's start-up (v0.5.0, 2026-08-17)

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

Test it with `tests/fixture-late.html?wire=8000`; v0.4.0 fails it, logging that it clicked
step 1 four times with the gate still up.

## The watch window is measured from the wrong end (v0.4.0, 2026-08-17)

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

### Fixture-writing traps (bit me twice in one session)

Attaching a listener with `document.getElementById(...)` **after** detaching the element's
container returns `null` — the element is no longer in the document. Wire listeners first,
or query inside the detached subtree. Same applies to `shadowRoot.getElementById`. Both
fixtures had this and it looked exactly like a Forget Me Not bug (recorded the click, gate did
not close).

## Testing

`tests/gm-shim.js` backs `GM_*` with `localStorage` (persistent, shared across frames —
matches real GM semantics; sessionStorage would lose rules on reload, which is what the
tests check) and parks menu commands on `window.__gsMenu`.

`.claude/launch.json` serves the folder on port 8731 via `python -m http.server`.

Fixtures: `fixture-simple.html` (plain gate, injected after load, gate markup also in the
served HTML), `fixture-shadow.html` (two-step gate behind an open shadow root, confirm
button disabled until the box is ticked), `fixture-iframe.html` + `gate-inner.html` (gate
only inside an embedded frame), `fixture-late.html` (both controls in the served HTML but
inert until 2000ms, plus a panel toggle that stays visible and only flips a class on its
**grandparent**), `fixture-icon.html` (gate arrives at 12s, past the old watch window, and its
close control is a `<div>` with a listener and no role, whose only clickable-looking hint is an
inherited `cursor: pointer` — the exact shape that beat v0.3.0). Most expose
`window.__verdict()` returning the pass/fail state (`fixture-shadow.html` does not; read the
trace instead).

`fixture-late.html` takes three knobs, and they reproduce three different false positives:
`?wire=<ms>` (how late the handlers bind — beat v0.4.0), `?churn=1` (a stream of class changes
on `<html>` plus ancestor boxes settling — beat v0.5.0), `?grow=<ms>` (the taught control's own
box changes size once, early, for a reason unrelated to the click — beat v0.6.0). They compose.

**Driving a fixture does not require the teach flow.** Writing `GM:fmn_rules` straight into
`localStorage` is quicker and makes the test say what it is testing. A step is just
`{path:[{s,l}], text, tag, label}`, `text` is the lowercased visible text (`''` skips the text
filter), and one `path` entry per shadow root crossed. Then `location.reload()` and read
`GM:fmn_trace`. Remember the v2 wrapper — steps go inside a **sequence**, inside `clicks`:

```js
localStorage.setItem("GM:fmn_rules", JSON.stringify({
  localhost: { v: 2, host: "localhost", subdomains: false, enabled: true, prefs: null,
    clicks: [{ id: "s1", label: "", created: Date.now(), watchMs: 0, fires: 0, lastFired: 0,
      steps: [{ path: [{ s: "#enter", l: "#enter" }], text: "yes, i am over 18",
                tag: "button", label: "Yes, I am over 18" }] }] }
}));
```

`label: ""` is fine — `seqName()` falls back to the first step that has a `text`, so the log
line reads `dismissed “Yes, I am over 18”`. It prefers a step *with* a caption on purpose: a
gate's step 1 is very often a checkbox, whose label is the useless `input (no text)`.

**All fixtures share one host (`localhost`) and rules are keyed by host, so there is exactly
one rule slot for all of them.** Teaching a second fixture silently overwrites the first, and
worse, a stale rule from another fixture *fires* on the next one — `fixture-late.html` and
`fixture-simple.html` both have a "Yes, I am over 18" button, so the stale rule dismissed the
gate before the teach flow could record it, which reads as a broken recorder. `localStorage.clear()`
**and reload** between fixtures; clearing without reloading is too late, the rule already armed.

Driving them from the browser console / a CDP `evaluate` is enough — teach via
`__gsMenu["Forget Me Not: teach this page"]()`, click the gate, then click **Save** inside
`document.getElementById('gs-popup').shadowRoot`, then reload and read `GM:fmn_log`.

**`fixture-simple.html` legitimately logs a RESTART about half the time, and it is not a bug.**
It detaches its gate at parse time and re-attaches it at 400ms, so whether you get one
dismissal or "dismissed → the page replaced the gate → dismissed" depends purely on when the
first click lands relative to that — and the Browser pane throttles timers in a hidden tab,
which moves it. Before calling it a regression, count the `armed for` lines in the trace: **one
means the restart path fired correctly; two would mean the double-arm bug** (`armedUrl` guard),
which is a real bug this project has had. The end state (`gateGone`) is the thing to assert on.

## Debug mode is gone (v0.9.0, 2026-08-17) — do not bring it back

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
  call sites had quietly become the trace's only source of content. `HANDOFF.md`'s newer
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

## Testing traps that cost time in the v0.9.0 pass

- **The teach-time highlight is bound to `mouseover`, not to clicks** (`onRecMove`). A probe
  that fires a synthetic `el.click()` records the step correctly but never creates `#gs-hl` at
  all — which reads exactly like "the highlight layer is broken". To exercise `hlPaint`,
  dispatch a real `mouseover` with `composed: true` (needed to escape a shadow root).
- **Do not assert on the popup's rendered text to check what was recorded.** A checkbox's step
  is labelled `input (no text)`, not its caption, so a regex for the visible label reports a
  false failure. Read `sessionStorage.fmn_teach` — it is the actual recorded state.
- The runner dismisses the gate on load, so a fixture opened with a rule already stored has no
  gate left to teach against. Clear storage **and reload** before any teach-flow test.
