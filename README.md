# GateSkip

A Violentmonkey userscript that dismisses "are you over 18" gates — and the cookie walls,
"continue to site" interstitials and newsletter overlays that work the same way — but only
on sites you have taught it, one at a time.

Nothing is detected, guessed or heuristic. On a site GateSkip has never seen, it does
nothing at all.

## How it works

1. Land on a site that puts a gate in your way.
2. Pick **GateSkip: teach this page** from the Violentmonkey menu.
3. Dismiss the gate exactly the way you normally would — tick the box, click the button.
   Your clicks go through as usual; GateSkip just watches and lists what you clicked.
4. Press **Save**.

From then on, GateSkip makes those same clicks for you, in order, for about fifteen seconds
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

## Scope

Rules are keyed on the hostname of the document the gate is in, with an optional
**include subdomains** toggle.

For a gate inside an embedded player, that hostname is the *player's*, not the page you
were reading — so teaching it once fixes every site that embeds the same player.

## Settings

**GateSkip: settings** in the Violentmonkey menu:

- master on/off switch, and how long to watch after each load
- every rule, its recorded clicks, when it last fired, and per-rule enable / subdomains
- **Test** — looks for a rule's first click on the page behind the dialog (and in every
  frame on it), highlighting it in green if found
- **Recent activity** — what actually fired, so a broken rule is distinguishable from a
  site that simply did not show its gate this time
- Export / import rules as JSON
- **Save trace** — downloads everything GateSkip has narrated recently as a `.txt`, kept
  whether or not debug mode is on. This is the one to send when something does not work:
  debug mode delays every click by five seconds, which is often enough to make a failure
  stop happening, so the trace is the only record of the case that actually breaks.

Nothing appears on the page during normal browsing.

## Debug mode

**GateSkip: debug mode on/off** in the menu (or the red tickbox in Settings). It answers the
one question the script is otherwise structurally unable to answer: when a gate does not
appear on a later visit, was it dismissed, or was it never shown?

With it on:

- Every element GateSkip is about to click gets a **thick pulsing marker and a label**
  naming the step, and is scrolled into view. It then **waits five seconds** before
  clicking, so you can see what it picked and whether that is right.
- A **panel at the bottom left** narrates every decision in the top frame, including the
  negatives — "no rule for this host", "armed for X, watching 15s", "watch window ended and
  step 1 NEVER MATCHED". Lines from an embedded frame are prefixed `⧉ <host>:`. Everything
  also goes to the console, which survives the navigation a closing gate often triggers.
- If the target vanishes mid-countdown, the click is **cancelled**, not fired late.

Turning it off mid-countdown cancels the pending click; the next tick clicks normally.

## Behaviour worth knowing

- **Watching is bounded, and counted from when the page got somewhere.** Fifteen seconds,
  renewed as the document reaches DOM-ready and then fully-loaded, then it stops. Counting
  from the moment parsing began instead meant a gate pulled in by a slow third-party script
  arrived after the window had already closed. On a single-page app the window restarts when
  the URL changes.
- **Every click is checked, and retried if the page ignored it.** A control can be on
  screen, look completely normal and do nothing, because the site attached its handler
  seconds after sending the markup. GateSkip watches for the page actually reacting —
  the element vanishing, a checkbox flipping, a class or a size changing anywhere up its
  ancestor chain — and clicks again if nothing moved, up to eight times over about sixteen
  seconds. The gaps grow, because what it is waiting for is a script that will take as long
  as it takes and gives no signal while it does.
- **Each step says which signal convinced it.** "counted as done — the step stopped
  resolving", or which property changed. A verdict you cannot audit is indistinguishable
  from a wrong one.
- **It says so when a click achieved nothing.** Running out of attempts with no reaction is
  logged as exactly that, rather than as a dismissal. "GateSkip did nothing" and "GateSkip did
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
<https://raw.githubusercontent.com/VitaKaninen/GateSkip/main/GateSkip.user.js> — opening that
URL with Violentmonkey enabled offers the install, and `@updateURL` / `@downloadURL` in the
header keep it updated from then on. A copy loaded from disk has no update URL recorded, so
it never updates; reinstall from the link once to switch it over. Taught rules live in GM
storage and survive a reinstall.
