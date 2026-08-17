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

**M1 — Schema v2, new key names, NO migration.** `fmn_rules` holds
`{v:2, clicks:{steps,…}, prefs:{…}}`; see `docs/PREFS.md` for the shape. The `gs_*` keys become
`fmn_*` in the same pass, and the old ones are deleted once on first run.

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

**M2 — Write the four fixtures before the feature exists.** `fixture-pref-ls`,
`-dom`, `-hostile`, `-noise`, specified in `docs/PREFS.md`. This ordering is deliberate: four
versions of this project were burned on never having stated precisely what "working" means, and
a fixture is the cheapest way to state it. They are plain HTML pages describing *site*
behaviour, so none of them depends on the storage shape or on any pref code existing.

**Confirmed 2026-08-17.** `docs/PREFS.md`'s own "Build order" used to list the fixtures at step
4, after capture and replay — a direct contradiction of this milestone, in the same package.
Fixtures-first wins; PREFS has been corrected.

**M3 — Rolling baseline + "Remember this site" capture + review UI.**

**M4 — Replay at document-start + re-assertion + trace lines.**

**M5 — Wikipedia, anonymous, in a fresh container.** Sidebar closed and dark theme from first
paint, with nothing transmitted.

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
