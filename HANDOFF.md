# Handoff — start here

Written 2026-08-17 at the end of a long session. Everything below is decided, not open for
re-litigation, unless it says otherwise.

## Where things stand

- **v0.7.0, working.** All five fixture scenarios pass, and the user has confirmed it works on
  real Wikipedia with debug off — the "only works when debug is on" bug is finally dead. Root
  cause was the success test reading the clicked element's own box resizing (web font arriving)
  as proof the click worked; see the v0.7.0 section of `CLAUDE.md`.
- **The project has been re-scoped.** It is no longer "skip gates". It is "keep my site
  preferences without letting the site track me". Read **"Why the project exists"** at the top
  of `CLAUDE.md` before designing anything — it carries the replay ladder and the privacy
  reasoning, including two arguments that were made, tested and **withdrawn**. Do not
  reinvent them.
- **The design for the new subsystem is written**: `docs/PREFS.md`. It is complete enough to
  build from.

## Step 0 — the rename. Do this FIRST, before any code.

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

**M0 — Delete debug mode.** It is scaffolding, `CLAUDE.md`'s "Cleanup owed" section lists
exactly what to remove, and its blocker is now cleared (v0.7.0 is confirmed on real Wikipedia).
The trace replaced it in practice — v0.7.0 was diagnosed entirely from trace plus fixture with
debug never switched on. Do not build a new subsystem on top of code slated for deletion.
Keep the trace; keep the `performClick` split.

**M1 — Schema v2 + migration, no behaviour change.** `gs_rules` becomes
`{v:2, clicks:{steps,…}, prefs:{…}}`; see `docs/PREFS.md` for the shape. Rename the storage
keys in the same pass. Ship it and confirm the user's taught rules survive a real browser
restart before anything else touches storage.

**M2 — Write the four fixtures before the feature exists.** `fixture-pref-ls`,
`-dom`, `-hostile`, `-noise`, specified in `docs/PREFS.md`. This ordering is deliberate: four
versions of this project were burned on never having stated precisely what "working" means, and
a fixture is the cheapest way to state it.

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
