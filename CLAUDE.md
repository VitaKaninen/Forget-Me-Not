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

**The icon inside the button is not the button.** A step recorded as `path (no text)` is a
click that landed on an `<svg>` child. Two fixes, because old rules already store the
`<path>`: `clickableFrom` (teach time) falls back to the nearest ancestor with
`cursor: pointer` when nothing matches `CLICKABLE` — which is what a `<div>`-with-a-listener
close button looks like from outside — and `clickTarget` (click time) walks an `INERT_TAG`
element up to the nearest real control. Attempts 1–2 use that control, attempt 3+ falls back
to the exact node taught, because there is no way to tell from here which of the two the site
listens on. Note `el.click()` is `HTMLElement`'s, so on an SVG node it **throws** — the
`dispatchEvent` fallback in `realClick` is load-bearing, not belt-and-braces.

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
**grandparent** — `window.__verdict()` returns the pass/fail state).

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
