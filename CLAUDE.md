# GateSkip — project notes

Violentmonkey userscript. Teach-by-clicking dismissal of age gates / cookie walls, opt-in
per site. The shared rules in `../CLAUDE.md` (version bumps, commit + push after every
finished edit, no `innerHTML` in injected UI, the two-userscripts-fighting-over-a-click
note) apply here too.

## Shape of the thing

Single file, `GateSkip.user.js`, one IIFE, `@run-at document-start`, runs in **every
frame** (no `@noframes`). Sections in order: storage → utilities → selector building →
selector resolution → runner → SPA watcher → highlight layer → cross-frame messaging →
teaching → popup → toast → testing → settings → boot.

Storage is GM: `gs_rules` (host → rule), `gs_on`, `gs_watch`, `gs_log`. In-progress
teaching lives in **sessionStorage** (`gs_teach`), top frame only.

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
  collapsing is often the only consequence there is. First cut compared the element and its
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

## The trace: the broken case is the one with no observer in it

`dbg()` writes to `gs_trace` (GM, capped at `TRACE_MAX`) **whether or not debug is on**, and
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
fixtures had this and it looked exactly like a GateSkip bug (recorded the click, gate did
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
inherited `cursor: pointer` — the exact shape that beat v0.3.0). Both expose
`window.__verdict()` returning the pass/fail state.

**All fixtures share one host (`localhost`) and rules are keyed by host, so there is exactly
one rule slot for all of them.** Teaching a second fixture silently overwrites the first, and
worse, a stale rule from another fixture *fires* on the next one — `fixture-late.html` and
`fixture-simple.html` both have a "Yes, I am over 18" button, so the stale rule dismissed the
gate before the teach flow could record it, which reads as a broken recorder. `localStorage.clear()`
**and reload** between fixtures; clearing without reloading is too late, the rule already armed.

Driving them from the browser console / a CDP `evaluate` is enough — teach via
`__gsMenu["GateSkip: teach this page"]()`, click the gate, then click **Save** inside
`document.getElementById('gs-popup').shadowRoot`, then reload and read `GM:gs_log`.

## Debug mode (v0.2.0, added 2026-08-16 — temporary)

Added because a taught site that no longer shows its gate is ambiguous: GateSkip
dismissing it, the site not gating this visit, and the rule silently failing all look
identical from the outside. `gs_debug` (GM, default false) turns on:

- a pulsing 6px marker + label on the element about to be clicked, then a **5s delay**
  (`DEBUG_DELAY`) before `performClick`. Pending click lives in `run.pending`, and
  `run.debug` is **latched at arm() time** so toggling mid-countdown cannot strand it.
- a HUD (`#gs-hud`, top frame only, bottom left) narrating every decision **including the
  negatives** — that is the whole point; the normal `gs_log` deliberately records only
  real events. Frames relay via a `dbg` message and are prefixed `⧉ <host>:`.

Traps found while building it:

- **The frame prefix cannot be inferred from the hostname.** A same-host iframe (which
  `fixture-iframe.html` is) produces "armed … / never matched" lines identical to the top
  frame's. The relay flags `frame: true` explicitly.
- **The countdown can outlive the watch window**, so creating a pending click pushes
  `run.deadline` out to `now + DEBUG_DELAY + 3000`.
- **A mid-countdown vanish must cancel, not fire.** `fixture-simple.html` hits this on
  every load: the gate is in the served HTML, detached at parse time, so step 1 matches at
  document-start and is gone milliseconds later. Verified in the HUD.
- **Teaching from a frame is asynchronous.** A test that calls `startTeaching()` and then
  clicks in the frame synchronously records nothing — the `teach-on` broadcast has not
  landed. Looked exactly like a broken relay; it was the test. Wait a tick.

## Cleanup owed

- **Remove debug mode when testing is done** — it is scaffolding, not a feature. Delete:
  `DEBUG_KEY` / `DEBUG_DELAY` / `isDebug`, the whole "Debug HUD" section, the `dbg` calls
  in `arm`/`tick`/`performClick`, the `run.debug` / `run.pending` branch in `tick()` (keep
  `performClick` — the split is an improvement either way), the `.big` / `.l` CSS and the
  label/handle half of `hlPaint`, the `dbg` message case, the Settings tickbox, and the
  menu command. The README's "Debug mode" section goes with it.
