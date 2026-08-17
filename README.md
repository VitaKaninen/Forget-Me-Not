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

From then on, GateSkip makes those same clicks for you, in order, for about ten seconds
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
  negatives — "no rule for this host", "armed for X, watching 10s", "watch window ended and
  step 1 NEVER MATCHED". Lines from an embedded frame are prefixed `⧉ <host>:`. Everything
  also goes to the console, which survives the navigation a closing gate often triggers.
- If the target vanishes mid-countdown, the click is **cancelled**, not fired late.

Turning it off mid-countdown cancels the pending click; the next tick clicks normally.

## Behaviour worth knowing

- **Watching is bounded.** Ten seconds per navigation, then it stops. On a single-page app
  the window restarts when the URL changes.
- **Every click is checked, and retried if the page ignored it.** A control can be on
  screen, look completely normal and do nothing, because the site attached its handler
  seconds after sending the markup. GateSkip watches for the page actually reacting —
  the element vanishing, a checkbox flipping, a class or a size changing anywhere up its
  ancestor chain — and clicks again, up to four times, if nothing moved.
- **It says so when a click achieved nothing.** Four attempts with no reaction is logged
  as exactly that, rather than as a dismissal. "GateSkip did nothing" and "GateSkip did
  something that had no effect" are different problems and now read differently.
- **A gate that comes back is clicked again**, up to twice, for sites that tear the gate
  down and re-render it.
- **A gate that never goes away is left alone.** Re-clicking there would untick the
  checkbox the first click ticked, so it stops instead.
- **It clicks the button, not the icon inside it.** A click taught on an `<svg>` is sent
  to the surrounding control, since that is usually what the site listens on.

## Tests

`tests/` holds four fixtures — a plain gate, a two-step gate behind a shadow root, a gate
inside an embedded frame, and one whose controls sit inert for two seconds before their
handlers arrive — plus a `GM_*` shim so the script can be loaded by a plain page. Serve the
folder and open them:

```bash
python -m http.server 8731
```

Then visit `http://localhost:8731/tests/fixture-simple.html` and use the browser console;
`window.__gsMenu` holds the menu commands the shim captured.

## Install

The header points `@updateURL` / `@downloadURL` at
`raw.githubusercontent.com/VitaKaninen/GateSkip/main/GateSkip.user.js`, matching the other
scripts in Monkey Scripts. That only resolves once this folder is pushed to that repo with
`main` as its default branch; until then Violentmonkey's update check just 404s and keeps
the installed copy, so installs are still by hand.
