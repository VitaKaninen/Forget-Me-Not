// ==UserScript==
// @name        Forget Me Not
// @namespace   https://github.com/VitaKaninen
// @version     0.8.0
// @author      VitaKaninen
// @description Teach it, once, which clicks dismiss a site's age gate, cookie wall or unwanted panel — then it remembers, and does that for you on every later visit. Nothing is guessed and nothing fires until you have taught it.
// @match       *://*/*
// @grant       GM_setValue
// @grant       GM_getValue
// @grant       GM_deleteValue
// @grant       GM_registerMenuCommand
// @run-at      document-start
// @updateURL   https://raw.githubusercontent.com/VitaKaninen/Forget-Me-Not/main/Forget-Me-Not.user.js
// @downloadURL https://raw.githubusercontent.com/VitaKaninen/Forget-Me-Not/main/Forget-Me-Not.user.js
// ==/UserScript==

// The @updateURL / @downloadURL pair above only resolves once this folder is pushed to
// github.com/VitaKaninen/Forget-Me-Not with `main` as the default branch — same layout as the
// other scripts in Monkey Scripts. Until then Violentmonkey's update check 404s, which is
// harmless (it keeps the installed copy) but means nothing arrives on its own.

(function () {
    'use strict';

    // ---------------- Storage ----------------
    // Rules are keyed by the hostname of the DOCUMENT THE GATE IS IN, which for a gate
    // inside an embedded player is the player's own host, not the page you were reading.
    // That is deliberate: teach the vendor's widget once and every site that embeds it
    // is fixed, and no frame ever has to work out what the top page's hostname is
    // (cross-origin, it cannot).
    const RULES_KEY = 'gs_rules';     // GM: { "<host>": Rule }
    const ON_KEY = 'gs_on';           // GM: false to switch the whole thing off
    const WATCH_KEY = 'gs_watch';     // GM: default watch window, ms
    const LOG_KEY = 'gs_log';         // GM: [{ t, host, m }] — newest first, capped
    const DEBUG_KEY = 'gs_debug';     // GM: true to narrate + delay every click
    const TRACE_KEY = 'gs_trace';     // GM: [line] — the narration, kept whether debug is on or not
    const TEACH_KEY = 'gs_teach';     // sessionStorage (top frame): teaching in progress

    // How long to keep looking. Measured from the last point the page reached, not from
    // document-start — see extendWatch(). A gate that arrives with a vendor script is
    // routinely 10+ seconds after parsing begins, and counting from the earliest possible
    // moment spent the whole budget before the page was even usable.
    const WATCH_DEFAULT = 15000;
    const SETTLE_MS = 150;            // pause after a click before hunting the next step

    // The retry ladder has to outlast the page's own start-up, because the thing it is
    // waiting for — a script attaching a handler to markup that is already on screen —
    // takes as long as it takes and produces no signal of any kind while it happens.
    // A ladder that gave up after 3.5s was the difference between working and not on
    // Wikipedia, whose skins.vector.js binds its panel toggles well after that: the click
    // fired, did nothing, the step was written off, and the remaining ten seconds of the
    // watch window went by with the control sitting right there untouched.
    //
    // Gaps grow so a page that is simply slow is not hammered, and the verify grace grows
    // with them because a busy page can take longer than 450ms to show a reaction.
    const CLICK_TRIES = 8;            // attempts at one step before writing it off
    const RETRY_WAIT = [400, 900, 1800, 3000, 3000, 3000, 3000];
    const VERIFY_WAIT = [450, 600, 800, 1000, 1200, 1200, 1200, 1200];
    const MAX_RESTARTS = 2;           // re-runs allowed when the page replaces the gate
    const LOG_MAX = 120;
    const TRACE_MAX = 600;            // trace lines kept; a few page loads' worth
    // Bump with @version. A trace file that does not say which build produced it is worth
    // much less when it arrives days later.
    const VERSION = '0.8.0';
    const DEBUG_DELAY = 5000;         // debug mode: how long to show the target first

    // Rule shape:
    //   { host, subdomains, enabled, watchMs, steps: [Step], created, lastFired, fires }
    // Step shape:
    //   { path: [{ s, l }], text, tag, label }
    //     path    outermost-first; one entry per shadow-root boundary crossed
    //     s / l   strict selector (with :nth-of-type) and loose one (without)
    //     text    normalized visible text or accessible name — '' when the element has none
    //     label   what to show a human in the settings list

    const readJson = (key, fallback) => {
        try {
            const raw = GM_getValue(key, '');
            if (!raw) return fallback;
            const v = JSON.parse(raw);
            return (v && typeof v === 'object') ? v : fallback;
        } catch (_) { return fallback; }
    };
    const writeJson = (key, val) => { try { GM_setValue(key, JSON.stringify(val)); } catch (_) {} };

    const getRules = () => readJson(RULES_KEY, {});
    const saveRules = (r) => writeJson(RULES_KEY, r);
    const isOn = () => GM_getValue(ON_KEY, true) !== false;
    const isDebug = () => GM_getValue(DEBUG_KEY, false) === true;
    const watchDefault = () => {
        const n = parseInt(GM_getValue(WATCH_KEY, WATCH_DEFAULT), 10);
        return (n > 0 && n <= 120000) ? n : WATCH_DEFAULT;
    };

    function log(m) {
        // A silent script that stops working is indistinguishable from a site that
        // stopped gating, so every fire and every half-finished sequence leaves a trace.
        // Clean "the gate never appeared" is NOT logged: on a site whose cookie is
        // already set that is every single page load, and it would bury the real events.
        try {
            const l = readJson(LOG_KEY, []);
            if (!Array.isArray(l)) return;
            l.unshift({ t: Date.now(), host: location.hostname, m: String(m) });
            writeJson(LOG_KEY, l.slice(0, LOG_MAX));
        } catch (_) {}
    }

    // A rule applies to this document when the host matches exactly, or — with
    // "include subdomains" on — when it is a subdomain of the stored host. Rules are
    // few, so a linear scan beats maintaining a second index.
    function ruleForHost(host) {
        const rules = getRules();
        let best = null;
        for (const key of Object.keys(rules)) {
            const r = rules[key];
            if (!r || r.enabled === false) continue;
            const exact = host === key;
            const sub = r.subdomains && host.endsWith('.' + key);
            if (!exact && !sub) continue;
            // Prefer the most specific match, so a rule taught on the exact host wins
            // over a broad *.example.com one that also covers it.
            if (!best || key.length > best.key.length) best = { key, rule: r };
        }
        return best;
    }

    // ---------------- Utilities ----------------

    // textContent, not innerText: innerText depends on layout, so it is '' for anything
    // not yet rendered and can differ between the moment of teaching (gate visible) and
    // the moment of matching (gate mid-animation). Matching has to be deterministic.
    // Two forms of the same string: the original casing is what a human reads in the
    // settings list ("I am over 18", not "i am over 18"), and the lowercased form is what
    // matching compares — so a site that restyles a button to uppercase does not break
    // the rule.
    function elTextRaw(el) {
        if (!el) return '';
        let t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!t) {
            // `value` only for the input types where it IS the caption. A checkbox's
            // value defaults to the literal string "on", which would be recorded as this
            // step's text and then demand that every candidate also read "on" — a
            // fingerprint that says nothing and narrows everything.
            const captioned = /^(?:submit|button|reset)$/i.test(el.getAttribute('type') || '');
            t = el.getAttribute('aria-label') || el.getAttribute('title') ||
                el.getAttribute('alt') || (captioned ? String(el.value || '') : '') || '';
            t = t.replace(/\s+/g, ' ').trim();
        }
        // A long string is a container's text, not a button's. Treated as "no text",
        // which downgrades this step to selector-only rather than storing a fingerprint
        // that a single word change would break.
        if (t.length > 120) return '';
        return t;
    }
    const elText = (el) => elTextRaw(el).toLowerCase();

    function isVisible(el) {
        if (!el || !el.isConnected) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        let st;
        try { st = getComputedStyle(el); } catch (_) { return false; }
        if (!st || st.visibility === 'hidden' || st.display === 'none') return false;
        if (parseFloat(st.opacity) === 0) return false;
        return true;
    }

    // A real click, not just `dispatchEvent(new MouseEvent('click'))`.
    //
    // `el.click()` is what does the work — it is the only form that toggles a checkbox,
    // forwards a <label> to its input, and submits a form. The pointer/mouse events in
    // front of it are for the frameworks that never listen for 'click' at all and act on
    // mousedown; without them those gates simply do not react. `composed: true` matters
    // for anything inside a shadow root, or the event never leaves it.
    // Real coordinates, not the 0,0 a bare MouseEvent constructor defaults to: a handler
    // that reads clientX/clientY — menus deciding which way to open, anything doing
    // hit-testing of its own — sees a click in the corner of the viewport and can
    // reasonably ignore it.
    function realClick(el) {
        let cx = 0, cy = 0;
        try {
            const r = el.getBoundingClientRect();
            cx = Math.round(r.left + r.width / 2);
            cy = Math.round(r.top + r.height / 2);
        } catch (_) {}
        const base = {
            bubbles: true, cancelable: true, composed: true, view: window,
            clientX: cx, clientY: cy, screenX: cx, screenY: cy, detail: 1, button: 0
        };
        const down = Object.assign({ buttons: 1 }, base);
        const up = Object.assign({ buttons: 0 }, base);
        try {
            if (typeof PointerEvent === 'function') {
                el.dispatchEvent(new PointerEvent('pointerdown', Object.assign({ isPrimary: true, pointerType: 'mouse' }, down)));
            }
            el.dispatchEvent(new MouseEvent('mousedown', down));
            if (typeof PointerEvent === 'function') {
                el.dispatchEvent(new PointerEvent('pointerup', Object.assign({ isPrimary: true, pointerType: 'mouse' }, up)));
            }
            el.dispatchEvent(new MouseEvent('mouseup', up));
        } catch (_) {}
        // `el.click()` is HTMLElement's, so on an SVG node it is simply not there and the
        // call throws — which is exactly the case the fallback dispatch exists for.
        try { el.click(); }
        catch (_) { try { el.dispatchEvent(new MouseEvent('click', up)); } catch (__) {} }
    }

    // Elements that are drawn but never listen: the icon inside the button, not the
    // button. Teaching records what was under the cursor, so an icon-only close control
    // can easily end up recorded as an <svg> or a <path>. The click still bubbles, so it
    // often works anyway — but a site that binds its handler to the button and reads
    // `event.currentTarget` never reacts, and an <svg> has no `.click()` at all.
    const INERT_TAG = /^(?:svg|path|g|use|circle|rect|line|polygon|polyline|ellipse|img|i)$/i;

    // Which element the site listens on is not knowable from here, so the retries are spent
    // working through the possibilities rather than repeating one guess. In order: the
    // nearest element that declares itself a control, the nearest one that merely LOOKS
    // like a control, the node that was actually taught, and its parent.
    //
    // The second of those is the one that matters in practice. A close button built from a
    // <div> with an addEventListener — no role, no tabindex, no onclick attribute — matches
    // nothing in CLICKABLE, and the taught node is then the <path> inside its icon, which
    // has no handler of its own. That case clicked four times and moved nothing.
    //
    // When the taught node is already a real control this list has one entry, so all the
    // attempts land on it — which is the behaviour the timing case needs.
    function clickCandidates(el) {
        const out = [];
        const add = (n) => { if (n && n.nodeType === 1 && out.indexOf(n) === -1) out.push(n); };
        const inert = !!(el && el.tagName && INERT_TAG.test(el.tagName));

        if (inert) {
            let cur = el.parentElement;
            for (let i = 0; i < 5 && cur; i++) {
                let hit = false;
                try { hit = !!(cur.matches && cur.matches(CLICKABLE)); } catch (_) {}
                if (hit) { add(cur); break; }
                cur = cur.parentElement;
            }
            // `cursor` INHERITS, so the <svg> and the <path> inside a cursor:pointer
            // wrapper both report `pointer` themselves. Walking up and taking the first
            // match therefore stops on the icon it was supposed to walk out of — which is
            // exactly the element already known not to work. Only a non-inert node counts.
            cur = el.parentElement;
            for (let i = 0; i < 5 && cur && cur !== document.body; i++) {
                if (!INERT_TAG.test(cur.tagName)) {
                    let st;
                    try { st = getComputedStyle(cur); } catch (_) { st = null; }
                    if (st && st.cursor === 'pointer') { add(cur); break; }
                }
                cur = cur.parentElement;
            }
        }
        add(el);
        if (inert) add(el.parentElement);
        return out;
    }

    // For the debug HUD, so "which of the four did it actually hit" is answerable.
    function descEl(el) {
        if (!el || !el.tagName) return '?';
        const id = el.getAttribute('id');
        const cls = (el.getAttribute('class') || '').trim().split(/\s+/)[0];
        return '<' + el.tagName.toLowerCase() + (id ? '#' + id : (cls ? '.' + cls : '')) + '>';
    }

    // What a click is SUPPOSED to move. A gate button is torn out of the document, a
    // checkbox flips `checked`, a disclosure flips aria-expanded, a panel toggle in page
    // chrome gets a class from its own handler (often on the parent, hence `pcls`) that
    // hides it. If none of this moves, the page did not react.
    //
    // This exists because "clicked it" and "clicked it and something happened" used to be
    // the same thing here, and they are not. Markup is routinely served with its handler
    // attached seconds later — the button is present, visible and completely inert in the
    // meantime — and every click into that window was reported as a dismissal.
    // The ancestor chain is not optional. Which element a toggle's handler marks is
    // entirely up to the site: Wikipedia's panel "hide" button flips a class on the
    // button's immediate parent, while tests/fixture-late.html flips one on the
    // grandparent — and looking one level up caught the first and missed the second,
    // which then ate all four attempts and left the panel toggled back open.
    // Ancestor CLASSES only, and never <body> or <html>.
    //
    // Both exclusions are load-bearing, and getting them wrong is worse than having no
    // check at all — a false positive here means a dead click is recorded as a dismissal
    // and the step is never tried again. Sizes were the first mistake: while a page is
    // still laying out, every ancestor box is changing anyway, so any click during load
    // "worked". <body> and <html> were the second: MediaWiki rewrites the root element's
    // class list all through start-up (client-js, vector-feature-*, mw-ready), so a click
    // on Wikipedia during load always found something moving. That is exactly the window
    // a click fires in when debug is off, which is why it "only worked with debug on" —
    // the five second delay pushed the click past the noise.
    function ancestry(el) {
        const out = [];
        let cur = el && el.parentElement;
        for (let i = 0; i < 5 && cur && cur.nodeType === 1; i++) {
            if (cur === document.body || cur === document.documentElement) break;
            out.push(cur.getAttribute('class') || '');
            cur = cur.parentElement;
        }
        return out.join('\n');
    }

    // "Did the element's own box change size?" was the LAST of the three over-generous
    // signals, and the one that survived v0.6.0 (2026-08-17). A control's box moves for
    // reasons that have nothing to do with being clicked — a web font swapping in, a
    // stylesheet finishing, an icon decoding — and all of those happen in the first few
    // hundred milliseconds, which is exactly when the first click is fired and judged.
    // So the verdict came back "'size' changed", the dead click was recorded as a
    // dismissal, and the step was written off while the control sat there working.
    //
    // This is what made the bug look like a state bug rather than a timing one: on a
    // RELOAD the font is already cached, the box never moves, the retries run, and it
    // works. First visit on a fresh tab is the only load that has the noise in it.
    //
    // What survives is the part that was actually meant: a control COLLAPSING is a
    // consequence. Growing by eight pixels is not. Reproduce with
    // tests/fixture-late.html?wire=8000&grow=1 — v0.6.0 logs "dismissed the gate
    // (1 click)" at +606ms with the panel still open.
    function clickState(el) {
        let collapsed = false;
        try {
            const r = el.getBoundingClientRect();
            collapsed = (r.width < 1 || r.height < 1);
        } catch (_) {}
        return {
            gone: !el || !el.isConnected,
            vis: isVisible(el),
            checked: !!(el && el.checked),
            disabled: !!(el && el.disabled),
            expanded: (el && el.getAttribute('aria-expanded')) || '',
            pressed: (el && el.getAttribute('aria-pressed')) || '',
            selected: (el && el.getAttribute('aria-selected')) || '',
            ahidden: (el && el.getAttribute('aria-hidden')) || '',
            // Collapsing, not resizing — see above.
            collapsed: collapsed,
            cls: (el && el.getAttribute('class')) || '',
            anc: el ? ancestry(el) : '',
            url: location.href
        };
    }
    // Returns the name of the field that moved, so the trace can say WHY a step was
    // counted as done. Without that, a wrong verdict is indistinguishable from a right
    // one in the log, which cost this project three rounds of misdiagnosis.
    function whatMoved(a, b) {
        for (const k in a) if (a[k] !== b[k]) return k;
        return '';
    }

    const esc = (s) => (window.CSS && CSS.escape) ? CSS.escape(s) : String(s).replace(/[^\w-]/g, '\\$&');

    // ---------------- Selector building ----------------

    // Class tokens that are generated, not authored: CSS-modules and styled-components
    // hashes, and anything that is mostly a hex blob. Pinning one of these makes a rule
    // that dies at the site's next deploy, with no visible cause.
    const RANDOM_CLASS = /^(?:css|sc|jsx|emotion|svelte|tw|makeStyles)-|^[a-z]?[0-9a-f]{6,}$|[_-][0-9a-z]{6,}$/i;
    // Class tokens that describe a MOMENT rather than a thing. They are present exactly
    // when the gate is open — i.e. at teach time — and pinning one means the selector
    // only matches while the state it names happens to hold.
    const STATE_CLASS = /^(?:is-|has-|js-|ui-)?(?:active|open|opened|show|shown|showing|visible|hidden|invisible|selected|checked|current|focus|focused|hover|hovered|disabled|enabled|expanded|collapsed|loading|loaded|ready|animating|entered|entering|exiting)$/i;

    function goodClasses(el) {
        return (el.getAttribute('class') || '').trim().split(/\s+/)
            .filter(Boolean)
            .filter(c => !RANDOM_CLASS.test(c) && !STATE_CLASS.test(c) && c.length <= 40)
            .sort()
            .slice(0, 3);
    }

    // ids are the best anchor there is, when they are real. A generated one (react-aria
    // "react-aria-42", Radix "radix-:r3:", anything ending in a run of digits that looks
    // like a counter) changes on every render, so it is worse than no anchor at all.
    const RANDOM_ID = /^(?:react|radix|mui|headlessui|aria|ember|ng|:r)[-:]|[-_:]\d{3,}$|^[0-9a-f]{8,}$/i;
    const stableId = (el) => {
        const id = el.getAttribute('id');
        return (id && id.length <= 60 && !RANDOM_ID.test(id) && !/\s/.test(id)) ? id : null;
    };

    const ANCHOR_ATTRS = ['data-testid', 'data-test', 'data-test-id', 'data-qa', 'data-cy',
        'data-action', 'data-role', 'name', 'aria-label', 'type', 'role'];

    // One level of the selector, in two strengths. `s` pins the element's position among
    // same-tag siblings; `l` does not, so a rule survives a row being added above the
    // one it was taught on. Resolution tries `s` first and falls back to `l`.
    function levelSel(el) {
        const id = stableId(el);
        if (id) return { s: '#' + esc(id), l: '#' + esc(id), anchor: true };

        const tag = el.tagName.toLowerCase();
        let base = tag;
        for (const attr of ANCHOR_ATTRS) {
            const v = el.getAttribute(attr);
            if (v && v.length <= 60 && !RANDOM_CLASS.test(v)) {
                base += '[' + attr + '="' + v.replace(/["\\]/g, '\\$&') + '"]';
                break;
            }
        }
        for (const c of goodClasses(el)) base += '.' + esc(c);

        let nth = '';
        const p = el.parentElement;
        if (p) {
            const sibs = Array.from(p.children).filter(x => x.tagName === el.tagName);
            if (sibs.length > 1) nth = ':nth-of-type(' + (sibs.indexOf(el) + 1) + ')';
        }
        return { s: base + nth, l: base, anchor: false };
    }

    // Climb from the element until the accumulated selector is specific enough within
    // this root. "Specific enough" is deliberately not "unique": the stored text does
    // the final discriminating, so stopping at a handful of matches keeps the selector
    // short — and a short selector is a selector with fewer ancestors that can be
    // reshuffled by a redesign.
    function pathInRoot(el, root) {
        const strict = [], loose = [];
        let cur = el;
        for (let depth = 0; depth < 8 && cur && cur.nodeType === 1 && cur !== root; depth++) {
            const lvl = levelSel(cur);
            strict.unshift(lvl.s);
            loose.unshift(lvl.l);
            const s = strict.join(' > ');
            if (lvl.anchor) break;
            let hits;
            try { hits = root.querySelectorAll(s); } catch (_) { hits = null; }
            if (hits && hits.length <= 4 && Array.prototype.indexOf.call(hits, el) !== -1) break;
            cur = cur.parentElement;
        }
        return { s: strict.join(' > '), l: loose.join(' > ') };
    }

    // The full path, one entry per document/shadow-root the element sits behind. Built
    // outermost-first so resolution can walk it left to right, hopping into each host's
    // shadowRoot as it goes. Closed shadow roots have no `.shadowRoot` for anyone, so
    // they are simply out of reach — nothing to do about that here.
    function buildPath(el) {
        const path = [];
        let node = el;
        for (let depth = 0; depth < 6 && node; depth++) {
            const root = node.getRootNode ? node.getRootNode() : document;
            path.unshift(pathInRoot(node, root));
            if (!root || root.nodeType !== 11 || !root.host) break;   // 11 = ShadowRoot
            node = root.host;
        }
        return path;
    }

    function describe(el) {
        const raw = elTextRaw(el);
        const tag = el.tagName.toLowerCase();
        return {
            path: buildPath(el),
            text: raw.toLowerCase(),
            tag,
            label: raw ? (tag + ' — “' + raw.slice(0, 48) + '”') : (tag + ' (no text)')
        };
    }

    // ---------------- Selector resolution ----------------

    function queryAll(ctx, sel) {
        if (!sel) return [];
        try { return Array.from(ctx.querySelectorAll(sel)); } catch (_) { return []; }
    }

    function resolveStep(step) {
        if (!step || !step.path || !step.path.length) return null;
        for (const variant of ['s', 'l']) {
            let ctx = document, found = null;
            for (let i = 0; i < step.path.length; i++) {
                const cands = queryAll(ctx, step.path[i][variant]);
                if (!cands.length) { found = null; break; }
                if (i < step.path.length - 1) {
                    // An intermediate segment names a shadow HOST; only a candidate that
                    // actually has an open shadow root can carry the walk forward.
                    const host = cands.find(c => c.shadowRoot);
                    if (!host) { found = null; break; }
                    ctx = host.shadowRoot;
                } else {
                    let list = cands;
                    // Both must match. Text is what stops a rule from clicking some
                    // unrelated button that inherited the old one's markup after a
                    // redesign — the rule going quiet is the intended failure mode.
                    if (step.text) list = list.filter(c => elText(c) === step.text);
                    found = list.find(isVisible) || null;
                    if (found) return found;
                }
            }
            if (found) return found;
        }
        return null;
    }

    // ---------------- Runner ----------------

    let run = null;        // { rule, key, idx, deadline, obs, timer, settleUntil }
    let armedUrl = null;   // the URL the current watch window belongs to

    function disarm() {
        if (!run) return;
        try { if (run.obs) run.obs.disconnect(); } catch (_) {}
        try { if (run.timer) clearInterval(run.timer); } catch (_) {}
        if (run.debug) hlClear();
        run = null;
    }

    // A click is not an outcome. Every click is followed by a look at whether the page
    // moved at all, and a step is only counted as done once something did — see
    // clickState() for what counts. Three states, in order: fire, wait, check.
    function fireClick(v, now) {
        // Cycled, not clamped: with one candidate every attempt repeats it, which is what a
        // control that is merely not wired up yet needs, and with several the extra attempts
        // come back round to the first.
        v.hit = v.cands[(v.tries - 1) % v.cands.length] || v.el;
        v.before = clickState(v.hit);
        v.phase = 'check';
        const grace = VERIFY_WAIT[Math.min(v.tries - 1, VERIFY_WAIT.length - 1)];
        v.at = now + grace;
        run.settleUntil = now + grace;
        // A retry cycle must not be cut short by the watch window closing under it.
        run.deadline = Math.max(run.deadline, now + grace + 4000);
        realClick(v.hit);
        // readyState is worth saying out loud: a click that lands while the document is
        // still 'loading' or 'interactive' is the one most likely to hit markup whose
        // handler has not been attached yet, and that is invisible from anywhere else.
        dbg('clicked step ' + (run.idx + 1) + ' of ' + run.rule.steps.length +
            ' [doc ' + document.readyState + ']' +
            (v.max > 1 ? ' (attempt ' + v.tries + ' of ' + v.max + ')' : '') +
            (v.hit !== v.el ? ' — on ' + descEl(v.hit) + ' around the ' + descEl(v.el) + ' taught'
                            : (v.cands.length > 1 ? ' — on the ' + descEl(v.el) + ' taught' : '')));
    }

    function beginClick(el, now) {
        const cands = clickCandidates(el);
        run.verify = {
            el, cands, hit: null, before: null, tries: 1, phase: 'check', at: 0,
            // Every candidate gets at least one go, plus a repeat of the first.
            max: Math.max(CLICK_TRIES, cands.length + 1)
        };
        if (cands.length > 1) {
            dbg('step ' + (run.idx + 1) + ': the element taught is ' + descEl(el) +
                ', which nothing listens on by itself — will try ' +
                cands.map(descEl).join(', then '));
        }
        fireClick(run.verify, now);
    }

    // Called once the click is known to have landed, so the bookkeeping that says "this
    // step is behind us" happens exactly where that becomes true.
    function commitClick(now) {
        const v = run.verify;
        run.verify = null;
        run.clicked.push(v.el);
        if (v.hit && v.hit !== v.el) run.clicked.push(v.hit);
        run.idx++;
        run.settleUntil = now + SETTLE_MS;

        // The restart test further down asks whether step 1 stopped resolving and then
        // started resolving again, because a page that detaches and re-attaches the SAME
        // node cannot be caught by node identity. That vanish now happens during the
        // verify window — before run.done is ever set — so unless it is recorded here it
        // is simply lost, and the gate coming back reads as a gate that never left.
        // Introduced by the verify/retry cycle; the old code clicked and completed in one
        // step, so the done-branch always saw it.
        if (!resolveStep(run.rule.steps[0])) run.vanished = true;

        if (run.idx >= run.rule.steps.length) {
            run.done = true;
            const rules = getRules();
            if (rules[run.key]) {
                rules[run.key].lastFired = Date.now();
                rules[run.key].fires = (rules[run.key].fires || 0) + 1;
                saveRules(rules);
            }
            const n = run.rule.steps.length;
            log(run.noop
                ? ('ran all ' + n + (n === 1 ? ' click' : ' clicks') +
                   ', but at least one of them changed nothing on the page')
                : ('dismissed the gate (' + n + (n === 1 ? ' click)' : ' clicks)')));
            dbg('sequence complete — still watching until the window ends, in case the page puts the gate back');
            // Not disarmed — the window stays open for the re-render case below. The
            // deadline is what ends it.
        }
    }

    function tick() {
        // `recording` and not just `teaching`: in a FRAME being taught, `teaching` is
        // false (the popup and its state live only in the top frame), so gating on that
        // alone would let an already-taught rule auto-click the very gate being recorded.
        if (!run || teaching || recording) return;
        const now = Date.now();
        if (now < run.settleUntil) return;

        // Debug mode: a click is already lined up and being shown. Nothing else may
        // happen until it fires or its target goes away — re-hunting mid-countdown would
        // move the marker off the thing the countdown is about.
        if (run.pending) {
            const p = run.pending;
            if (!p.el.isConnected || !isVisible(p.el)) {
                dbg('target for step ' + (run.idx + 1) + ' disappeared during the countdown — not clicking, looking again');
                hlClear();
                run.pending = null;
                return;
            }
            const left = p.at - now;
            if (left > 0) {
                const secs = Math.ceil(left / 1000);
                if (secs !== p.shown) {
                    p.shown = secs;
                    p.hl.setLabel(p.head + ' — clicking in ' + secs + 's');
                }
                return;
            }
            p.hl.setColor('#a6e3a1');
            p.hl.stopPulse();
            p.hl.setLabel(p.head + ' — CLICKED');
            run.pending = null;
            run.mark = p.hl;   // kept so the verdict can be written into the same label
            beginClick(p.el, now);
            return;
        }

        // A click has been made and is being judged. Nothing else may run until it is
        // settled, or a step that quietly did nothing would be followed by a hunt for the
        // next one — which is how a rule used to report success having achieved nothing.
        if (run.verify) {
            const v = run.verify;
            if (now < v.at) return;

            if (v.phase === 'wait') {
                // Re-resolve rather than reusing the node: between attempts the page may
                // have re-rendered the control, and clicking a detached copy of it is a
                // guaranteed no-op that would burn the remaining attempts.
                const fresh = resolveStep(run.rule.steps[run.idx]);
                if (!fresh) {
                    dbg('step ' + (run.idx + 1) + ' went away before the retry — taking that as the click having worked');
                    commitClick(now);
                    return;
                }
                if (fresh !== v.el) { v.el = fresh; v.cands = clickCandidates(fresh); }
                fireClick(v, now);
                return;
            }

            // Two independent signs of life: the element moved, or the step stopped
            // resolving (whole-subtree teardown leaves the measured node detached, and a
            // detached node's parent class tells you nothing).
            const moved = whatMoved(v.before, clickState(v.hit));
            const stillThere = resolveStep(run.rule.steps[run.idx]);
            if (moved || !stillThere) {
                dbg('step ' + (run.idx + 1) + ' counted as done — ' +
                    (!stillThere ? 'the step stopped resolving' : "'" + moved + "' changed") +
                    ' [doc ' + document.readyState + ']');
                if (run.mark) { try { run.mark.setLabel('Forget Me Not: click worked'); } catch (_) {} run.mark = null; }
                commitClick(now);
                return;
            }

            if (v.tries >= v.max) {
                run.noop = true;
                log('step ' + (run.idx + 1) + ' of ' + run.rule.steps.length +
                    ' was clicked ' + v.max + ' times (' + v.cands.map(descEl).join(', ') +
                    ') and the page never reacted — re-teaching this step will record a better target');
                dbg('step ' + (run.idx + 1) + ': ' + v.max + ' clicks across ' +
                    v.cands.map(descEl).join(', ') + ' and nothing moved on the page at all' +
                    ' — giving up on this step; re-teach it to record a better target');
                if (run.mark) {
                    try {
                        run.mark.setColor('#f9e2af');
                        run.mark.setLabel('Forget Me Not: clicked ' + v.max + '× — the page did not react');
                    } catch (_) {}
                    run.mark = null;
                }
                commitClick(now);
                return;
            }

            const wait = RETRY_WAIT[Math.min(v.tries - 1, RETRY_WAIT.length - 1)];
            v.tries++;
            v.phase = 'wait';
            v.at = now + wait;
            run.settleUntil = now + wait;
            run.deadline = Math.max(run.deadline, now + wait + VERIFY_WAIT[VERIFY_WAIT.length - 1] + 4000);
            dbg('step ' + (run.idx + 1) + ': nothing on the page changed — attempt ' + v.tries +
                ' of ' + v.max + ' in ' + wait + 'ms');
            if (run.mark) { try { run.mark.setColor('#f9e2af'); run.mark.setLabel('Forget Me Not: no reaction — retrying'); } catch (_) {} }
            return;
        }

        if (now > run.deadline) {
            // Half-done is the interesting case: the gate was there and the first clicks
            // landed, so the rule is real but no longer complete. Silence there would be
            // exactly the "did it break or was there no gate?" ambiguity worth avoiding.
            if (!run.done && run.idx > 0) {
                log('gave up after step ' + run.idx + ' of ' + run.rule.steps.length +
                    ' — the rest of the sequence never appeared');
            }
            // The single most useful line in debug mode. If the gate did not show up on
            // this visit, this says so explicitly, which is what separates "Forget Me Not
            // dismissed it" from "the site did not gate you this time".
            dbg(run.done
                ? 'watch window ended — the sequence had run'
                : (run.idx > 0
                    ? 'watch window ended after step ' + run.idx + ' of ' + run.rule.steps.length + ' — the rest never appeared'
                    : 'watch window ended and step 1 NEVER MATCHED — no gate was found on this page, so nothing here was clicked by Forget Me Not'));
            disarm();
            return;
        }
        // Finished the sequence once, but the window is still open, because a click can
        // land on markup the page has not wired up yet. A server-rendered gate that a
        // framework then hydrates (or re-renders) is in the DOM, and clickable, well
        // before its handler exists: the click does nothing, the rule counts itself done,
        // and the gate the user actually sees is never touched. Caught by
        // tests/fixture-simple.html, whose gate is in the served HTML and re-attached
        // 400ms later — Forget Me Not reported success while the overlay was still up.
        //
        // The restart condition is "the gate went away and came back", plus the weaker
        // "step 1 now resolves to a node we never clicked". Both are needed and neither
        // alone is enough: a framework re-render swaps the node, but plenty of sites
        // (and tests/fixture-simple.html) detach and re-attach the SAME node, where node
        // identity says nothing.
        //
        // What it deliberately will NOT do is re-click a gate that simply stayed on
        // screen. That is the case where a second click is actively harmful — on a
        // checkbox step it would untick what the first click ticked — and a gate that
        // never disappears is a rule that is wrong, not a rule that should try harder.
        if (run.done) {
            if (run.restarts >= MAX_RESTARTS) return;
            const first = resolveStep(run.rule.steps[0]);
            if (!first) { run.vanished = true; return; }
            if (!run.vanished && run.clicked.indexOf(first) !== -1) return;
            run.restarts++;
            run.vanished = false;
            run.idx = 0;
            run.done = false;
            run.noop = false;   // a fresh run gets to be judged on its own clicks
            run.clicked.length = 0;
            log('the page replaced the gate — running the sequence again');
            dbg('the page put the gate back — running the sequence again (restart ' + run.restarts + ')');
        }

        const step = run.rule.steps[run.idx];
        const el = resolveStep(step);
        if (!el || run.clicked.indexOf(el) !== -1) return;

        if (run.debug) {
            const head = 'Forget Me Not step ' + (run.idx + 1) + '/' + run.rule.steps.length + ': ' + step.label;
            hlClear();
            run.pending = {
                el, head, shown: -1,
                at: now + DEBUG_DELAY,
                hl: hlPaint(el, '#f38ba8', head + ' — clicking in ' + (DEBUG_DELAY / 1000) + 's', true)
            };
            // The countdown must not be able to outlive the window it is running inside.
            run.deadline = Math.max(run.deadline, now + DEBUG_DELAY + 3000);
            dbg('MATCHED step ' + (run.idx + 1) + '/' + run.rule.steps.length + ' → ' + step.label +
                ' — marked on the page, clicking in ' + (DEBUG_DELAY / 1000) + 's');
            try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
            return;
        }

        beginClick(el, now);
    }

    // A MutationObserver alone misses a gate that is already in the DOM before we start
    // observing, and an interval alone can idle through the one frame the gate exists
    // in. Both, cheaply, for a bounded window.
    // ONE watch window per URL, not per lifecycle event. Hunting starts at
    // document-start (so a server-rendered gate can be gone before first paint) and
    // `boot()` calls arm() again once the DOM is ready; without this guard that second
    // call opened a fresh window, and a gate that is torn down and re-shown during load
    // — which is exactly what a "flash of gate then re-render" site does — got clicked
    // by both. Measured on tests/fixture-simple.html: fires: 2 for one page load.
    // `force` is for the settings screen, where a rule really has changed.
    function arm(force) {
        if (!force && armedUrl === location.href) return;
        disarm();
        armedUrl = location.href;
        if (!isOn()) {
            if (isTop) dbg('master switch is OFF — no rule will fire anywhere');
            return;
        }
        const hit = ruleForHost(location.hostname);
        if (!hit || !hit.rule.steps || !hit.rule.steps.length) {
            // Only the top frame says this. Every ad and analytics frame on the page
            // would otherwise report its own "no rule", burying the one line that matters.
            if (isTop) dbg('no rule for ' + location.hostname + ' — Forget Me Not is doing nothing on this page');
            return;
        }

        const watchMs = (hit.rule.watchMs > 0) ? hit.rule.watchMs : watchDefault();
        run = {
            rule: hit.rule, key: hit.key, idx: 0, done: false, clicked: [], restarts: 0, vanished: false,
            deadline: Date.now() + watchMs, settleUntil: 0, obs: null, timer: null,
            // verify: the click currently being judged. noop: at least one step was
            // clicked to exhaustion without the page reacting, which changes what the
            // completion line is allowed to claim.
            verify: null, noop: false, mark: null,
            // Latched for the life of the window: toggling debug mid-countdown would
            // otherwise strand a pending click that nothing is left to fire.
            debug: isDebug(), pending: null
        };
        dbg('armed for ' + hit.key + ' (' + hit.rule.steps.length +
            (hit.rule.steps.length === 1 ? ' step' : ' steps') + '), watching ' +
            Math.round(watchMs / 1000) + 's — fired ' + (hit.rule.fires || 0) + ' time(s) before');
        run.timer = setInterval(tick, 200);
        try {
            run.obs = new MutationObserver(tick);
            run.obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
        } catch (_) {}
        tick();
    }

    // The watch window is "N seconds after the page got somewhere", not "N seconds after
    // the browser started parsing". Hunting still begins at document-start — that is what
    // catches a server-rendered gate before first paint — but the budget is renewed as the
    // document reaches DOMContentLoaded and then load, because a gate injected by a script
    // that is itself still downloading cannot appear until well after parsing began.
    //
    // Without this, a site whose gate arrived at ~12s was never touched on a normal visit,
    // while opening Settings or toggling debug made it fire instantly — those call
    // arm(true), which opened a fresh window with the gate already on screen. The rule was
    // fine; it was being asked to watch during the wrong ten seconds.
    function extendWatch(why) {
        if (!run || run.done) return;
        const ms = (run.rule.watchMs > 0) ? run.rule.watchMs : watchDefault();
        const until = Date.now() + ms;
        if (until <= run.deadline) return;
        run.deadline = until;
        dbg('page reached ' + why + ' — watching ' + Math.round(ms / 1000) + 's more from here');
    }

    // ---------------- SPA navigation ----------------
    // A gate can reappear after an in-page navigation with no document load at all, so
    // the watch window is restarted per URL change rather than per page load. Still
    // bounded each time — nothing observes forever.
    let lastUrl = location.href;
    function onUrlMaybeChanged() {
        if (location.href === lastUrl) return;
        lastUrl = location.href;
        arm();
    }
    function watchNavigation() {
        try {
            if (window.navigation && window.navigation.addEventListener) {
                window.navigation.addEventListener('navigatesuccess', onUrlMaybeChanged);
            }
        } catch (_) {}
        window.addEventListener('popstate', onUrlMaybeChanged);
        window.addEventListener('hashchange', onUrlMaybeChanged);
        for (const m of ['pushState', 'replaceState']) {
            try {
                const orig = history[m];
                history[m] = function () {
                    const r = orig.apply(this, arguments);
                    setTimeout(onUrlMaybeChanged, 0);
                    return r;
                };
            } catch (_) {}
        }
    }

    // ---------------- Highlight layer ----------------
    // Drawn in a separate fixed-position overlay inside a shadow root rather than by
    // restyling the element: sites override outline/background with !important, and an
    // `overflow: hidden` ancestor clips an outline down to two edges. Boxes in viewport
    // coordinates are re-measured on scroll, so they stay put inside independently
    // scrolling containers too.
    let hlLayer = null, hlRoot = null, hlQueued = false;
    const hlEntries = [];

    function hlEnsure() {
        if (hlLayer && hlLayer.isConnected) return;
        hlLayer = document.createElement('div');
        hlLayer.id = 'gs-hl';
        hlLayer.style.cssText = 'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0;' +
            'z-index: 2147483640; pointer-events: none;';
        hlRoot = hlLayer.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = ':host { all: initial; }' +
            '.b { position: fixed; box-sizing: border-box; pointer-events: none;' +
            ' border: 2px solid var(--c); border-radius: 4px;' +
            ' box-shadow: 0 0 0 1px rgba(0,0,0,0.85), 0 0 0 3px rgba(255,255,255,0.55), 0 0 10px 2px var(--c); }' +
            // The debug marker has to be impossible to miss on a page you have never
            // seen before, over markup of any colour — hence the width, the pulse, and
            // a label that names the step rather than just drawing a box.
            '.big { border-width: 6px; border-radius: 6px; animation: gs-pulse .7s ease-in-out infinite alternate; }' +
            '@keyframes gs-pulse { from { box-shadow: 0 0 0 2px rgba(0,0,0,0.9), 0 0 0 6px rgba(255,255,255,0.7), 0 0 14px 4px var(--c); }' +
            ' to { box-shadow: 0 0 0 2px rgba(0,0,0,0.9), 0 0 0 12px rgba(255,255,255,0.25), 0 0 34px 12px var(--c); } }' +
            '.l { position: fixed; pointer-events: none; max-width: 60vw; color: #11111b;' +
            ' font: 700 14px/1.3 system-ui, sans-serif; padding: 4px 9px; border-radius: 6px;' +
            ' white-space: pre; overflow: hidden; text-overflow: ellipsis;' +
            ' box-shadow: 0 3px 12px rgba(0,0,0,0.7); }';
        hlRoot.appendChild(st);
        (document.body || document.documentElement).appendChild(hlLayer);
        window.addEventListener('scroll', hlQueue, { passive: true, capture: true });
        window.addEventListener('resize', hlQueue, { passive: true });
    }
    function hlQueue() {
        if (hlQueued) return;
        hlQueued = true;
        requestAnimationFrame(() => { hlQueued = false; hlDraw(); });
    }
    function hlDraw() {
        for (const e of hlEntries) {
            const gone = !e.el || !e.el.isConnected;
            const r = gone ? null : e.el.getBoundingClientRect();
            if (gone || (r.width < 1 && r.height < 1)) {
                e.box.style.display = 'none';
                if (e.lab) e.lab.style.display = 'none';
                continue;
            }
            e.box.style.display = '';
            e.box.style.left = (r.left - 3) + 'px';
            e.box.style.top = (r.top - 3) + 'px';
            e.box.style.width = (r.width + 6) + 'px';
            e.box.style.height = (r.height + 6) + 'px';
            if (e.lab) {
                // Above the target, unless the target is against the top of the viewport
                // — a label drawn off-screen is the same as no label. The right edge
                // needs the same treatment and did not have it: a control in the top
                // right corner of a page (page chrome very often is) put its label
                // straight off the side of the window, where the one line explaining what
                // was about to be clicked could not be read at all.
                e.lab.style.display = '';
                e.lab.style.top = (r.top > 34 ? (r.top - 32) : (r.bottom + 8)) + 'px';
                e.lab.style.left = '0px';
                const w = e.lab.getBoundingClientRect().width || 0;
                const max = Math.max(4, (window.innerWidth || 0) - w - 6);
                e.lab.style.left = Math.min(max, Math.max(4, r.left - 3)) + 'px';
            }
        }
    }
    // Returns a handle so a countdown can be retitled in place rather than by tearing the
    // marker down and rebuilding it, which would restart the pulse every second.
    function hlPaint(el, color, label, big) {
        if (!el) return null;
        hlEnsure();
        const c = color || '#a6e3a1';
        const box = document.createElement('div');
        box.className = big ? 'b big' : 'b';
        box.style.setProperty('--c', c);
        box.style.backgroundColor = c + '30';
        hlRoot.appendChild(box);
        let lab = null;
        if (label != null) {
            lab = document.createElement('div');
            lab.className = 'l';
            lab.style.background = c;
            lab.textContent = label;
            hlRoot.appendChild(lab);
        }
        hlEntries.push({ el, box, lab });
        hlDraw();
        return {
            setLabel(t) { if (lab) lab.textContent = t; hlDraw(); },
            setColor(nc) {
                box.style.setProperty('--c', nc);
                box.style.backgroundColor = nc + '30';
                if (lab) lab.style.background = nc;
            },
            stopPulse() { box.className = 'b'; }
        };
    }
    function hlClear() {
        for (const e of hlEntries) { e.box.remove(); if (e.lab) e.lab.remove(); }
        hlEntries.length = 0;
    }

    // ---------------- Debug HUD ----------------
    // Debug mode exists to answer one question that the script is otherwise structurally
    // unable to answer: when a gate does not appear on a later visit, was it dismissed,
    // or was it never shown? Normal operation is deliberately silent and logs only real
    // events, so "Forget Me Not did nothing" and "Forget Me Not found nothing" look identical from
    // the outside. In debug mode every decision is narrated, including the negative ones,
    // and no click happens until the target has been on screen for DEBUG_DELAY with a
    // marker on it — so what it was about to do is visible even when it is wrong.
    //
    // The HUD lives only in the top frame; frames relay their lines to it, because a gate
    // in an embedded player may be in a frame too small to read anything in.
    let hud = null, hudBody = null;
    const HUD_MAX = 40;

    function hudEnsure() {
        if (hud && hud.isConnected) return;
        hud = document.createElement('div');
        hud.id = 'gs-hud';
        hud.style.cssText = 'all: initial;';
        const root = hud.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(st);

        const wrap = document.createElement('div');
        wrap.style.cssText = `
            position: fixed; bottom: 12px; left: 12px; z-index: 2147483645;
            width: 460px; max-width: 92vw; background: #11111b; color: #cdd6f4;
            border: 2px solid #f38ba8; border-radius: 10px; padding: 8px 10px;
            font: 12px/1.45 ui-monospace, Consolas, monospace;
            box-shadow: 0 8px 30px rgba(0,0,0,0.7); display: flex; flex-direction: column; gap: 6px;
        `;
        const head = document.createElement('div');
        head.style.cssText = 'display: flex; align-items: center; gap: 8px;';
        const title = document.createElement('span');
        title.style.cssText = 'flex: 1; font-weight: 700; color: #f38ba8;';
        title.textContent = 'Forget Me Not — DEBUG (clicks delayed ' + (DEBUG_DELAY / 1000) + 's)';
        const off = document.createElement('button');
        off.textContent = 'Debug off';
        off.style.cssText = 'border: none; border-radius: 6px; padding: 3px 8px; cursor: pointer;' +
            'font: 700 11px system-ui, sans-serif; background: #45475a; color: #cdd6f4;';
        // Turning debug off mid-countdown cancels the pending click rather than firing it
        // early: with run.debug clear, the next tick re-resolves the same step and clicks
        // it immediately, which is exactly normal behaviour resuming.
        off.addEventListener('click', () => {
            GM_setValue(DEBUG_KEY, false);
            hudKill();
            if (run) { run.debug = false; run.pending = null; hlClear(); }
        });
        const hide = document.createElement('button');
        hide.textContent = 'Hide';
        hide.style.cssText = off.style.cssText;
        hide.addEventListener('click', hudKill);
        head.append(title, hide, off);

        hudBody = document.createElement('div');
        hudBody.style.cssText = 'display: flex; flex-direction: column; gap: 1px;' +
            'max-height: 34vh; overflow: auto; word-break: break-word;';

        wrap.append(head, hudBody);
        root.appendChild(wrap);
        document.documentElement.appendChild(hud);
    }
    function hudKill() {
        if (hud) { hud.remove(); hud = null; hudBody = null; }
    }
    // `frame` is flagged explicitly rather than inferred from the hostname: a frame on
    // the SAME host as the page is the case where its lines are otherwise indistinguishable
    // from the top frame's, and "armed … never matched" appearing twice with no way to
    // tell which document meant which is worse than no line at all.
    function hudLine(host, m, frame) {
        hudEnsure();
        const line = document.createElement('div');
        const d = new Date();
        const stamp = String(d.getMinutes()).padStart(2, '0') + ':' +
            String(d.getSeconds()).padStart(2, '0') + '.' +
            String(d.getMilliseconds()).padStart(3, '0');
        line.textContent = stamp + '  ' + (frame ? '⧉ ' + (host || 'frame') + ': ' : '') + m;
        line.style.cssText = 'color: ' + (/never|no rule|gave up|nothing|off\b/i.test(m) ? '#f9e2af' : '#a6adc8') + ';';
        hudBody.appendChild(line);
        while (hudBody.childNodes.length > HUD_MAX) hudBody.removeChild(hudBody.firstChild);
        hudBody.scrollTop = hudBody.scrollHeight;
    }
    // Console as well as the HUD: the HUD dies with the document, and the most confusing
    // gates are the ones that navigate as they close.
    function dbg(m) {
        // Recorded whether or not debug is on. The whole difficulty with this script has
        // been that the broken case is the one with no observer in it: turning debug on to
        // find out why something fails changes the timing enough to make it succeed, so
        // the failure is never the thing being watched. The trace is the same narration
        // written to storage, where it costs nothing and is there afterwards.
        trace(m);
        if (!isDebug()) return;
        try { console.log('[Forget Me Not] ' + location.hostname + ' — ' + m); } catch (_) {}
        if (isTop) hudLine(location.hostname, m, false);
        else toTop({ type: 'dbg', m: String(m), host: location.hostname });
    }

    // Written straight to GM storage from whichever frame produced the line — GM storage
    // is shared across frames, so this needs no messaging and works in a frame whose
    // parent never hears from it. Timestamps are wall clock plus milliseconds since this
    // document started, because "how long after the page began" is the number that has
    // mattered every single time.
    const T0 = Date.now();
    function trace(m) {
        try {
            const t = new Date();
            const stamp = String(t.getHours()).padStart(2, '0') + ':' +
                String(t.getMinutes()).padStart(2, '0') + ':' +
                String(t.getSeconds()).padStart(2, '0') + '.' +
                String(t.getMilliseconds()).padStart(3, '0');
            const line = stamp + '  +' + String(Date.now() - T0).padStart(6) + 'ms  ' +
                (isTop ? '' : '⧉ ') + location.hostname + '  ' + m;
            const l = readJson(TRACE_KEY, []);
            if (!Array.isArray(l)) return;
            l.push(line);
            writeJson(TRACE_KEY, l.slice(-TRACE_MAX));
        } catch (_) {}
    }

    // ---------------- Cross-frame messaging ----------------
    // A gate inside an embedded player is in a document the top frame cannot see or
    // click into, so each frame runs its own recorder and reports the click back. The
    // tag is checked on every message and the payload shape is validated; the worst a
    // hostile page could do with a forged message is offer to add a rule for itself,
    // which still needs the Save button pressed.
    const TAG = '__forgetmenot__';
    const isTop = window === window.top;

    function broadcast(msg, win) {
        const w = win || window;
        try { w.postMessage(Object.assign({ [TAG]: 1 }, msg), '*'); } catch (_) {}
        let n = 0;
        try { n = w.frames.length; } catch (_) { n = 0; }
        for (let i = 0; i < n; i++) {
            try { broadcast(msg, w.frames[i]); } catch (_) {}
        }
    }
    function toTop(msg) {
        try { window.top.postMessage(Object.assign({ [TAG]: 1 }, msg), '*'); } catch (_) {}
    }

    window.addEventListener('message', (e) => {
        const d = e.data;
        if (!d || typeof d !== 'object' || d[TAG] !== 1) return;
        switch (d.type) {
            case 'teach-on':   startRecording(); break;
            case 'teach-off':  stopRecording(); break;
            case 'hello':      if (isTop && teaching) broadcast({ type: 'teach-on' }); break;
            case 'step':
                if (isTop && teaching && d.step && Array.isArray(d.step.path)) {
                    addStep(d.step, String(d.host || ''));
                }
                break;
            case 'test': {
                // Answer only if the rule being tested is the one that applies HERE —
                // which is the ordinary rule lookup, so an "include subdomains" rule is
                // still answered by the subdomain it actually covers.
                const mine = ruleForHost(location.hostname);
                if (mine && mine.key === d.host) runTest(d.stepIndex | 0);
                break;
            }
            case 'dbg':
                if (isTop && isDebug()) hudLine(String(d.host || ''), String(d.m || ''), true);
                break;
            case 'test-result':
                // Only positives are reported. Every frame that does not have the
                // element would otherwise answer "no", and the first of those would win
                // the race against the one frame that does — which is exactly the case
                // the test exists to confirm. The absence of a positive is what counts
                // as a negative, decided by the timeout in the settings panel.
                if (isTop && d.ok) noteTestFound(String(d.host || ''));
                break;
        }
    });

    // ---------------- Teaching: the recorder ----------------
    // Clicks are NOT intercepted. Teaching is just "dismiss the gate the way you always
    // do, while I watch" — which is the only way a multi-step gate can be recorded at
    // all, since the confirm button is usually disabled until the box is really ticked.
    // The cost is that the page may navigate mid-teach, so the recorded steps live in
    // sessionStorage and the popup comes back after the load.
    let teaching = false;
    let recording = false;

    function loadTeach() {
        try {
            const raw = sessionStorage.getItem(TEACH_KEY);
            if (!raw) return null;
            const v = JSON.parse(raw);
            return (v && Array.isArray(v.steps)) ? v : null;
        } catch (_) { return null; }
    }
    const saveTeach = (v) => { try { sessionStorage.setItem(TEACH_KEY, JSON.stringify(v)); } catch (_) {} };
    const clearTeach = () => { try { sessionStorage.removeItem(TEACH_KEY); } catch (_) {} };

    // The thing that was clicked is rarely the node the event landed on — it is the
    // <button> around the <span> around the icon. composedPath() is what makes this work
    // through shadow boundaries, where `e.target` is retargeted to the host and the real
    // element would be invisible.
    const CLICKABLE = 'button, a[href], input, label, summary, select, [role="button"],' +
        '[role="checkbox"], [role="link"], [role="menuitem"], [onclick], [tabindex]';
    function clickableFrom(e) {
        let path = [];
        try { path = e.composedPath ? e.composedPath() : []; } catch (_) {}
        if (!path.length && e.target) path = [e.target];
        for (let i = 0; i < path.length && i < 8; i++) {
            const n = path[i];
            if (!n || n.nodeType !== 1) continue;
            try { if (n.matches && n.matches(CLICKABLE)) return n; } catch (_) {}
        }
        // Nothing in the path admits to being a control. That is ordinary for a close
        // button built from a <div> with an addEventListener and no role, tabindex or
        // onclick attribute — and the fallback below would then record the <path> inside
        // its icon, whose selector is fragile and which is not what the site listens on.
        // `cursor: pointer` is what such a thing looks like from the outside.
        //
        // Inert tags are skipped because `cursor` is INHERITED: the <path> under a
        // cursor:pointer wrapper reports `pointer` itself, so without this the pass
        // returns the very icon it exists to walk out of.
        for (let i = 0; i < path.length && i < 8; i++) {
            const n = path[i];
            if (!n || n.nodeType !== 1 || n === document.body || n === document.documentElement) continue;
            if (INERT_TAG.test(n.tagName)) continue;
            let st;
            try { st = getComputedStyle(n); } catch (_) { continue; }
            if (st && st.cursor === 'pointer') return n;
        }
        for (const n of path) if (n && n.nodeType === 1) return n;
        return null;
    }

    function ourUi(e) {
        let path = [];
        try { path = e.composedPath ? e.composedPath() : []; } catch (_) {}
        for (const n of path) {
            if (n && n.id && /^gs-(popup|settings|hl)$/.test(n.id)) return true;
        }
        return false;
    }

    let hoverEl = null;
    function onRecMove(e) {
        if (!recording || ourUi(e)) return;
        const el = clickableFrom(e);
        if (el === hoverEl) return;
        hoverEl = el;
        hlClear();
        if (el) hlPaint(el, '#89b4fa');
    }
    function onRecClick(e) {
        if (!recording || ourUi(e)) return;
        const el = clickableFrom(e);
        if (!el) return;
        const step = describe(el);
        if (isTop) addStep(step, location.hostname);
        else toTop({ type: 'step', step, host: location.hostname });
    }

    // window, in capture, so we see the click before any document-level listener that
    // another userscript may have added — the capture path reaches window first, and
    // registration order among document listeners is not something we can win. Nothing
    // is stopped here; this only needs to observe.
    const CAP = window;
    function startRecording() {
        if (recording) return;
        recording = true;
        CAP.addEventListener('click', onRecClick, true);
        CAP.addEventListener('mouseover', onRecMove, true);
        try { document.body.style.cursor = 'crosshair'; } catch (_) {}
    }
    function stopRecording() {
        if (!recording) return;
        recording = false;
        CAP.removeEventListener('click', onRecClick, true);
        CAP.removeEventListener('mouseover', onRecMove, true);
        hoverEl = null;
        hlClear();
        try { document.body.style.cursor = ''; } catch (_) {}
    }

    // ---------------- Teaching: the popup ----------------
    let popup = null, popMsg = null, popList = null, popBtns = null, popFoot = null;
    let teachState = null;   // { host, steps }

    function popButton(label, bg, fg) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding: 6px 14px; border-radius: 6px; border: none; font-size: 13px;' +
            'font-weight: 700; cursor: pointer; white-space: nowrap; background: ' + bg +
            '; color: ' + (fg || '#1e1e2e') + ';';
        return b;
    }

    function buildPopup() {
        popup = document.createElement('div');
        popup.id = 'gs-popup';
        popup.style.cssText = 'all: initial;';
        const root = popup.attachShadow({ mode: 'open' });
        const st = document.createElement('style');
        st.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(st);

        const wrap = document.createElement('div');
        wrap.style.cssText = `
            position: fixed; top: 16px; right: 16px; z-index: 2147483647;
            width: 380px; max-width: 92vw;
            background: #1e1e2e; color: #cdd6f4; border: 2px solid #f9e2af; border-radius: 10px;
            padding: 14px 16px; font: 13px/1.5 system-ui, sans-serif;
            box-shadow: 0 10px 40px rgba(0,0,0,0.6); cursor: move;
            display: flex; flex-direction: column; gap: 10px;
        `;
        // Parked in a corner rather than centred: it has to sit alongside a gate the
        // user is about to click, not on top of it. Draggable for when the gate is in
        // that corner anyway.
        wrap.addEventListener('mousedown', (ev) => {
            if (/^(BUTTON|INPUT)$/.test(ev.target.tagName)) return;
            const r = wrap.getBoundingClientRect();
            wrap.style.right = 'auto';
            wrap.style.left = r.left + 'px';
            wrap.style.top = r.top + 'px';
            const ox = ev.clientX - r.left, oy = ev.clientY - r.top;
            const onMove = (e2) => {
                wrap.style.left = (e2.clientX - ox) + 'px';
                wrap.style.top = (e2.clientY - oy) + 'px';
            };
            const onUp = () => {
                window.removeEventListener('mousemove', onMove, true);
                window.removeEventListener('mouseup', onUp, true);
            };
            window.addEventListener('mousemove', onMove, true);
            window.addEventListener('mouseup', onUp, true);
            ev.preventDefault();
        });

        const title = document.createElement('div');
        title.style.cssText = 'font-weight: 700; color: #f9e2af;';
        title.textContent = 'Forget Me Not — recording';

        popMsg = document.createElement('div');
        popMsg.style.cssText = 'white-space: pre-wrap; word-break: break-word;';

        popList = document.createElement('div');
        popList.style.cssText = 'display: flex; flex-direction: column; gap: 4px; max-height: 30vh; overflow: auto;';

        popFoot = document.createElement('div');
        popFoot.style.cssText = 'display: flex; flex-direction: column; gap: 6px; font-size: 12px; color: #9399b2;';

        popBtns = document.createElement('div');
        popBtns.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

        wrap.append(title, popMsg, popList, popFoot, popBtns);
        root.appendChild(wrap);
        document.documentElement.appendChild(popup);
    }

    function killPopup() {
        if (popup) { popup.remove(); popup = null; }
        popMsg = popList = popBtns = popFoot = null;
    }

    function drawPopup() {
        if (!popup) buildPopup();
        const steps = teachState ? teachState.steps : [];
        const host = teachState ? teachState.host : '';

        popMsg.textContent = steps.length
            ? 'Recorded ' + steps.length + (steps.length === 1 ? ' click.' : ' clicks.') +
              '\nClick anything else the gate needs, or save.'
            : 'Dismiss the gate the way you normally would — tick the box, click the button.\nEvery click is recorded, in order.';

        while (popList.firstChild) popList.removeChild(popList.firstChild);
        steps.forEach((s, i) => {
            const row = document.createElement('div');
            row.style.cssText = 'display: flex; align-items: center; gap: 6px; background: #313244;' +
                'border-radius: 6px; padding: 3px 4px 3px 8px; font-size: 12px;';
            const n = document.createElement('span');
            n.style.cssText = 'color: #6c7086;';
            n.textContent = (i + 1) + '.';
            const t = document.createElement('span');
            t.style.cssText = 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
            t.textContent = s.label;
            t.title = s.path.map(p => p.s).join('  ≫  ');
            const x = document.createElement('button');
            x.textContent = '✕';
            x.title = 'Remove this step';
            x.style.cssText = 'border: none; background: none; color: #f38ba8; cursor: pointer; font-size: 12px; padding: 2px;';
            x.addEventListener('click', () => {
                teachState.steps.splice(i, 1);
                if (!teachState.steps.length) teachState.host = '';
                saveTeach(teachState);
                drawPopup();
            });
            row.append(n, t, x);
            popList.appendChild(row);
        });

        while (popFoot.firstChild) popFoot.removeChild(popFoot.firstChild);
        while (popBtns.firstChild) popBtns.removeChild(popBtns.firstChild);

        if (steps.length) {
            const wwwLess = host.replace(/^www\./, '');
            const subRow = document.createElement('label');
            subRow.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer;';
            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = !!(teachState.subdomains);
            cb.style.cssText = 'accent-color: #89b4fa; cursor: pointer;';
            const txt = document.createElement('span');
            const drawTxt = () => {
                txt.textContent = cb.checked
                    ? 'Also every subdomain of ' + wwwLess
                    : 'Only ' + host;
            };
            cb.addEventListener('change', () => {
                teachState.subdomains = cb.checked;
                saveTeach(teachState);
                drawTxt();
            });
            drawTxt();
            subRow.title = 'Ticked, the rule is stored against ' + wwwLess +
                ' and matches that host and anything under it (including www).';
            subRow.append(cb, txt);
            popFoot.appendChild(subRow);

            const where = document.createElement('div');
            where.style.cssText = 'color: #6c7086;';
            where.textContent = 'Saving as a rule for ' + (cb.checked ? wwwLess : host) +
                (host !== location.hostname ? ' (an embedded frame)' : '');
            popFoot.appendChild(where);

            popBtns.appendChild(popButton('Save', '#a6e3a1', '#1e1e2e'));
            popBtns.lastChild.addEventListener('click', saveTaught);
        }

        const cancel = popButton(steps.length ? 'Discard' : 'Cancel', '#45475a', '#cdd6f4');
        cancel.addEventListener('click', endTeaching);
        popBtns.appendChild(cancel);
    }

    function addStep(step, host) {
        if (!teachState) return;
        // Every step of one rule must live in one document, because the rule is stored
        // against that document's host and only that frame ever executes it. Mixing two
        // would silently produce a rule where half the sequence never runs.
        if (teachState.steps.length && teachState.host && teachState.host !== host) {
            popMsg.textContent = 'That click was in a different document (' + host +
                ') from the ones already recorded (' + teachState.host + ').\n' +
                'A rule has to live in one document — save these, then teach the other separately.';
            return;
        }
        teachState.host = host;
        if (teachState.subdomains == null) teachState.subdomains = /^www\./.test(host);
        teachState.steps.push(step);
        saveTeach(teachState);
        drawPopup();
    }

    function startTeaching() {
        if (!isTop) return;
        teaching = true;
        disarm();                       // never auto-click while being taught
        teachState = loadTeach() || { host: '', steps: [], subdomains: null };
        saveTeach(teachState);
        drawPopup();
        broadcast({ type: 'teach-on' });
        startRecording();
    }

    function endTeaching() {
        teaching = false;
        clearTeach();
        teachState = null;
        killPopup();
        broadcast({ type: 'teach-off' });
        stopRecording();
    }

    function saveTaught() {
        if (!teachState || !teachState.steps.length) return;
        const host = teachState.subdomains ? teachState.host.replace(/^www\./, '') : teachState.host;
        const rules = getRules();
        const prev = rules[host];
        rules[host] = {
            host,
            subdomains: !!teachState.subdomains,
            enabled: true,
            watchMs: (prev && prev.watchMs) || 0,
            steps: teachState.steps,
            created: (prev && prev.created) || Date.now(),
            lastFired: 0,
            fires: 0
        };
        saveRules(rules);
        log('rule saved for ' + host + ' (' + teachState.steps.length +
            (teachState.steps.length === 1 ? ' click)' : ' clicks)'));
        const n = teachState.steps.length;
        endTeaching();
        toast('Forget Me Not: saved ' + n + (n === 1 ? ' click' : ' clicks') + ' for ' + host + '.');
    }

    // ---------------- Toast ----------------
    // Used only for things the user just asked for (a save, a test result) — never for
    // an auto-click, which is meant to be invisible.
    function toast(text) {
        if (!isTop) return;
        const host = document.createElement('div');
        host.style.cssText = 'all: initial;';
        const root = host.attachShadow({ mode: 'open' });
        const box = document.createElement('div');
        box.style.cssText = `
            position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
            background: #1e1e2e; color: #cdd6f4; border: 1px solid #45475a; border-radius: 8px;
            padding: 10px 14px; font: 13px/1.4 system-ui, sans-serif; max-width: 340px;
            box-shadow: 0 6px 24px rgba(0,0,0,0.5); transition: opacity .3s;
        `;
        box.textContent = text;
        root.appendChild(box);
        document.documentElement.appendChild(host);
        setTimeout(() => { box.style.opacity = '0'; }, 2600);
        setTimeout(() => host.remove(), 3000);
    }

    // ---------------- Testing a rule against this page ----------------
    let testWait = null;   // { key, found } while a broadcast test is outstanding

    function runTest(stepIndex) {
        const hit = ruleForHost(location.hostname);
        if (!hit) return;
        const step = hit.rule.steps[stepIndex] || hit.rule.steps[0];
        const el = resolveStep(step);
        if (!el) return;                     // silence; see the 'test-result' comment
        hlClear();
        hlPaint(el, '#a6e3a1');
        setTimeout(hlClear, 4000);
        toTop({ type: 'test-result', ok: true, host: hit.key });
    }

    function noteTestFound(key) {
        if (!testWait || testWait.key !== key || testWait.found) return;
        testWait.found = true;
        toast('Forget Me Not: found step 1 of the ' + key + ' rule — highlighted in green.');
    }

    // Asks every frame, including this one, and treats "nobody answered" as the negative.
    function startTest(key) {
        testWait = { key, found: false };
        broadcast({ type: 'test', host: key, stepIndex: 0 });
        setTimeout(() => {
            if (testWait && testWait.key === key && !testWait.found) {
                toast('Forget Me Not: the ' + key + ' rule matches nothing on this page right now.');
            }
            testWait = null;
        }, 800);
    }

    // ---------------- Settings ----------------
    const fmtWhen = (ts) => {
        if (!ts) return 'never';
        const d = new Date(ts), now = Date.now();
        const mins = Math.round((now - ts) / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return mins + ' min ago';
        if (mins < 60 * 24) return Math.round(mins / 60) + ' h ago';
        return d.toLocaleDateString();
    };

    function openSettings() {
        if (!isTop || document.getElementById('gs-settings')) return;

        // Shadow root so the host page's CSS cannot cascade in, and every node built
        // with createElement + textContent — innerHTML throws on Trusted Types sites
        // (YouTube, most Google properties) and aborts the build silently, leaving no
        // panel and no error anyone would connect to it.
        const host = document.createElement('div');
        host.id = 'gs-settings';
        host.style.cssText = 'all: initial;';
        const root = host.attachShadow({ mode: 'open' });
        const reset = document.createElement('style');
        reset.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(reset);

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483646; background: rgba(0,0,0,0.6);
            display: flex; align-items: center; justify-content: center; font-family: system-ui, sans-serif;
        `;
        const panel = document.createElement('div');
        panel.style.cssText = `
            background: #1e1e2e; color: #cdd6f4; border-radius: 10px; padding: 20px 24px;
            width: min(720px, 94vw); max-height: 86vh; display: flex; flex-direction: column;
            gap: 12px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); overflow: hidden;
        `;

        const title = document.createElement('div');
        title.style.cssText = 'font-size: 15px; font-weight: 700; color: #89b4fa;';
        title.textContent = 'Forget Me Not — Settings';

        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: #9399b2; line-height: 1.45;';
        desc.textContent = 'Forget Me Not does nothing on a site until you teach it there. ' +
            '"Teach this page" records the clicks you make to dismiss a gate; afterwards it makes those ' +
            'same clicks for you, for about ' + Math.round(watchDefault() / 1000) + ' seconds after each load.';

        function smallBtn(label, bg, fg) {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'padding: 4px 10px; border-radius: 6px; border: none; font-size: 12px;' +
                'font-weight: 700; cursor: pointer; white-space: nowrap; background: ' + bg +
                '; color: ' + (fg || '#1e1e2e') + ';';
            return b;
        }
        const mkCheck = (checked, onChange) => {
            const c = document.createElement('input');
            c.type = 'checkbox';
            c.checked = checked;
            c.style.cssText = 'accent-color: #89b4fa; cursor: pointer;';
            c.addEventListener('change', () => onChange(c.checked));
            return c;
        };

        // --- global row ---
        const globalRow = document.createElement('div');
        globalRow.style.cssText = 'display: flex; align-items: center; gap: 14px; flex-wrap: wrap; font-size: 12px; color: #9399b2;';

        const onLabel = document.createElement('label');
        onLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer;';
        onLabel.title = 'Master switch. Off, no rule fires anywhere, and nothing is forgotten.';
        onLabel.append(mkCheck(isOn(), (v) => { GM_setValue(ON_KEY, !!v); if (v) arm(true); else disarm(); }));
        const onTxt = document.createElement('span');
        onTxt.textContent = 'Forget Me Not is on';
        onLabel.append(onTxt);

        const watchLabel = document.createElement('label');
        watchLabel.style.cssText = 'display: flex; align-items: center; gap: 6px;';
        watchLabel.title = 'How long after each page load (and each in-page navigation) to keep watching for the gate.';
        const watchTxt1 = document.createElement('span');
        watchTxt1.textContent = 'Watch for';
        const watchIn = document.createElement('input');
        watchIn.type = 'number';
        watchIn.min = '1'; watchIn.max = '120';
        watchIn.value = String(Math.round(watchDefault() / 1000));
        watchIn.style.cssText = 'width: 56px; padding: 3px 6px; border-radius: 5px; border: 1px solid #45475a;' +
            'background: #313244; color: #cdd6f4; font-size: 12px;';
        watchIn.addEventListener('change', () => {
            const n = Math.max(1, Math.min(120, parseInt(watchIn.value, 10) || 10));
            watchIn.value = String(n);
            GM_setValue(WATCH_KEY, n * 1000);
        });
        const watchTxt2 = document.createElement('span');
        watchTxt2.textContent = 'seconds after each load';
        watchLabel.append(watchTxt1, watchIn, watchTxt2);

        const dbgLabel = document.createElement('label');
        dbgLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; cursor: pointer; color: #f38ba8;';
        dbgLabel.title = 'For testing. Marks the element it is about to click, waits ' +
            (DEBUG_DELAY / 1000) + ' seconds, then clicks it — and narrates every decision, ' +
            'including “no gate was found”, in a panel at the bottom left.';
        dbgLabel.append(mkCheck(isDebug(), (v) => {
            GM_setValue(DEBUG_KEY, !!v);
            if (!v) { hudKill(); if (run) { run.debug = false; run.pending = null; hlClear(); } }
            arm(true);
        }));
        const dbgTxt = document.createElement('span');
        dbgTxt.textContent = 'Debug mode (show the target, wait ' + (DEBUG_DELAY / 1000) + 's, then click)';
        dbgLabel.append(dbgTxt);

        globalRow.append(onLabel, watchLabel, dbgLabel);

        // --- rule list ---
        const list = document.createElement('div');
        list.style.cssText = 'flex: 1; min-height: 80px; overflow: auto; display: flex; flex-direction: column;' +
            'gap: 6px; border: 1px solid #313244; border-radius: 8px; padding: 8px;';

        function drawList() {
            while (list.firstChild) list.removeChild(list.firstChild);
            const rules = getRules();
            const keys = Object.keys(rules).sort();
            if (!keys.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color: #6c7086; font-size: 12px; padding: 8px;';
                empty.textContent = 'No sites taught yet. Open a site with a gate, then pick ' +
                    '“Forget Me Not: teach this page” from the Violentmonkey menu.';
                list.appendChild(empty);
                return;
            }
            for (const key of keys) {
                const r = rules[key];
                const card = document.createElement('div');
                card.style.cssText = 'background: #313244; border-radius: 8px; padding: 8px 10px;' +
                    'display: flex; flex-direction: column; gap: 6px;';

                const head = document.createElement('div');
                head.style.cssText = 'display: flex; align-items: center; gap: 8px;';

                const en = mkCheck(r.enabled !== false, (v) => {
                    const rr = getRules();
                    if (rr[key]) { rr[key].enabled = !!v; saveRules(rr); }
                    arm(true);
                });
                en.title = 'Off, this rule is kept but never fires.';

                const name = document.createElement('span');
                name.style.cssText = 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;' +
                    'white-space: nowrap; font-weight: 700; font-size: 13px;';
                name.textContent = (r.subdomains ? '*.' : '') + key;
                name.title = key + (r.subdomains ? ' and every subdomain' : ' (this host only)');

                const meta = document.createElement('span');
                meta.style.cssText = 'font-size: 11px; color: #9399b2; white-space: nowrap;';
                meta.textContent = r.steps.length + (r.steps.length === 1 ? ' click · ' : ' clicks · ') +
                    'last fired ' + fmtWhen(r.lastFired);
                meta.title = 'Fired ' + (r.fires || 0) + ' time(s) since it was taught.';

                const testBtn = smallBtn('Test', '#89b4fa');
                testBtn.title = 'Look for this rule’s first click on the page behind this dialog — in the page itself and in every frame on it.';
                testBtn.addEventListener('click', () => startTest(key));

                const delBtn = smallBtn('Delete', '#f38ba8');
                delBtn.addEventListener('click', () => {
                    const rr = getRules();
                    delete rr[key];
                    saveRules(rr);
                    log('rule deleted for ' + key);
                    drawList();
                    arm(true);
                });

                head.append(en, name, meta, testBtn, delBtn);

                const steps = document.createElement('div');
                steps.style.cssText = 'display: flex; flex-direction: column; gap: 2px; font-size: 11px; color: #a6adc8;';
                r.steps.forEach((s, i) => {
                    const line = document.createElement('div');
                    line.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                    line.textContent = (i + 1) + '. ' + s.label;
                    line.title = s.path.map(p => p.s).join('  ≫  ');
                    steps.appendChild(line);
                });

                const subRow = document.createElement('label');
                subRow.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 11px; color: #9399b2; cursor: pointer;';
                subRow.append(mkCheck(!!r.subdomains, (v) => {
                    const rr = getRules();
                    if (rr[key]) { rr[key].subdomains = !!v; saveRules(rr); }
                    drawList();
                    arm(true);
                }));
                const subTxt = document.createElement('span');
                subTxt.textContent = 'Include subdomains';
                subRow.append(subTxt);

                card.append(head, steps, subRow);
                list.appendChild(card);
            }
        }
        drawList();

        // --- activity log ---
        const logWrap = document.createElement('div');
        logWrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px;';
        const logToggle = document.createElement('div');
        logToggle.style.cssText = 'color: #89b4fa; cursor: pointer; user-select: none; font-size: 12px;';
        const logBody = document.createElement('div');
        logBody.style.cssText = 'display: none; flex-direction: column; gap: 2px; font-size: 11px;' +
            'color: #9399b2; max-height: 22vh; overflow: auto; border: 1px solid #313244;' +
            'border-radius: 6px; padding: 6px;';
        let logOpen = false;
        function drawLog() {
            logToggle.textContent = (logOpen ? '▾' : '▸') + ' Recent activity';
            logBody.style.display = logOpen ? 'flex' : 'none';
            while (logBody.firstChild) logBody.removeChild(logBody.firstChild);
            const entries = readJson(LOG_KEY, []);
            if (!Array.isArray(entries) || !entries.length) {
                const e = document.createElement('div');
                e.style.cssText = 'color: #6c7086;';
                e.textContent = 'Nothing yet. Only real events are recorded — a taught site whose ' +
                    'gate simply did not appear is not an event.';
                logBody.appendChild(e);
                return;
            }
            for (const e of entries) {
                const line = document.createElement('div');
                line.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                line.textContent = new Date(e.t).toLocaleString() + ' · ' + e.host + ' · ' + e.m;
                line.title = line.textContent;
                logBody.appendChild(line);
            }
        }
        logToggle.addEventListener('click', () => { logOpen = !logOpen; drawLog(); });
        drawLog();
        logWrap.append(logToggle, logBody);

        // --- footer ---
        const foot = document.createElement('div');
        foot.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center;';

        const teachBtn = smallBtn('Teach this page', '#f9e2af');
        teachBtn.title = 'Close this dialog and start recording clicks on ' + location.hostname + '.';
        teachBtn.addEventListener('click', () => { host.remove(); startTeaching(); });

        const exportBtn = smallBtn('Export', '#45475a', '#cdd6f4');
        exportBtn.title = 'Copy every rule to the clipboard as JSON.';
        exportBtn.addEventListener('click', () => {
            const text = JSON.stringify(getRules(), null, 2);
            try {
                navigator.clipboard.writeText(text)
                    .then(() => { status.textContent = 'Rules copied to the clipboard.'; })
                    .catch(() => { status.textContent = 'Clipboard refused — paste box opened instead.'; showIo(text); });
            } catch (_) { showIo(text); }
        });

        const importBtn = smallBtn('Import', '#45475a', '#cdd6f4');
        importBtn.title = 'Paste exported JSON to merge rules in. Existing hosts are overwritten.';
        importBtn.addEventListener('click', () => showIo(''));

        // The trace is kept whether or not debug is on, which is the point: the case that
        // fails is the one nobody is watching, and switching debug on to watch it changes
        // the timing enough to make it pass.
        const traceBtn = smallBtn('Save trace', '#cba6f7', '#11111b');
        traceBtn.title = 'Download everything Forget Me Not has narrated recently — including ' +
            'with debug off — as a .txt file.';
        traceBtn.addEventListener('click', () => {
            const lines = readJson(TRACE_KEY, []);
            if (!Array.isArray(lines) || !lines.length) {
                status.style.color = '#f9e2af';
                status.textContent = 'The trace is empty — load a page with a rule on it first.';
                return;
            }
            const text = 'Forget Me Not trace — ' + new Date().toString() + '\n' +
                'script v' + VERSION + ', ' + lines.length + ' lines\n' +
                'user agent: ' + navigator.userAgent + '\n' +
                ''.padEnd(70, '-') + '\n' + lines.join('\n') + '\n';
            try {
                const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = 'forgetmenot-trace-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.txt';
                (document.body || document.documentElement).appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 10000);
                status.style.color = '#a6e3a1';
                status.textContent = 'Trace saved (' + lines.length + ' lines).';
            } catch (_) {
                // A page with a restrictive CSP can refuse the blob: URL. The paste box
                // always works, so the trace is never actually unreachable.
                showIo(text);
            }
        });

        const clearTraceBtn = smallBtn('Clear trace', '#45475a', '#cdd6f4');
        clearTraceBtn.title = 'Empty the trace, so the next page load starts a clean one.';
        clearTraceBtn.addEventListener('click', () => {
            writeJson(TRACE_KEY, []);
            status.style.color = '#a6e3a1';
            status.textContent = 'Trace cleared.';
        });

        const status = document.createElement('span');
        status.style.cssText = 'font-size: 11px; color: #a6e3a1; flex: 1; min-width: 0;' +
            'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

        const closeBtn = smallBtn('Close', '#89b4fa');
        closeBtn.addEventListener('click', () => host.remove());

        foot.append(teachBtn, exportBtn, importBtn, traceBtn, clearTraceBtn, status, closeBtn);

        const io = document.createElement('div');
        io.style.cssText = 'display: none; flex-direction: column; gap: 6px;';
        const ioBox = document.createElement('textarea');
        ioBox.style.cssText = 'width: 100%; height: 120px; border-radius: 6px; border: 1px solid #45475a;' +
            'background: #313244; color: #cdd6f4; font: 11px/1.4 monospace; padding: 6px; resize: vertical;';
        const ioBtns = document.createElement('div');
        ioBtns.style.cssText = 'display: flex; gap: 8px;';
        const ioApply = smallBtn('Merge these rules', '#a6e3a1');
        ioApply.addEventListener('click', () => {
            let parsed;
            try { parsed = JSON.parse(ioBox.value); } catch (_) { status.style.color = '#f38ba8'; status.textContent = 'That is not valid JSON.'; return; }
            if (!parsed || typeof parsed !== 'object') { status.style.color = '#f38ba8'; status.textContent = 'Expected an object of host → rule.'; return; }
            const rules = getRules();
            let n = 0;
            for (const k of Object.keys(parsed)) {
                const r = parsed[k];
                if (!r || !Array.isArray(r.steps) || !r.steps.length) continue;
                rules[k] = Object.assign({ host: k, subdomains: false, enabled: true, watchMs: 0, created: Date.now(), lastFired: 0, fires: 0 }, r);
                n++;
            }
            saveRules(rules);
            status.style.color = '#a6e3a1';
            status.textContent = 'Merged ' + n + ' rule(s).';
            io.style.display = 'none';
            drawList();
            arm(true);
        });
        const ioCancel = smallBtn('Cancel', '#45475a', '#cdd6f4');
        ioCancel.addEventListener('click', () => { io.style.display = 'none'; });
        ioBtns.append(ioApply, ioCancel);
        io.append(ioBox, ioBtns);
        function showIo(text) {
            ioBox.value = text;
            io.style.display = 'flex';
            ioBox.focus();
            if (text) ioBox.select();
        }

        panel.append(title, desc, globalRow, list, logWrap, io, foot);
        overlay.appendChild(panel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) host.remove(); });
        root.appendChild(overlay);
        document.documentElement.appendChild(host);
    }

    // ---------------- Boot ----------------
    if (isTop) {
        GM_registerMenuCommand('Forget Me Not: teach this page', startTeaching);
        GM_registerMenuCommand('Forget Me Not: settings', openSettings);
        GM_registerMenuCommand('Forget Me Not: debug mode on/off', () => {
            const v = !isDebug();
            GM_setValue(DEBUG_KEY, v);
            if (!v) { hudKill(); if (run) { run.debug = false; run.pending = null; hlClear(); } }
            arm(true);
            toast('Forget Me Not: debug mode ' + (v ? 'ON — clicks are delayed ' + (DEBUG_DELAY / 1000) + 's and marked on the page.' : 'off.'));
        });
        GM_registerMenuCommand('Forget Me Not: forget this site', () => {
            const rules = getRules();
            const hit = ruleForHost(location.hostname);
            if (!hit) { toast('Forget Me Not: nothing taught for ' + location.hostname + '.'); return; }
            delete rules[hit.key];
            saveRules(rules);
            log('rule deleted for ' + hit.key);
            disarm();
            toast('Forget Me Not: forgot ' + hit.key + '.');
        });
    }

    const boot = () => {
        watchNavigation();
        extendWatch('DOM ready');
        if (isTop) {
            // A teach session that was interrupted by the gate's own navigation picks up
            // where it left off — the steps live in sessionStorage precisely so that the
            // click which dismisses the gate is not also the click that loses them.
            const pending = loadTeach();
            if (pending && pending.steps.length) {
                teaching = true;
                disarm();               // arm() already ran at document-start
                teachState = pending;
                drawPopup();
                broadcast({ type: 'teach-on' });
                startRecording();
                return;
            }
        } else {
            // Frames load later than the top document, so a frame that arrives after
            // teaching started has to ask rather than wait to be told.
            toTop({ type: 'hello' });
        }
        arm();
    };

    // `load` is the one that matters for a gate pulled in by a third-party script: it does
    // not fire until those have finished arriving, which is the earliest moment such a gate
    // could exist.
    if (document.readyState === 'complete') {
        setTimeout(() => extendWatch('fully loaded'), 0);
    } else {
        window.addEventListener('load', () => extendWatch('fully loaded'), { once: true });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
        // Do not wait for DOMContentLoaded to start hunting: a gate rendered server-side
        // is already in the DOM, and dismissing it before first paint is the difference
        // between "never saw it" and "saw it flash".
        arm();
    } else {
        boot();
    }
})();
