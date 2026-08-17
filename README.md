# Forget Me Not

A Violentmonkey userscript that dismisses "are you over 18" gates — and the cookie walls,
"continue to site" interstitials and newsletter overlays that work the same way — but only
on sites you have taught it, one at a time.

Nothing is detected, guessed or heuristic. On a site Forget Me Not has never seen, it does
nothing at all.

## How it works

1. Land on a site that puts a gate in your way.
2. Pick **Forget Me Not: teach this page** from the Violentmonkey menu.
3. Dismiss the gate exactly the way you normally would — tick the box, click the button.
   Your clicks go through as usual; Forget Me Not just watches and lists what you clicked.
4. Press **Save**.

From then on, Forget Me Not makes those same clicks for you, in order, for about fifteen seconds
after each page load on that site.

Because your clicks are let through rather than intercepted, multi-step gates work: a
confirm button that stays disabled until the checkbox is genuinely ticked is recorded the
same as any other.

## What a rule stores

Each recorded click keeps a CSS selector for the element **and** its visible text, and
both have to match before anything is clicked. That is deliberate: after a site redesign a
rule stops firing rather than clicking whatever inherited the old markup. A rule that has
gone quiet is re-taught in the same four steps as before.

Selectors are built to survive ordinary churn — generated class names (`css-1a2b3c`,
`sc-XyZ`), state classes that are only present while the gate is open (`is-open`,
`active`), and generated ids (`react-aria-42`) are all skipped, and a looser variant
without sibling positions is tried if the exact one fails.

## Remembering preferences

Dismissing gates is one case of a bigger job: holding the site preferences a fresh container
throws away — sidebar closed, dark theme, wide layout — and putting them back without the site
being told anything.

1. Set the site up the way you like it.
2. Pick **Forget Me Not: remember this site** from the Violentmonkey menu.
3. You get a list of everything that changed since the moment before you first touched the
   page, and one question: **which of these did you mean to set?** Preferences arrive ticked.
   Session ids, tokens, timestamps and other things the site wrote for its own purposes arrive
   unticked, each with a one-line reason.
4. Press **Save**, or **Save & reload** to trim the list and check it still works.

Fewer entries is better — keep the smallest set that works. An entry you leave unticked and
that looks like an identifier is remembered only by name: its value is not stored anywhere.

Nothing is ever sent to the site, and **Forget Me Not never writes a cookie**. The values are
kept locally and written back into your own browser before the page loads.

> **Not finished yet (v0.12.0).** Capture and review work; putting the values back on a later
> visit is the next piece of work. Until then this records what you chose and does nothing
> with it.

## Scope

Rules are keyed on the hostname of the document the gate is in, with an optional
**include subdomains** toggle.

For a gate inside an embedded player, that hostname is the *player's*, not the page you
were reading — so teaching it once fixes every site that embeds the same player.

## Settings

**Forget Me Not: settings** in the Violentmonkey menu:

- master on/off switch, and how long to watch after each load
- every rule, its recorded clicks, when it last fired, and per-rule enable / subdomains
- **Prefs** — re-opens the review list for a host, so you can untick, re-tick or forget it
- **Test** — looks for a rule's first click on the page behind the dialog (and in every
  frame on it), highlighting it in green if found
- **Recent activity** — what actually fired, so a broken rule is distinguishable from a
  site that simply did not show its gate this time
- Export / import rules as JSON
- **Save trace** — downloads everything Forget Me Not has narrated recently as a `.txt`.
  This is the one to send when something does not work.

Nothing appears on the page during normal browsing.

## The trace

The trace answers the one question the script is otherwise structurally unable to answer:
when a gate does not appear on a later visit, was it dismissed, or was it never shown?
`Recent activity` records only things that really happened; the trace records **every
decision, including the negatives** — "no rule for this host", "armed for X, watching 15s",
"watch window ended and step 1 NEVER MATCHED", and which signal made a click count as
having worked. Lines from an embedded frame are prefixed `⧉ <host>:`, and each carries
`+NNNNms` since that document started.

It is always on, and that is the point. Version 0.9.0 removed a "debug mode" that marked
the target and waited five seconds before clicking — which delayed every click long enough
that failures stopped happening while you watched, so the case that actually broke was
never the one being observed. It caused three rounds of misdiagnosis before the trace
replaced it. Nothing in this script should ever alter timing in order to explain itself.

## Behaviour worth knowing

- **Watching is bounded, and counted from when the page got somewhere.** Fifteen seconds,
  renewed as the document reaches DOM-ready and then fully-loaded, then it stops. Counting
  from the moment parsing began instead meant a gate pulled in by a slow third-party script
  arrived after the window had already closed. On a single-page app the window restarts when
  the URL changes.
- **Every click is checked, and retried if the page ignored it.** A control can be on
  screen, look completely normal and do nothing, because the site attached its handler
  seconds after sending the markup. Forget Me Not watches for the page actually reacting —
  the element vanishing, a checkbox flipping, a class or a size changing anywhere up its
  ancestor chain — and clicks again if nothing moved, up to eight times over about sixteen
  seconds. The gaps grow, because what it is waiting for is a script that will take as long
  as it takes and gives no signal while it does.
- **Each step says which signal convinced it.** "counted as done — the step stopped
  resolving", or which property changed. A verdict you cannot audit is indistinguishable
  from a wrong one.
- **It says so when a click achieved nothing.** Running out of attempts with no reaction is
  logged as exactly that, rather than as a dismissal. "Forget Me Not did nothing" and "Forget Me Not did
  something that had no effect" are different problems and now read differently.
- **A gate that comes back is clicked again**, up to twice, for sites that tear the gate
  down and re-render it.
- **A gate that never goes away is left alone.** Re-clicking there would untick the
  checkbox the first click ticked, so it stops instead.
- **It clicks the button, not the icon inside it.** A click taught on an `<svg>` is sent
  to the surrounding control, since that is usually what the site listens on. When it cannot
  tell which element the site listens on, the retries work through the possibilities rather
  than repeating one guess.

## Tests

`tests/` holds five fixtures — a plain gate, a two-step gate behind a shadow root, a gate
inside an embedded frame, one whose controls sit inert for two seconds before their
handlers arrive, and one whose gate does not appear until twelve seconds in — plus a `GM_*`
shim so the script can be loaded by a plain page. Serve the folder and open them:

```bash
python -m http.server 8731
```

Then visit `http://localhost:8731/tests/fixture-simple.html` and use the browser console;
`window.__gsMenu` holds the menu commands the shim captured.

## Install

Install from
<https://raw.githubusercontent.com/VitaKaninen/Forget-Me-Not/main/Forget-Me-Not.user.js> — opening that
URL with Violentmonkey enabled offers the install, and `@updateURL` / `@downloadURL` in the
header keep it updated from then on. A copy loaded from disk has no update URL recorded, so
it never updates; reinstall from the link once to switch it over. Taught rules live in GM
storage and survive a reinstall.
