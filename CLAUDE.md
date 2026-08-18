# Forget Me Not — project notes

Violentmonkey userscript, **v0.14.0**. Single file, `Forget-Me-Not.user.js`, one IIFE,
`@run-at document-start`, runs in every frame. The shared rules in `../CLAUDE.md` (version
bumps, commit + push after every finished edit, no `innerHTML` in injected UI, the
two-userscripts-fighting-over-a-click note) apply here too.

This file is loaded automatically every session, so it is kept to **what you need before
touching anything**: the scope, the invariants, the current shape, and the rules that were each
paid for with a version. The reasoning behind every one of them lives in
[`docs/HISTORY.md`](docs/HISTORY.md) and is **not** loaded until you ask for it.

## Where to look

| You want | Read |
|---|---|
| What is done, what is next, what is broken | [`HANDOFF.md`](HANDOFF.md) — start here every session |
| How to test it in a real browser; the fixtures | [`docs/TESTING.md`](docs/TESTING.md) |
| The preference subsystem's full design | [`docs/PREFS.md`](docs/PREFS.md) |
| Why a rule below exists, and what it cost | [`docs/HISTORY.md`](docs/HISTORY.md) — indexed by version |
| What the user sees | [`README.md`](README.md) |

`docs/HISTORY.md` opens with its own contents table. Quick map of which version owns which
subject, so you can jump straight in:

- **Click verification / success signals** → v0.3.0, v0.6.0, v0.7.0
- **Timing, watch windows, retry ladders** → v0.4.0, v0.5.0
- **Diagnostics that alter what they measure** → v0.9.0
- **The rule shape, several sequences per host** → v0.11.0
- **Capture: the baseline, the classifier, the review panel** → v0.12.0
- **Replay, re-assertion, the loss watcher** → v0.13.0
- **Wikipedia, and how to measure whether a site fights us** → v0.14.0
- **The GateSkip rename; the M0–M5 milestone log** → end of the document

---

## Why the project exists

The user browses with a container extension that gives every tab a fresh container and destroys
it, with all cookies, on close. Nothing is logged in. That buys anonymity, and it costs every
site preference: sidebar closed, dark theme, wide layout — all forgotten on every visit, because
the only place a site knows to keep them is storage that just got deleted.

**Forget Me Not's job is to hold those preferences itself and reapply them, without the site
learning anything.** Dismissing gates is one case of that, not the point of it. The click runner
is the *fallback*, for state that has no stored representation.

### The replay ladder — take the highest rung that works

1. **Effect** — write the DOM state directly (a class on `<html>`, a `data-theme` attribute).
   Nothing is transmitted. Covers most theme / layout / panel preferences.
2. **Local storage** — write the key/value the site would have written, at document-start, for
   its own script to read.
3. ~~**Cookie**~~ — **deliberately does not exist. Do not add it.**
4. **Click** — the runner. For state with no persisted representation at all.

### Invariants — settled, do not re-open

- **Rung 3 (cookie replay) does not exist.** Cookies are blocked at browser level on this
  machine, so the write silently no-ops and reads back empty — it would fail indistinguishably
  from "the site ignored our value". And *"Forget Me Not never writes a cookie; nothing it does
  is transmitted to the host"* is one sentence, checkable by grepping for `document.cookie`. The
  alternative is a classifier you must keep trusting on every future site forever.
- **Capture is snapshot-and-review, never automatic.** Automatic capture would silently persist
  and replay the identifiers the container exists to destroy.
- **The review panel asks "which of these did you mean to set?"** — not "which look risky?".
  That framing is load-bearing. A diff mixes *user-caused* state (free to replay: they would
  have clicked it anyway) with *site-caused* state (session ids, analytics keys — which the
  container was going to destroy). Only the user can separate those, and only if asked the first
  question. The second makes them audit entropy, which they cannot do and should not have to.
- **v1 DOM targets are `:root` and `body` only.** Arbitrary selectors would drag the click
  runner's whole resolve-and-retry problem into the replayer.
- **Re-assertion stops at the first *trusted* user interaction** — same hazard as re-clicking a
  toggle that stayed on screen.
- **The master switch off means BOTH halves off.** One switch.
- **The two halves share only the settings UI, host-keyed storage, and the trace.** One script,
  hard internal boundary. When adding to either half, ask what it does on a host that has both —
  that seam has failed quietly once already.
- **GM storage is not partitioned per container** (confirmed by the user). The whole design
  rests on it.
- Known cost, accepted: **server-rendered preferences are out of scope**, and a userscript
  cannot touch request headers at all. If that ever matters it is an extension-shaped problem —
  keep the seam clean rather than half-emulating it.

### Two arguments that were made and withdrawn — do not reinvent them

- **"Replayed preferences make a fresh container distinctive."** Wrong baseline. The
  counterfactual is not "a visitor with no preferences", it is *the user, having clicked*. They
  were going to set that preference anyway and the site sees the identical state either way.
  Replay removes labour, not anonymity. What genuinely differs is the *manner of arrival* —
  present at document-start with no input events in front of it — but that reveals a static
  category bit, not an identifier, and creates no cross-visit linkage.
- **"Ephemerality makes a low-entropy replayed value safe."** Half wrong. Replay re-creates the
  value every visit out of storage the container cannot reach, which is a supercookie *if the
  value carries an identifier* — but not for a flag like `-clientpref-0` that millions of readers
  share. The hazard is wholesale replay of a captured blob nobody looked at, which is exactly
  what snapshot-and-review prevents.

> **The medium decides the blast radius. The value decides whether there is anything to leak.**

The line that the review step exists to draw:

| | Was it going to happen anyway? | Replaying it |
|---|---|---|
| **User-caused** state — the preferences they set | Yes, they would click them | Adds nothing |
| **Site-caused** state — session ids, analytics keys, consent blobs with an id inside | **No.** The container would have destroyed it | Adds tracking that would not otherwise exist |

A snapshot diff contains **both rows mixed together**, because the site wrote its own keys during
the same visit the user set their preferences. Separating them is the review's whole job.

Keep the entry set minimal anyway — but on **robustness** grounds, not privacy ones. Fewer
entries mean less to break at the next redesign, less to debug, and less chance of carrying
something nobody checked.

---

## Shape of the thing

Sections in order: storage → utilities → selector building → selector resolution → runner → SPA
watcher → highlight layer → trace → cross-frame messaging → teaching → popup → toast → shared UI
→ preferences (baseline, classifier, diff, review panel, capture, replay) → testing → settings →
boot.

Storage is GM: `fmn_rules` (host → rule), `fmn_on`, `fmn_watch`, `fmn_log`, `fmn_trace`.
In-progress teaching lives in **sessionStorage** (`fmn_teach`), top frame only. The `gs_*` v1
keys are deleted once, on first run, by `dropDeadKeys()` — they are never read.

**Schema v2.** A host entry is
`{ v:2, host, subdomains, enabled, clicks: [Seq], prefs: {captured, entries} }`, where `Seq` is
`{ id, label, steps:[Step], watchMs, fires, lastFired, created }`.

Entry kinds:

```js
{ kind:'class', sel:':root', add:['…'], remove:[] }              // arrays always length 0 or 1
{ kind:'attr',  sel:':root', name:'data-theme', value:'dark' }   // value:null = remove it
{ kind:'ls',    key:'…', value:'…' }
{ kind:'ss',    key:'…', value:'…' }
```

Every entry also carries `enabled`, `flag` (`'ok'` / `'idlike'`), `why`, and possibly
`redacted`. **There is no cookie kind.**

**There is no migration from v1 and no compatibility read path anywhere**, including the
Settings importer, which rejects a v1 export rather than converting it.

### Losing the user's saved rules costs NOTHING — never factor it in

Stated by the user, twice, the second time emphatically: rules take seconds to recreate and will
be wiped 30–50 times before this project is done. This is stronger than "migrations are
optional" — **rule loss is not a cost, so it may never appear in any argument.** Not "get the
schema right now", not "fold it in while the shape is open", not "keep a fallback read path".
Reshape storage whenever it is convenient.

The only remaining reason to split work across commits is **regression attribution**.

---

## Design rules — the click half

**`clicks` is an ARRAY, and that is the whole point of v2.** One host routinely needs an age
gate on the landing page *and* an unrelated popup three pages deep.

- **Folding a second gate in as extra STEPS cannot work.** A sequence is ordered and blocks:
  step N+1 is not hunted until step N commits. So a deep-page popup appended as "step 3" fires on
  neither page. They are two sequences, and the data model has to say so.
- **Every sequence arms simultaneously and the page decides which one runs** — a sequence
  self-selects by whether its step 1 resolves. **No URL matching, deliberately**: that is
  information the page hands you for free, and it survives the site reorganising its paths.
- **`NEVER MATCHED` is the normal, expected outcome for all but one sequence on any page.** With
  3 taught, a clean visit produces 2 of those lines. It is not an error.
- **Counters are per sequence, located by `id`**, because Settings can delete one while a run
  still holds a reference to it.
- **Teaching APPENDS.** Deleting is Settings' job and is per-sequence there.
- Trace lines are prefixed `[sequence name]` **only when more than one is armed**, so a
  single-sequence host's trace stays byte-identical to older ones and old comparisons still hold.
- Known and accepted: two sequences whose step 1 resolves to the same element will both click it.
  Don't teach that; no guard built.

### Decisions that are not obvious from the code

- **Rules are keyed on the hostname of the document the gate is in** — not the top page's. A
  frame cannot read a cross-origin parent's hostname, and keying on the frame's own host means a
  vendor's player widget is taught once and fixed everywhere it is embedded. The cost is that you
  cannot scope a rule to "this widget, only on this site".
- **Teaching does not intercept clicks.** A gate's confirm button is usually disabled until the
  checkbox is genuinely ticked, so a blocked first click makes the second unrecordable. Letting
  clicks through means the page may navigate mid-teach — which is why recorded steps sit in
  sessionStorage and the popup is restored on load.
- **Matching requires selector AND text.** The desired failure mode after a redesign is "stops
  working", not "clicks whatever now sits there".

---

## Design rules — the preference half

- **The baseline is ONE frozen snapshot**, taken in a `window` capture-phase listener on the
  first trusted pointerdown / keydown / click. It can tell "you never interacted with this page"
  apart from "you interacted and nothing changed" — a rolling poll collapses both into an empty
  diff, and the first case is common (a preference set inside a cross-origin frame, whose events
  the top frame never sees). Not gated on the master switch: a snapshot fires nothing.
- **A class entry is identified by the class NAME, not by the ± sign.** On one element a class is
  present or absent, so `+theme-dark` and `−theme-dark` are two states of one entry. Getting this
  wrong was measured, not theorised: flipping a theme and re-capturing stored *both*, an
  instruction set that contradicts itself.
- **One entry per class**, never one entry carrying `add:[…]` and `remove:[…]` arrays. The
  workflow is to trim until it stops working and step back one; six welded-together classes
  cannot be trimmed.
- **A DOM removal is replayable; a storage removal is not.** The document is served identically
  every visit, so a cleared attribute is back and must be cleared again. A deleted storage key was
  never there in a fresh container. Storage deletions are counted in the panel footer, not offered
  as entries — dropping them silently would be worse than either.
- **A second capture MERGES, and the two halves of an entry have different owners:** the value is
  the site's and is always updated; the tick is the user's and is always preserved.
- **An unticked entry the classifier called id-like is stored WITHOUT its value**
  (`redacted:true`). Keeping a session id in the one store the container cannot reach is the exact
  harm this project prevents. The value is kept when the entry is enabled, **or** when the
  classifier saw nothing id-like — which is what makes the trim workflow work. Re-ticking a
  redacted entry needs a fresh capture, and the panel says so.
- **The classifier matches whole words, split on punctuation AND camelCase humps.** A substring
  test is unusable: `id` is inside `sidebar`, `hidden`, `width`, `provider`. Value rules run
  before name rules, because "looks like a UUID" tells the user more than "the key is called
  clickId". It annotates and pre-decides; **it never blocks.**
- Values over `PREF_MAX_VALUE` (4096) are not offered at all, and are counted in the footer. That
  is the capture declining to carry a payload, not the classifier blocking a risky value.
- **Storage entries are written only if the key is ABSENT.** A value still sitting there was not
  destroyed, so this browser kept it and the user may have changed it since.
- **`watchEarlyDrift` repairs; `watchForLosses` only reports.** Before the user has touched
  anything, putting a preference back is what we are for. After re-assertion has finished, only
  reporting is — a repairing observer there is an endless fight with the site and with the user.
- **A pass that changed nothing writes no trace line.** A heartbeat on every quiet pass would bury
  the one that matters under four times as many that do not.
- **"It holds" and "it holds because we kept putting it back" are different results**, so the
  audit line carries a re-assert count. Re-assertion can otherwise mask a wrong-rung choice
  entirely — **never judge a rung by the end state alone.**
- `ss` is the weakest of the four kinds: sessionStorage dies with the tab whatever the container
  does, so replaying it manufactures a resumed session rather than restoring a destroyed one. It
  survives on the counterfactual test and shares the `ls` code path, so it is nearly free. Drop it
  the moment it costs anything.

---

## Engineering rules, paid for with a version each

Evidence for every one of these is in `docs/HISTORY.md` under the version named.

### Judging whether something worked — v0.3.0, v0.6.0, v0.7.0

- **A click is not an outcome.** Markup is routinely served with its handler attached seconds
  later — present, visible, completely inert. Every click goes fire → wait → check, retried, and a
  step counts as done only once the page demonstrably moved.
- **A false positive is far worse than a false negative.** A false negative costs a few extra
  clicks; a false positive writes the step off permanently *and* logs an event that never
  happened, destroying the credibility of the only instrument there is.
- **Every verdict must name the signal that fired** (`counted as done — 'anc' changed`). A verdict
  you cannot audit is how three versions of misdiagnosis happened. Do not remove this.
- **Never let a retry loop near a control without a working effect test.**
- `ancestry()` is **classes only**, at most 5 ancestors, and **stops before `<body>` and
  `<html>`**. No size signals anywhere — the element's own box is `collapsed` (under 1px) only.
  Layout noise during load reads as a result. Do not put either back.
- Known blind spot with no detection built: **a late class landing on a container the taught
  element sits in is genuinely indistinguishable from a real effect.** A control sample is the only
  lever, and a naive one kills the true signal too (a sibling shares the parent a real toggle
  marks). Do not build it speculatively.

### Timing — v0.4.0, v0.5.0

- **The watch window is renewed at DOM ready and at `load`**, not counted from document-start.
  Hunting still starts at document-start so a server-rendered gate can die before first paint.
- **The retry ladder must outlast the page's start-up**: 8 attempts over ~16s, gaps growing 400 →
  3000ms, verify grace growing 450 → 1200ms.
- **Not a fix: waiting for `readyState` before clicking.** It forfeits the pre-first-paint
  dismissal and would not have helped anyway. A MutationObserver cannot help either —
  `addEventListener` produces no mutation, so "handler attached" is unobservable by construction.
  Time-based retry is the only lever there is.
- **"It only works when debug is on" is about the delay, not about debug.** Three versions were
  burned on this. Likewise **"works on refresh, not on a fresh tab"** means load-time noise is
  being read as a result, not that the script waits too little.
- **A fix that works when you look at it and not otherwise is about time, not state.**

### Instruments — v0.9.0, v0.14.0

- **Nothing in this script may alter timing in order to explain itself.** Debug mode's five-second
  delay made failures stop happening while you watched. The trace replaced it: always on, costs
  nothing, records the failing run rather than one perturbed into succeeding. If a future subsystem
  needs narration, it writes trace lines.
- **A before/after comparison cannot detect a change that was undone.** Whenever the question is
  "does this site fight us?", the instrument has to be an **observer**, not a diff. This survived a
  whole round of confident reporting before a timeline caught it.
- **A cleanup list written when a feature was added goes stale the moment any of that feature is
  repurposed. Re-read the code before executing one.**

### Runner mechanics — from the 2026-08-16 build

- **`arm()` must be idempotent per URL** (the `armedUrl` guard). It runs at document-start and
  again from `boot()`; without the guard, a gate torn down and re-shown during load is clicked by
  both windows.
- **"Did the gate come back?" cannot be answered by node identity** — plenty of sites detach and
  re-attach the *same* node. The reliable signal is that step 1 stopped resolving and then started
  again. Both tests are kept, ORed.
- **Never re-click a gate that stayed on screen.** On a checkbox step the second click unticks what
  the first ticked. Only "vanished then returned" earns a retry.
- **`el.click()` is what does the work**, not `dispatchEvent(new MouseEvent('click'))` — only the
  former toggles a checkbox, forwards a `<label>` to its input, and submits a form. The pointer
  events dispatched in front of it are for frameworks that act on `mousedown` and never listen for
  `click`. Everything needs `composed: true` or the event never leaves a shadow root. And
  `el.click()` is `HTMLElement`'s, so on an SVG node it **throws** — the `dispatchEvent` fallback
  in `realClick` is load-bearing, not belt-and-braces.
- **`composedPath()`, not `e.target`** — inside a shadow root `e.target` is retargeted to the host.
- **A checkbox's `value` is the string `"on"`.** Only use `value` for
  `input[type=submit|button|reset]`.
- **`cursor` is an INHERITED CSS property**, so the "walk up to the nearest `cursor:pointer`
  ancestor" fallback lands on the icon it exists to walk out of unless both passes skip
  `INERT_TAG`.
- **Test-result messages must only report positives.** Every frame lacking the element would
  otherwise answer "not found" and win the race against the one frame that has it.

---

## The trace

`dbg()` writes to `fmn_trace` (GM, capped at `TRACE_MAX` = 600) unconditionally, and Settings has
**Save trace** / **Clear trace**. Each line carries `+NNNNms` since that document started, because
"how long after the page began" is the number that has mattered every single time. Frames write
straight to GM storage (shared across frames), so no messaging is involved, and are prefixed `⧉`
from `isTop` — **the frame prefix cannot be inferred from the hostname**; a same-host iframe
produces identical-looking lines otherwise.

This exists because the broken case is the one with no observer in it: turning a narration mode on
to find out why something fails changed the timing enough to make it succeed, so the failing case
was never the one being watched.

Resist adding a trace line "while you are in there" — a scaffolding-removal commit that also
changes trace output is not attributable.
