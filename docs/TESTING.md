# Testing v0.14.0 in your own browser

Written 2026-08-17. Everything in v0.12.0–v0.14.0 (capture, replay, re-assertion, the loss
watcher, early drift repair) was verified **only** in the Browser pane against localhost —
never in Violentmonkey, never against real GM storage, never in a container. This document is
the checklist for closing that gap.

Assumption, stated because it shapes several steps: **Firefox + Violentmonkey + a
temporary-container extension**. If any of that is wrong, say so — Round 3 in particular is
written around it.

## The instrument is the trace, not the screen

Nearly every round below is read from the trace, not from what the page looks like. This
project has three separate incidents on record of a page *looking* right while the log claimed
something that never happened, so:

- **Clear the trace immediately before a test and save it immediately after.** It keeps 600
  lines and rolls over silently.
- Settings → **Save trace** downloads a `.txt`. If a site's CSP refuses the download a paste
  box opens instead — the trace is never unreachable.
- The trace is global GM storage, so you can save it from *any* page. If a site is hostile,
  open Settings on `example.com` and save it there.
- Every line is `HH:MM:SS.mmm  +NNNNNms  <host>  <message>`. The `+NNNNNms` is milliseconds
  since **that document** started, and it is the number that has mattered every single time.
  A `⧉ ` before the host means the line came from an embedded frame.

### Vocabulary — what a healthy run says

| Line | Means |
|---|---|
| `no rule for X — Forget Me Not is doing nothing on this page` | untaught host, top frame only |
| `no taught clicks for X — N preference(s) are replayed here instead` | prefs-only host |
| `armed for X — "name" (N steps), watching 15s — fired N time(s) before` | one sequence |
| `armed for X — N sequences, each hunting its own step 1: …` | several |
| `page reached DOM ready / fully loaded — watching Ns more from here` | window renewed |
| `replaying preferences for X — storage: wrote N, left N already there; page: …` | document-start replay |
| `applied at DOM ready: …` | a `body` entry, or one that could not be written earlier |
| `re-asserted at start-up: … — the site had overwritten them` | early drift repair fired |
| `re-asserted at DOM ready / load / load+1s: …` | scheduled re-assertion fired |
| `all N page preference(s) hold as re-assertion finishes (M of them only because …)` | the audit |
| `LOST N of M page preference(s) — … the site has put them back` | the loss watcher |
| `watch window ended and step 1 NEVER MATCHED` | **normal** for every sequence whose gate is not on this page |
| `step N counted as done — 'anc' changed` / `— the step stopped resolving` | which signal convinced it |
| `step N: 8 clicks across …, nothing changed` | click landed, page ignored it |

---

## Round 1 — smoke (10 minutes, any site)

Goal: prove the script loads under Violentmonkey at all and that real GM storage round-trips.
This is the one thing the Browser pane could never test — every fixture run used a
`localStorage` shim, not GM storage.

1. Open any ordinary page (`https://example.com`).
2. Violentmonkey toolbar icon → confirm **four** commands appear:
   `teach this page`, `remember this site`, `settings`, `forget this site`.
3. Open **settings**. Expect the dialog, the master switch on, `Watch for 15 seconds`,
   "No sites taught yet", and an empty **Recent activity**.
4. Change *Watch for* to 20, close, reopen. It should still say 20. → **GM writes persist.**
5. Set it back to 15.
6. **Save trace.** You should get a `.txt` containing at least one
   `no rule for example.com` line. → **the trace works end to end.**
7. **Clear trace.**

Fails here mean the script is not running, not that a feature is broken. Check Violentmonkey
has it enabled and that the old GateSkip script really is gone.

---

## Round 2 — preferences on Wikipedia (the M5 acceptance)

This is the headline feature and the only real site it has ever been run against.

**Capture:**

1. Settings → **Clear trace**.
2. Open `https://en.wikipedia.org/wiki/Cat` in a **normal** (non-temporary) tab — for now we
   want the site to behave normally. Leave the tab in the **foreground**: Wikipedia's Appearance
   panel is built by a late module that does not run in a background tab.
3. Do not click anything yet. Find **Appearance** on the right-hand side, click it open, then
   choose **Dark**.
   - Your very first click freezes the preference baseline. Anything the site did before that
     click is its own start-up and cannot appear in the capture — that is the design.
4. Violentmonkey menu → **Forget Me Not: remember this site**.
5. **Expected panel:** exactly two entries under *Classes on the page*, both ticked, no warnings:
   - `:root  + skin-theme-clientpref-night`
   - `:root  − skin-theme-clientpref-day`
   - If you also pinned/unpinned the panel you will see `vector-feature-appearance-pinned-…`
     entries. Untick those — fewer is better.
   - **A `MediaWikiModuleStore:enwiki` row must NOT appear.** It is ~447 KB and should be
     silently dropped by the size cap; if anything appears at all it will be a footer note
     saying "1 value(s) over 4096 characters were left out".
6. **Save.** Toast: `remembering 2 things for en.wikipedia.org`.
7. Settings → the host card should read `0 sequences · 2 preferences` with a **Prefs** button.

**Replay:**

8. Settings → **Clear trace**.
9. Open `https://en.wikipedia.org/wiki/Dog` in a **new tab**.
10. **Expected: dark from first paint, no white flash.**
11. Save the trace. It must contain, in this order:
    - `replaying preferences for en.wikipedia.org — storage: wrote 0, left 0 already there;
      page: :root + skin-theme-clientpref-night, :root − skin-theme-clientpref-day`
      — at a very low `+NNms`, single or low double digits.
    - `re-asserted at start-up: … — the site had overwritten them` — **this line is expected
      and is not a fault.** MediaWiki reassigns the whole root `className` about a millisecond
      after our write; this is `watchEarlyDrift` repairing it on the mutation that caused it.
    - `no taught clicks for en.wikipedia.org — 2 preference(s) are replayed here instead`
    - `all 2 page preference(s) hold as re-assertion finishes (2 of them only because they were
      put back after the site overwrote them)`

**What failure looks like, and what it means:**

| Symptom | Diagnosis |
|---|---|
| Visible flash of light theme, then dark | `watchEarlyDrift` did not catch it. Check whether the repair line says `at start-up` or `at DOM ready` — `DOM ready` means early repair never fired. |
| `LOST 2 of 2 …` | MediaWiki changed, or re-assertion ran out. Send the trace. |
| No `replaying preferences` line at all | The rule did not match this host, or the master switch is off. |
| Dark, but the audit line has no "only because" clause | Early drift repair was not needed — fine, but note it, it contradicts the M5 measurement. |

**The `touched` gate — this has never been measured and is the most likely thing to be wrong.**

12. Clear trace. Open `en.wikipedia.org/wiki/Bird` and **click something immediately** (within
    the first second — a link, the search box, anywhere).
13. Expected: no `re-asserted at …` lines after your click, and the audit replaced by
    `no preference audit — you interacted with the page, so anything that changed is yours`.
14. A plausible bad outcome: you click fast enough that re-assertion stops before MediaWiki's
    rewrite, and the page **stays light**. If that happens it is a real finding — report the
    `+NNms` of your click versus the `replaying preferences` line.

---

## Round 3 — the container (the actual point of the project)

Everything above ran with the site's own cookie intact. This round removes it.

1. Clear trace.
2. Open `https://en.wikipedia.org/wiki/Cat` in a **fresh temporary container**.
3. Expected: **dark from first paint**, and the trace identical in shape to step 11 — because
   the preference never depended on the cookie.
4. Confirm the site did not get its cookie back: `document.cookie` in that tab must contain no
   `enwikimwclientpreferences`. **Forget Me Not never writes a cookie**; if one is there, that
   is a hard failure and a design violation, not a bug to shrug at.
5. Close the container, open another fresh one, repeat. It must work every time — this is what
   proves GM storage is not container-partitioned in *your* setup, which the whole design rests
   on and which has only ever been confirmed verbally.

If step 5 fails — if the rule is gone in a fresh container — stop. Nothing else in the project
works and the whole approach needs rethinking.

---

## Round 4 — capture edge cases

These exercise the classifier, the merge, redaction and the honest-refusal path, all of which
were only ever driven against synthetic fixtures.

**4a — the honest refusal.** Open any site, do **not** touch the page, pick *remember this
site*. Expected toast: *"I have no 'before' for this page yet…"*, and a trace line
`capture asked for with no baseline`. This is the case that distinguishes "you never interacted"
from "you interacted and nothing changed", and it is the reason the baseline is a single frozen
snapshot rather than a poll.

**4b — the classifier against real analytics.** `https://developer.mozilla.org/en-US/docs/Web/CSS`.
Measured there today: `<html data-theme="light dark">` and a localStorage set from Mozilla's
Glean telemetry —

- `userLifetimeMetrics` — contains `"session_id":"58a929cf-…"`, a UUID
- `glean_session_last_active` — a 13-digit epoch
- `appLifetimeMetrics`, `events`, `pings`

Click anywhere to freeze the baseline, wait a few seconds, click something else, then capture.
Any Glean key that changed must arrive **unticked** with a reason (`contains a UUID`,
`a 13-digit number — almost always a timestamp or an id`). Save without ticking them, then
Settings → **Prefs** and confirm they read *"(value not kept — re-capture to restore it)"* with
the tick box disabled. That is redaction working: the value of an excluded identifier is not in
GM storage at all.

I did **not** find a manual theme control on MDN — it appears to follow `prefers-color-scheme`
now — so treat MDN as a classifier target, not a replay target.

**4c — a `body` attribute plus a storage key (both rungs, the deferred path).**
`https://squidfunk.github.io/mkdocs-material/`. Measured today: the palette toggle sets
`body[data-md-color-scheme]` (**body**, not `:root` — the entry that cannot be written at
document-start and must be deferred to DOM ready) and writes localStorage
`/mkdocs-material/.__palette` holding a small JSON blob.

Click once, flip the palette with the toggle in the header, capture. Expect one `attr` entry on
`body` and one `ls` entry, both ticked. Save & reload. The trace must show:

- `replaying preferences for … — storage: wrote 1, left 0 already there; page: nothing on the page yet`
- then `applied at DOM ready: body  data-md-color-scheme`

That second line, arriving separately, **is the deferred-body path working.** If both appear on
the document-start line, something changed.

Then the "only if absent" rule: with the rule saved, change the palette *on the site* to a third
value, reload, and confirm the trace says `wrote 0, left 1 already there` and the page keeps
**your** newer value. Replay restores what the container destroyed; it does not stamp over what
survived.

**4d — merge, and trimming.** On MkDocs Material, untick the `ls` entry in Settings → Prefs →
**Save & reload**. Does the body attribute alone hold? Read `re-asserted` lines before deciding —
re-assertion can make a wrong rung look identical to a right one. Then re-tick and re-save.
Finally capture *again* on the same host and confirm the panel **merges**: entries you unticked
stay unticked, values update, genuinely new ones carry a green `new` tag. A second capture must
never wipe the first.

**4e — Forget these.** Settings → Prefs → **Forget these**. The host card should vanish entirely
if it had no taught clicks.

---

## Round 5 — the click runner on a real site (two sequences, one host)

`https://www.jackdaniels.com/en-us` — measured today and it is close to an ideal target:

- An age/locale gate with an **ENTER** button whose id is `react-aria7382962038-:r10:` — a
  generated id, which the selector builder is supposed to skip. If a taught rule survives a
  reload, that skipping works.
- A **OneTrust** consent banner in the *same document*: `#onetrust-accept-btn-handler`,
  `#onetrust-reject-all-handler`, `#onetrust-pc-btn-handler`.
- localStorage and sessionStorage **completely empty**; everything persists in cookies
  (`STYXKEY_COUNTRY_COOKIE`, `OptanonConsent`).

So this host is rung 4 and nothing else — which makes it two tests at once.

1. Fresh container. Clear trace.
2. **First confirm capture declines honestly:** dismiss the age gate by hand, then pick
   *remember this site*. Because everything it persists is a cookie, the capture should offer
   little or nothing — and if it offers nothing at all the toast is *"nothing has changed on this
   page since you first touched it"*. That is the correct answer, and it is the practical
   demonstration that cookie-backed sites fall to the click runner.
3. Fresh container again. Teach the **age gate** (menu → *teach this page*, dismiss it as
   normal, press **Save**).
4. Fresh container. Expect the gate dismissed and a trace line
   `armed for www.jackdaniels.com — "ENTER" (N steps)` followed by
   `step 1 counted as done — <signal>`. **Check which signal fired.** If it is anything to do
   with size or layout, be suspicious — that class of false positive has cost this project two
   versions.
5. Now teach a **second, unrelated** sequence: dismiss the OneTrust banner and save. Settings
   should show `2 sequences`, and the first one's `fires` counter must be intact — teaching
   appends, it does not replace.
6. Fresh container. The trace must now read
   `armed for … — 2 sequences, each hunting its own step 1: …` with each line prefixed
   `[name] `, and — depending on what the page shows — one of them may report
   `watch window ended and step 1 NEVER MATCHED`. **That is the normal, designed outcome for a
   sequence whose gate is not on this page. It is not an error.**
7. Settings → per-sequence **✕** deletes one and leaves the other alone. Settings → **Test**
   highlights the first step in green on the page behind the dialog.

**If the gate is dismissed but a click also did something you did not want** (navigated, opened
a menu), that is worth reporting in detail — the runner retries up to 8 times across ~16s and
works through several candidate elements, and this is its first exposure to a real site with
React-generated markup.

---

## Round 6 — cross-frame

Rules are keyed on the hostname of the document the gate is *in*, so a gate inside an embedded
widget is taught once and fixed everywhere it is embedded.

Target: any page embedding a third-party consent or player widget in an **iframe**. Many EU
consent walls (Sourcepoint, Quantcast) render in a cross-origin frame — but on a US IP they
often do not appear at all, so this round may simply be untestable from here. Say so rather
than forcing it.

What to check if you find one: the trace lines from the frame are prefixed `⧉ ` with the
**frame's** host, and the rule saved in Settings is keyed on that host, not on the page you were
reading.

---

## Round 7 — SPA navigation, and a known gap

`https://www.reddit.com` uses the Navigation API, which is why the shared `../CLAUDE.md`
documents it. Two different things to look at:

- **The click runner does re-arm on in-page navigation.** Navigate between posts without a
  reload; the trace should show a fresh `armed for …` line per URL change.
- **Replay does not.** Reading the code: `onUrlMaybeChanged` calls `arm()` only, so preferences
  are replayed once at document-start and never again for the life of an SPA session. In
  practice the root class usually survives an in-page navigation anyway, so this may be
  harmless — but it is untested and unrecorded, and one measurement settles it. If you have a
  site whose preference is stored *and* whose route changes rewrite the root element, that is
  the case that would break.

---

## Round 8 — interference and the master switch

1. **Both halves on one host.** Pick a host where you have taught a click sequence *and*
   captured preferences. The click runner dispatches synthetic pointer events; those must not
   freeze the preference baseline or set `touched`. Check the trace: the
   `preference baseline frozen at first …` line must appear at the moment **you** clicked, not
   at `+7ms`. This seam failed silently once already and only shows up on a host with both.
2. **Master switch off** (Settings). Reload a host that has both. Expected: the *only* trace
   line is `master switch is OFF — no rule will fire anywhere`, no clicks, no replay. Switch it
   back on.
3. **Other userscripts.** You run at least one other `*://*/*` script (Open Links in New Tab).
   While teaching, watch for a click both scripts act on — the documented failure mode is
   teaching appearing to work while background tabs spray open.
4. **Export / import.** Settings → **Export** copies JSON. Paste it back via **Import** →
   *Merge these rules*; the count should match. Note the importer **rejects a v1 export** by
   design — there is no compatibility path anywhere.
5. **Subdomains.** Tick *Include subdomains* on a rule and confirm it fires on a subdomain
   (e.g. a rule on `wikipedia.org` covering `en.wikipedia.org`).

---

## Round 9 — the local fixtures (optional, and lower value than it looks)

The nine fixtures in `tests/` state their own pass criteria and are the fastest deterministic
signal there is — but every one of them was already driven against this exact script file, and
they load the script themselves via `<script src="../Forget-Me-Not.user.js">` on top of a
`localStorage` GM shim. Running them in your browser therefore adds only "does this work in
Firefox", **not** anything about real GM storage, Violentmonkey injection, containers or network
timing — which is where all the untested surface actually is. Rounds 1–8 are worth more.

**If you do run them, there is a collision to avoid.** With v0.14.0 installed and matching
`*://*/*`, a fixture page runs **two copies** of the script: Violentmonkey's (real GM storage)
and the page's own (shimmed). They have separate rule stores so mostly they ignore each other —
but they share the `__forgetmenot__` postMessage tag, so any teaching test involving
`fixture-iframe.html` will record **duplicate steps**, and the real trace fills with
`localhost` noise.

Turning the master switch off does **not** fix this: the message handler that starts the
recorder is not gated on it. The clean options are:

- **Disable the Forget Me Not script in Violentmonkey** while running fixtures (zero change to
  the script), or
- add `// @exclude http://localhost:8731/*` to the header — a one-line permanent fix, at the
  cost of Forget Me Not never running on your own localhost dev pages. Say the word and I will
  make it.

```bash
python -m http.server 8731
```

Then `http://localhost:8731/tests/fixture-simple.html` and friends. `window.__gsMenu` holds the
menu commands.

---

## Sites, and how confident I am about each

Everything marked *measured today* I checked in a browser on 2026-08-17 from a US IP with no
userscript installed. Everything else is a suggestion to try, not a claim.

| Site | Status | What it exercises |
|---|---|---|
| [en.wikipedia.org/wiki/Cat](https://en.wikipedia.org/wiki/Cat) | **Confirmed** by this project | Rung 1, two root classes, cookie-only persistence, a site that fights back during start-up. The headline target. |
| [squidfunk.github.io/mkdocs-material](https://squidfunk.github.io/mkdocs-material/) | **Measured today** | `body[data-md-color-scheme]` + `ls:/mkdocs-material/.__palette`. Rung 1 **on body** (the deferred path) *and* rung 2 together. |
| [developer.mozilla.org](https://developer.mozilla.org/en-US/docs/Web/CSS) | **Measured today** | The classifier against real telemetry — a UUID `session_id` and a 13-digit timestamp in localStorage. No manual theme control found. |
| [www.jackdaniels.com/en-us](https://www.jackdaniels.com/en-us) | **Measured today** | Age gate + OneTrust banner in one document = two sequences; generated `react-aria` ids; storage empty, cookies only, so capture must decline. |
| [duckduckgo.com](https://duckduckgo.com/?q=test) | **Partly measured** — root classes seen, persistence *not* verified | A deliberately noisy root class list (`dark-bg`, plus six `is-*-exp` A/B classes). Good for "does the diff stay readable". |
| Any **Docusaurus** docs site, e.g. [docusaurus.io](https://docusaurus.io/) | Unverified — the framework's usual pattern is `html[data-theme]` + `ls:theme` | A second, independent rung-1+2 target if MkDocs works. |
| Any **Discourse** forum, e.g. [meta.discourse.org](https://meta.discourse.org/) | Unverified | Anonymous interface-colour toggle; worth one capture to see where it lands. |
| [www.reddit.com](https://www.reddit.com/) | Behaviour documented in `../../CLAUDE.md` | SPA navigation (Navigation API). Round 7. |
| EU news sites (theguardian.com, spiegel.de, heise.de) | Unverified, **and may not show a wall on a US IP** | CMP in a cross-origin iframe → Round 6. Try, but do not force it. |
| Adult sites / dispensary sites | Not checked | You said these are fine for testing. They are the densest source of real age gates; the click-runner rounds apply unchanged. |

**The general procedure for any site you care about** — this is the useful part, because it turns
"is this site in scope?" from my guesswork into your measurement, in about ninety seconds:

1. Open the site, set the preference you want kept.
2. Menu → *remember this site*.
3. Read the panel. **If it offers class or attribute entries, rung 1 applies. If it offers
   `ls` entries, rung 2 applies. If it offers nothing, the site keeps that preference in a
   cookie or on its server, and the click runner is the only option available.**

---

## What I expect to break, in rough order

1. **Re-assertion's `touched` gate** (Round 2, step 12). Inspected, never measured — the test
   tooling could not deliver a trusted click inside the first second of a page load.
2. **First paint against a real network.** Every timing number on record came from localhost,
   where DOMContentLoaded is ~50ms. A cold cache moves everything, and `watchEarlyDrift` is
   bounded at 5 repairs.
3. **The click runner on React-generated markup.** All five click fixtures are hand-written
   markup. `jackdaniels.com` is its first real test.
4. **Replay after SPA navigation** — a known gap, not a bug yet (Round 7).
5. **Real GM storage semantics.** Everything persists as a JSON string, so this should be fine,
   but it is a code path with zero test coverage.

## Reporting a failure

Send: the **saved trace** (it is the whole point), what you saw on screen, and which round.
The one thing to include without being asked is **whether the page looked right** — because the
failure this project keeps hitting is a trace claiming success over a page that plainly did not
work, and only you can see both halves.
