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
only inside an embedded frame).

Driving them from the browser console / a CDP `evaluate` is enough — teach via
`__gsMenu["GateSkip: teach this page"]()`, click the gate, then click **Save** inside
`document.getElementById('gs-popup').shadowRoot`, then reload and read `GM:gs_log`.

## Cleanup owed

None.
