# Handoff — start here

Written 2026-08-17 at the end of a long session. Everything below is decided, not open for
re-litigation, unless it says otherwise.

## Where things stand

- **v0.9.0, working.** All five fixture scenarios re-verified 2026-08-17 after debug mode was
  removed, driven from the Browser pane against `python -m http.server` on 8731:
  `fixture-late.html?wire=8000&grow=1` (retried through the dead window across 5 attempts, no
  false positive on the layout noise, committed at +10411ms on "the step stopped resolving",
  panel collapsed), `fixture-simple.html`, `fixture-iframe.html` (frame armed and dismissed
  independently, `⧉` prefix intact), `fixture-icon.html` (12s gate caught, `<path>` → `<div.x>`
  candidate walk worked), `fixture-shadow.html` (checkbox committed on `'checked' changed`,
  then the button that was disabled until ticked). Settings, teaching and the highlight layer
  were checked separately.
- The user confirmed v0.7.0 on real Wikipedia with debug off — the "only works when debug is
  on" bug is dead. Root cause was the success test reading the clicked element's own box
  resizing (web font arriving) as proof the click worked; see the v0.7.0 section of `CLAUDE.md`.
- **The project has been re-scoped.** It is no longer "skip gates". It is "keep my site
  preferences without letting the site track me". Read **"Why the project exists"** at the top
  of `CLAUDE.md` before designing anything — it carries the replay ladder and the privacy
  reasoning, including two arguments that were made, tested and **withdrawn**. Do not
  reinvent them.
- **The design for the new subsystem is written**: `docs/PREFS.md`. It is complete enough to
  build from.
- **v0.13.0 is the current script, and the preference half is feature-complete.** M2 added the
  four fixtures, M3 the capture half, M4 replay. Next up is **M5** — Wikipedia in a fresh
  container, the first run against a site with no fixture behind it.

## Step 0 — the rename. ✅ DONE 2026-08-17.

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
  `../CLAUDE.md`.
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
of misdiagnosis and is the second most valuable thing here after `CLAUDE.md`.

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
   "two userscripts fighting over the same click" hazard documented in `../CLAUDE.md`.
7. Deleting the old `GateSkip` GitHub repo and the gist is **the user's to do**, and only after
   the new install is confirmed working. Do not do it for them.

Deliberately NOT part of the rename: the `gs_*` GM storage keys, the `#gs-popup` / `#gs-hud`
DOM ids, and `__gsMenu` in `tests/gm-shim.js`. Renaming storage keys orphans the user's taught
rules, so fold that into the M1 migration below — one migration pass, and the rename stays
behaviour-neutral so any regression is attributable.

Nothing to migrate in `~/.claude/projects/…-GateSkip/memory/` — it is empty. `.claude/launch.json`
is path-independent (serves the cwd), so it needs no edit.

## Plan, in order

**M0 — Delete debug mode. ✅ DONE 2026-08-17, v0.9.0.** 209 lines removed; all five fixtures
re-verified afterwards (see below). The trace and the `performClick` split were kept. Write-up
in `CLAUDE.md`, including the trap that the "Cleanup owed" list it was executed from had gone
stale and, followed literally, would have deleted the trace's only source of content.

**M1 — Schema v2, new key names, NO migration. ✅ DONE 2026-08-17.** Shipped as two commits so
a regression would have one candidate cause: **v0.10.0** reshaped storage while the runner
still used `clicks[0]` (inert — all five fixtures unchanged), **v0.11.0** made the runner arm
every sequence and teaching append.

`fmn_rules` holds `{v:2, host, subdomains, enabled, clicks:[Seq], prefs:{…}}`. **`clicks` is an
array**, not the single object originally drafted in `docs/PREFS.md` — the user needs a second,
unrelated popup taught several pages into a site without wiping the landing page's gate, and
extra *steps* cannot express that (a sequence blocks on step N before hunting N+1, so the deep
popup would fire on neither page). Each sequence arms independently and self-selects by whether
its step 1 resolves; there is no URL matching. Full reasoning in `CLAUDE.md`.

Verified: two sequences running in parallel on one page with independent retry ladders; a
sequence whose control is absent reporting `NEVER MATCHED` and retiring without interfering;
teaching a third appending while the first two keep their counters; cross-frame; and the
`<path>` → `<div.x>` candidate walk. The `gs_*` keys are deleted once on first run.

**There is deliberately no v1→v2 migration, and no back-compat read path.** An earlier draft of
this plan (and of `docs/PREFS.md`) said to keep one "for a long time; rules are hand-taught and
expensive to lose". The user settled it 2026-08-17: *"there is no need to keep any of it. It
takes about 5 seconds to recreate it."* Re-teaching is cheaper than carrying a compatibility
path forever, so the shape is written clean. This also retires the gate that used to sit here —
"ship it and confirm the user's taught rules survive a browser restart" — because there is
nothing left to survive.

Not renamed, on purpose: the DOM ids `gs-popup` / `gs-settings` / `gs-hud` and `__gsMenu` in
`tests/gm-shim.js`. They are internal, nothing persists them, and churning them adds diff noise
to exactly the milestones where a regression has to stay attributable.

**M2 — Write the four fixtures before the feature exists. ✅ DONE 2026-08-17.**
`fixture-pref-ls.html`, `-dom`, `-hostile`, `-noise`, plus the shared instrument
`tests/pref-probe.js`. No userscript change, so no version bump. Each page states its own pass
criteria in prose, and all four were driven in a real browser against the behaviour they claim —
see the "preference fixtures" subsection of `CLAUDE.md` for the measured numbers and the two
traps that are specific to this set.

The ordering was deliberate: four versions of this project were burned on never having stated
precisely what "working" means, and a fixture is the cheapest way to state it. (`docs/PREFS.md`'s
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

Three design points that came out of building it are in `CLAUDE.md` under "Capture: baseline,
classifier, review panel" — the baseline is a single frozen snapshot rather than PREFS's rolling
poll (and `docs/PREFS.md` is corrected), a class entry's identity is the class name rather than
the ± sign, and an unticked id-like entry is stored without its value. The second was found by
the fixture, not by reasoning: with the sign in the identity, flipping a preference and
capturing again stored both "add it" and "remove it".

**M4 — Replay at document-start + re-assertion + trace lines. ✅ DONE 2026-08-17, v0.13.0.**
Both rungs work. The two items left over from M3 are done: `arm()` now says `no taught clicks for
<host> — N preference(s) are replayed here instead`, and the prefs-only rule is handled
throughout.

Write-up in `CLAUDE.md` under "Replay: rungs 1 and 2, re-assertion, and the loss watcher". The
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

Not verified live, and stated as such in `CLAUDE.md`: **re-assertion's own `touched` gate**, as
distinct from the watcher's. It needs a trusted interaction inside the first second of a page
load, which the test tooling cannot deliver. Inspected only.

**M5 — Wikipedia, anonymous, in a fresh container.** All the machinery now exists; this is the
first run against a site nobody wrote a fixture for. `docs/PREFS.md` has the measurement already
taken: the six `clientpref` classes on `:root`, all low-entropy and enumerable, with rung 1 alone
sufficient for the theme and the TOC pin, and localStorage untouched and empty throughout.
Expect the capture to offer those classes pre-ticked. Watch for two things — whether MediaWiki's
start-up rewrites `:root`'s class list (which would show up as re-assert lines, and would make
the audit's re-assert count the thing to read), and whether the served class list differs
between logged-out visits.

**M5 — Wikipedia, anonymous, in a fresh container.** Sidebar closed and dark theme from first
paint, with nothing transmitted.

## Losing the user's saved rules costs NOTHING. Stop factoring it in.

Stated by the user 2026-08-17, after this kept resurfacing: *"wiping all my saved rules is of
zero importance to me. I expect that by the time we are done with this project I will have done
it 30-50 times, and it only takes a few seconds for each one. You need to stop taking it into
consideration at all."*

This is not "migrations are optional". It is stronger: **rule loss is not a cost, so it may
never appear in any argument.** Concretely, none of the following are valid reasoning here:

- "Get the schema right now, because reshaping it later means re-teaching." — No. Reshape
  whenever it is convenient. There is no last chance and no schema debt.
- "Fold this into M1 while the shape is open." — No. Sequence work by what is clearest to
  build and easiest to attribute a regression to, and by nothing else.
- "Add a compatibility read path / keep the old key as a fallback / write a migration." — No.
  Delete and move on.

The only remaining reason to split work across milestones is **regression attribution** — a
commit that changes one thing tells you what broke. That reason stands on its own and does not
need storage to justify it.

## Decisions already made — do not re-open

- **Rung 3 (cookie replay) does not exist.** Reasoning in `CLAUDE.md`; the decisive argument is
  that cookies are blocked at browser level on this machine, so the write silently no-ops.
- **Capture is snapshot-and-review, never automatic.** The user's own choice.
- **v1 DOM targets are `:root` and `body` only.** Arbitrary selectors would drag the click
  runner's whole resolve-and-retry problem into the replayer.
- **Re-assertion stops at first user interaction**, same hazard as re-clicking a toggle that
  stayed on screen.
- **The two halves share only the settings UI, host-keyed storage, and the trace.** Keep that
  seam clean. One script, hard internal boundary.
- GM storage is **not** partitioned per container (confirmed by the user), which is what makes
  any of this possible.

Settled 2026-08-17, third session — these filled real gaps in the design, they are not restatements:

- **The review list is ONE panel, built once, shown in two places.** It appears immediately
  after "Remember this site" with the diff pre-ticked, and is re-openable per host from
  Settings. Both are required: the decision needs the context you have at capture time, but
  `docs/PREFS.md` also makes trimming a hard requirement ("unticking and re-testing must be one
  click", because the workflow is to trim until it stops working and step back one), and that is
  impossible if review only ever happens once. Do not build two separate UIs for this.
- **The baseline snapshot covers**: the class list and all attributes of `:root` and `body`,
  plus the complete localStorage and sessionStorage key/value maps. Capture is **top frame
  only** (the menu commands are already gated on `isTop`); replay is **per frame**. That
  asymmetry is intended — a frame gets the rule for its own host, or no rule.
- **The `ss` entry kind stays in v1.** It is worth writing down that it is the weakest of the
  four, because `docs/PREFS.md` lists it with no argument attached: unlike `ls`, sessionStorage
  dies with the tab whatever the container does, so replay is not restoring something the
  container destroyed — it is creating a resumed session that never existed. It survives on the
  counterfactual test anyway (you would have dismissed that session-scoped banner by hand in
  every fresh tab) and it shares the `ls` code path entirely, so it is close to free. Drop it
  without hesitation if it ever costs anything.
- **`gs_on` (→ `fmn_on`) off means BOTH halves off**, clicks and replay alike. One switch.

## Standing lessons that keep paying off

- **"It only works when debug is on" is about `DEBUG_DELAY`, not debug** — and the cause has
  been different every single time. Reproduce in a fixture and run the control against the
  previous version before believing any theory.
- **A false positive is far worse than a false negative** in any "did it work?" test. A false
  negative costs a few extra clicks; a false positive writes the step off permanently *and*
  logs an event that never happened, which destroys the only instrument there is.
- **Every verdict must name the signal that fired.** A verdict you cannot audit is how three
  versions of misdiagnosis happened.
- Driving fixtures does not need the teach flow — write `GM:gs_rules` straight into
  `localStorage`. See the Testing section of `CLAUDE.md`.
