// ==UserScript==
// @name        Forget Me Not
// @namespace   https://github.com/VitaKaninen
// @version     0.14.0
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
    const RULES_KEY = 'fmn_rules';    // GM: { "<host>": Rule }
    const ON_KEY = 'fmn_on';          // GM: false to switch the whole thing off
    const WATCH_KEY = 'fmn_watch';    // GM: default watch window, ms
    const LOG_KEY = 'fmn_log';        // GM: [{ t, host, m }] — newest first, capped
    const TRACE_KEY = 'fmn_trace';    // GM: [line] — the narration of every decision, always on
    const TEACH_KEY = 'fmn_teach';    // sessionStorage (top frame): teaching in progress

    // Schema v2. A host entry holds N INDEPENDENT click sequences plus one prefs block:
    //
    //   { v: 2, host, subdomains, enabled,
    //     clicks: [ Seq, … ],
    //     prefs:  { captured, entries: [ … ] } }
    //
    //   Seq: { id, label, steps: [Step], watchMs, fires, lastFired, created }
    //
    // `clicks` is an ARRAY because one host routinely needs more than one unrelated
    // dismissal: an age gate on the landing page, and some other popup that only appears
    // three pages deep. Those are not steps of one sequence — a sequence runs in order and
    // stops when a step stops resolving, so folding the deep popup in as "step 3" means it
    // never fires on the landing page and the landing gate blocks it everywhere else.
    // Each sequence therefore arms on its own and hunts for its own first step; the one
    // whose step 1 is actually on this page is the one that runs. No URL matching is
    // involved, which is deliberate — the page's own content selects the sequence, so
    // nothing breaks when the site reorganises its paths.
    //
    // There is NO migration from v1 and no compatibility read path. Rules cost seconds to
    // re-teach; see HANDOFF.md, and do not reintroduce one.
    const SCHEMA_V = 2;

    // The v1 keys, deleted once so they do not sit in GM storage forever. Not read first.
    const DEAD_KEYS = ['gs_rules', 'gs_on', 'gs_watch', 'gs_log', 'gs_trace', 'gs_debug'];

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
    const VERSION = '0.14.0';

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
    const watchDefault = () => {
        const n = parseInt(GM_getValue(WATCH_KEY, WATCH_DEFAULT), 10);
        return (n > 0 && n <= 120000) ? n : WATCH_DEFAULT;
    };

    // Every sequence of a rule, always an array. Written as an accessor rather than
    // reading `.clicks` inline so a malformed entry degrades to "this host does nothing"
    // instead of throwing inside the runner's interval, where nothing would report it.
    const seqsOf = (rule) => (rule && Array.isArray(rule.clicks)) ? rule.clicks : [];

    // Ids are only ever compared to each other, never parsed, and only have to be unique
    // within one host — a sequence is identified in the log and in Settings by its label.
    let seqCounter = 0;
    const newSeq = (steps, label) => ({
        id: 's' + Date.now().toString(36) + (seqCounter++).toString(36),
        label: label || '',
        steps: steps || [],
        watchMs: 0, fires: 0, lastFired: 0, created: Date.now()
    });

    // A sequence with no label is described by one of its steps, because that is what the
    // user recognises ("I am over 18") — not by an id they have never seen. Prefer the
    // first step that actually has a caption: a gate's step 1 is very often a checkbox,
    // whose label is the useless "input (no text)", while the confirm button next to it
    // carries the words the user would use to describe the whole thing.
    function seqName(seq, i) {
        if (seq.label) return seq.label;
        const steps = seq.steps || [];
        const named = steps.find(s => s && s.text) || steps[0];
        if (!named || !named.label) return 'sequence ' + (i + 1);
        // describe() formats a label as `button — “Enter site”`, which is right for the
        // step list in Settings but reads badly once quoted again in a log line
        // (`“button — “Enter site”” saved`). Unwrap to just the caption when there is one.
        const m = /^[a-z0-9-]+ — “(.+)”$/.exec(named.label);
        return m ? m[1] : named.label;
    }

    // One-time removal of the v1 keys. Deleting rather than reading: rules are cheap to
    // re-teach and a compatibility path is a permanent liability. Guarded by its own key
    // so it costs one GM read per document once it has run.
    (function dropDeadKeys() {
        try {
            if (GM_getValue('fmn_v1_cleared', false) === true) return;
            for (const k of DEAD_KEYS) { try { GM_deleteValue(k); } catch (_) {} }
            GM_setValue('fmn_v1_cleared', true);
        } catch (_) {}
    })();

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

    // For the trace, so "which of the four candidates did it actually hit" is answerable.
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

    // One run per armed SEQUENCE, all hunting the same document at once. They are fully
    // independent — separate idx, deadline, verify state and clicked list — because they
    // represent unrelated dismissals that happen to share a host. The timer and the
    // observer are shared: they are per-document, and N intervals would be N times the
    // work for identical wake-ups.
    let runs = [];
    let watcher = null;    // { obs, timer } — shared by every run
    let armedUrl = null;   // the URL the current watch window belongs to

    function stopWatcher() {
        if (!watcher) return;
        try { if (watcher.obs) watcher.obs.disconnect(); } catch (_) {}
        try { if (watcher.timer) clearInterval(watcher.timer); } catch (_) {}
        watcher = null;
    }

    function disarm() {
        runs = [];
        stopWatcher();
    }

    // Retire one run without touching the others. The watcher only stops once the last
    // run is gone, so a short sequence finishing does not blind a long one still hunting.
    function retire(r) {
        const i = runs.indexOf(r);
        if (i !== -1) runs.splice(i, 1);
        if (!runs.length) stopWatcher();
    }

    // A click is not an outcome. Every click is followed by a look at whether the page
    // moved at all, and a step is only counted as done once something did — see
    // clickState() for what counts. Three states, in order: fire, wait, check.
    function fireClick(r, v, now) {
        // Cycled, not clamped: with one candidate every attempt repeats it, which is what a
        // control that is merely not wired up yet needs, and with several the extra attempts
        // come back round to the first.
        v.hit = v.cands[(v.tries - 1) % v.cands.length] || v.el;
        v.before = clickState(v.hit);
        v.phase = 'check';
        const grace = VERIFY_WAIT[Math.min(v.tries - 1, VERIFY_WAIT.length - 1)];
        v.at = now + grace;
        r.settleUntil = now + grace;
        // A retry cycle must not be cut short by the watch window closing under it.
        r.deadline = Math.max(r.deadline, now + grace + 4000);
        realClick(v.hit);
        // readyState is worth saying out loud: a click that lands while the document is
        // still 'loading' or 'interactive' is the one most likely to hit markup whose
        // handler has not been attached yet, and that is invisible from anywhere else.
        dbg(r.tag + 'clicked step ' + (r.idx + 1) + ' of ' + r.seq.steps.length +
            ' [doc ' + document.readyState + ']' +
            (v.max > 1 ? ' (attempt ' + v.tries + ' of ' + v.max + ')' : '') +
            (v.hit !== v.el ? ' — on ' + descEl(v.hit) + ' around the ' + descEl(v.el) + ' taught'
                            : (v.cands.length > 1 ? ' — on the ' + descEl(v.el) + ' taught' : '')));
    }

    function beginClick(r, el, now) {
        const cands = clickCandidates(el);
        r.verify = {
            el, cands, hit: null, before: null, tries: 1, phase: 'check', at: 0,
            // Every candidate gets at least one go, plus a repeat of the first.
            max: Math.max(CLICK_TRIES, cands.length + 1)
        };
        if (cands.length > 1) {
            dbg(r.tag + 'step ' + (r.idx + 1) + ': the element taught is ' + descEl(el) +
                ', which nothing listens on by itself — will try ' +
                cands.map(descEl).join(', then '));
        }
        fireClick(r, r.verify, now);
    }

    // Called once the click is known to have landed, so the bookkeeping that says "this
    // step is behind us" happens exactly where that becomes true.
    function commitClick(r, now) {
        const v = r.verify;
        r.verify = null;
        r.clicked.push(v.el);
        if (v.hit && v.hit !== v.el) r.clicked.push(v.hit);
        r.idx++;
        r.settleUntil = now + SETTLE_MS;

        // The restart test further down asks whether step 1 stopped resolving and then
        // started resolving again, because a page that detaches and re-attaches the SAME
        // node cannot be caught by node identity. That vanish now happens during the
        // verify window — before r.done is ever set — so unless it is recorded here it
        // is simply lost, and the gate coming back reads as a gate that never left.
        // Introduced by the verify/retry cycle; the old code clicked and completed in one
        // step, so the done-branch always saw it.
        if (!resolveStep(r.seq.steps[0])) r.vanished = true;

        if (r.idx >= r.seq.steps.length) {
            r.done = true;
            // Counters live on the SEQUENCE, not the host: with several sequences per host
            // a shared counter could not answer "is this particular one still working?",
            // which is the only question the number is for. Located by id rather than by
            // index — Settings can delete a sequence while a run holds a reference to it.
            const rules = getRules();
            const seq = seqsOf(rules[r.key]).find(s => s.id === r.seq.id);
            if (seq) {
                seq.lastFired = Date.now();
                seq.fires = (seq.fires || 0) + 1;
                saveRules(rules);
            }
            const n = r.seq.steps.length;
            log(r.noop
                ? ('ran all ' + n + (n === 1 ? ' click' : ' clicks') + ' of “' + r.name +
                   '”, but at least one of them changed nothing on the page')
                : ('dismissed “' + r.name + '” (' + n + (n === 1 ? ' click)' : ' clicks)')));
            dbg(r.tag + 'sequence complete — still watching until the window ends, in case the page puts the gate back');
            // Not disarmed — the window stays open for the re-render case below. The
            // deadline is what ends it.
        }
    }

    function tick() {
        // `recording` and not just `teaching`: in a FRAME being taught, `teaching` is
        // false (the popup and its state live only in the top frame), so gating on that
        // alone would let an already-taught rule auto-click the very gate being recorded.
        if (teaching || recording || !runs.length) return;
        const now = Date.now();
        // Copied, because tickRun can retire a run mid-loop.
        for (const r of runs.slice()) tickRun(r, now);
    }

    function tickRun(r, now) {
        if (now < r.settleUntil) return;

        // A click has been made and is being judged. Nothing else may run until it is
        // settled, or a step that quietly did nothing would be followed by a hunt for the
        // next one — which is how a rule used to report success having achieved nothing.
        if (r.verify) {
            const v = r.verify;
            if (now < v.at) return;

            if (v.phase === 'wait') {
                // Re-resolve rather than reusing the node: between attempts the page may
                // have re-rendered the control, and clicking a detached copy of it is a
                // guaranteed no-op that would burn the remaining attempts.
                const fresh = resolveStep(r.seq.steps[r.idx]);
                if (!fresh) {
                    dbg(r.tag + 'step ' + (r.idx + 1) + ' went away before the retry — taking that as the click having worked');
                    commitClick(r, now);
                    return;
                }
                if (fresh !== v.el) { v.el = fresh; v.cands = clickCandidates(fresh); }
                fireClick(r, v, now);
                return;
            }

            // Two independent signs of life: the element moved, or the step stopped
            // resolving (whole-subtree teardown leaves the measured node detached, and a
            // detached node's parent class tells you nothing).
            const moved = whatMoved(v.before, clickState(v.hit));
            const stillThere = resolveStep(r.seq.steps[r.idx]);
            if (moved || !stillThere) {
                dbg(r.tag + 'step ' + (r.idx + 1) + ' counted as done — ' +
                    (!stillThere ? 'the step stopped resolving' : "'" + moved + "' changed") +
                    ' [doc ' + document.readyState + ']');
                commitClick(r, now);
                return;
            }

            if (v.tries >= v.max) {
                r.noop = true;
                log('step ' + (r.idx + 1) + ' of ' + r.seq.steps.length + ' of “' + r.name + '”' +
                    ' was clicked ' + v.max + ' times (' + v.cands.map(descEl).join(', ') +
                    ') and the page never reacted — re-teaching this step will record a better target');
                dbg(r.tag + 'step ' + (r.idx + 1) + ': ' + v.max + ' clicks across ' +
                    v.cands.map(descEl).join(', ') + ' and nothing moved on the page at all' +
                    ' — giving up on this step; re-teach it to record a better target');
                commitClick(r, now);
                return;
            }

            const wait = RETRY_WAIT[Math.min(v.tries - 1, RETRY_WAIT.length - 1)];
            v.tries++;
            v.phase = 'wait';
            v.at = now + wait;
            r.settleUntil = now + wait;
            r.deadline = Math.max(r.deadline, now + wait + VERIFY_WAIT[VERIFY_WAIT.length - 1] + 4000);
            dbg(r.tag + 'step ' + (r.idx + 1) + ': nothing on the page changed — attempt ' + v.tries +
                ' of ' + v.max + ' in ' + wait + 'ms');
            return;
        }

        if (now > r.deadline) {
            // Half-done is the interesting case: the gate was there and the first clicks
            // landed, so the rule is real but no longer complete. Silence there would be
            // exactly the "did it break or was there no gate?" ambiguity worth avoiding.
            if (!r.done && r.idx > 0) {
                log('gave up after step ' + r.idx + ' of ' + r.seq.steps.length + ' of “' + r.name +
                    '” — the rest of the sequence never appeared');
            }
            // The single most useful line in the trace. If the gate did not show up on
            // this visit, this says so explicitly, which is what separates "Forget Me Not
            // dismissed it" from "the site did not gate you this time". With several
            // sequences armed, a NEVER MATCHED line is the NORMAL result for all but the
            // one whose gate is on this page — that is the design, not a fault.
            dbg(r.tag + (r.done
                ? 'watch window ended — the sequence had run'
                : (r.idx > 0
                    ? 'watch window ended after step ' + r.idx + ' of ' + r.seq.steps.length + ' — the rest never appeared'
                    : 'watch window ended and step 1 NEVER MATCHED — this sequence found nothing on this page')));
            retire(r);
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
        if (r.done) {
            if (r.restarts >= MAX_RESTARTS) return;
            const first = resolveStep(r.seq.steps[0]);
            if (!first) { r.vanished = true; return; }
            if (!r.vanished && r.clicked.indexOf(first) !== -1) return;
            r.restarts++;
            r.vanished = false;
            r.idx = 0;
            r.done = false;
            r.noop = false;   // a fresh run gets to be judged on its own clicks
            r.clicked.length = 0;
            log('the page replaced “' + r.name + '” — running the sequence again');
            dbg(r.tag + 'the page put the gate back — running the sequence again (restart ' + r.restarts + ')');
        }

        const step = r.seq.steps[r.idx];
        const el = resolveStep(step);
        if (!el || r.clicked.indexOf(el) !== -1) return;

        beginClick(r, el, now);
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
        const seqs = seqsOf(hit && hit.rule).filter(s => s.steps && s.steps.length);
        if (!hit || !seqs.length) {
            // Only the top frame says this. Every ad and analytics frame on the page
            // would otherwise report its own "no rule", burying the one line that matters.
            if (isTop) {
                // A host may legitimately have preferences and no taught clicks at all —
                // clicking is the FALLBACK rung, not the main event. Saying "doing nothing
                // on this page" over a rule that is replaying six preferences would be a
                // trace line that lies.
                const pf = hit && hit.rule && hit.rule.prefs;
                const np = (pf && Array.isArray(pf.entries)) ? pf.entries.filter(e => e && e.enabled).length : 0;
                dbg(np ? 'no taught clicks for ' + location.hostname + ' — ' + np +
                         ' preference(s) are replayed here instead'
                       : 'no rule for ' + location.hostname + ' — Forget Me Not is doing nothing on this page');
            }
            return;
        }

        // EVERY sequence arms. Which one actually fires is decided by the page: a run
        // whose step 1 never resolves simply reports NEVER MATCHED and retires, which is
        // the expected outcome for all but one of them on any given page. That is what
        // lets a host hold an age gate from its landing page and an unrelated popup from
        // three pages in, without either knowing about the other.
        const now = Date.now();
        runs = seqs.map((seq, i) => {
            const watchMs = (seq.watchMs > 0) ? seq.watchMs : watchDefault();
            const name = seqName(seq, i);
            return {
                seq, name, key: hit.key,
                // Trace lines are prefixed only when there is something to disambiguate,
                // so a single-sequence host's trace stays exactly as it read before.
                tag: seqs.length > 1 ? '[' + name + '] ' : '',
                idx: 0, done: false, clicked: [], restarts: 0, vanished: false,
                deadline: now + watchMs, settleUntil: 0,
                // verify: the click currently being judged. noop: at least one step was
                // clicked to exhaustion without the page reacting, which changes what the
                // completion line is allowed to claim.
                verify: null, noop: false
            };
        });

        if (seqs.length === 1) {
            const r = runs[0];
            dbg('armed for ' + hit.key + ' — “' + r.name + '” (' + r.seq.steps.length +
                (r.seq.steps.length === 1 ? ' step' : ' steps') + '), watching ' +
                Math.round((r.deadline - now) / 1000) + 's — fired ' + (r.seq.fires || 0) + ' time(s) before');
        } else {
            dbg('armed for ' + hit.key + ' — ' + seqs.length + ' sequences, each hunting its own step 1: ' +
                runs.map(r => '“' + r.name + '” (' + r.seq.steps.length + ', ' +
                    Math.round((r.deadline - now) / 1000) + 's, fired ' + (r.seq.fires || 0) + '×)').join(', '));
        }

        watcher = { timer: setInterval(tick, 200), obs: null };
        try {
            watcher.obs = new MutationObserver(tick);
            watcher.obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'] });
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
    // while opening Settings made it fire instantly — that calls arm(true), which opened a
    // fresh window with the gate already on screen. The rule was fine; it was being asked
    // to watch during the wrong ten seconds.
    //
    // Renews EVERY live run, each against its own watchMs. A sequence that has already
    // completed is skipped, so reaching `load` cannot reopen a window on a gate that was
    // dealt with — but its siblings, which may still be waiting for a popup that has not
    // appeared, get the full extension.
    function extendWatch(why) {
        const now = Date.now();
        let extended = 0, longest = 0;
        for (const r of runs) {
            if (r.done) continue;
            const ms = (r.seq.watchMs > 0) ? r.seq.watchMs : watchDefault();
            const until = now + ms;
            if (until <= r.deadline) continue;
            r.deadline = until;
            extended++;
            longest = Math.max(longest, ms);
        }
        if (!extended) return;
        dbg('page reached ' + why + ' — watching ' + Math.round(longest / 1000) + 's more from here' +
            (runs.length > 1 ? ' (' + extended + ' of ' + runs.length + ' sequences)' : ''));
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
            ' box-shadow: 0 0 0 1px rgba(0,0,0,0.85), 0 0 0 3px rgba(255,255,255,0.55), 0 0 10px 2px var(--c); }';
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
                continue;
            }
            e.box.style.display = '';
            e.box.style.left = (r.left - 3) + 'px';
            e.box.style.top = (r.top - 3) + 'px';
            e.box.style.width = (r.width + 6) + 'px';
            e.box.style.height = (r.height + 6) + 'px';
        }
    }
    // Used by teaching (which element did I just pick?) and by testing a rule from
    // Settings. Both want a plain box and neither wants a caption, so there is no label
    // and no handle to retitle one with — that half existed for debug mode's countdown
    // and went with it in v0.9.0.
    function hlPaint(el, color) {
        if (!el) return;
        hlEnsure();
        const c = color || '#a6e3a1';
        const box = document.createElement('div');
        box.className = 'b';
        box.style.setProperty('--c', c);
        box.style.backgroundColor = c + '30';
        hlRoot.appendChild(box);
        hlEntries.push({ el, box });
        hlDraw();
    }
    function hlClear() {
        for (const e of hlEntries) e.box.remove();
        hlEntries.length = 0;
    }

    // ---------------- Trace ----------------
    // Normal operation is deliberately silent, and `gs_log` records only real events — so
    // "Forget Me Not did nothing" and "Forget Me Not found nothing" look identical from
    // the outside. dbg() closes that gap by narrating every decision, the negative ones
    // included.
    //
    // It is written unconditionally, and that is the whole point. The recurring difficulty
    // with this script was that the broken case is the one with no observer in it: turning
    // a narration mode ON to find out why something failed changed the timing enough to
    // make it succeed, so the failing case was never the one being watched. That is
    // precisely what the old debug mode's five-second delay did, and it produced three
    // rounds of misdiagnosis before the trace replaced it. Debug mode was removed in
    // v0.9.0 having been made redundant; do not reintroduce a mode that alters timing.

    // Written straight to GM storage from whichever frame produced the line — GM storage
    // is shared across frames, so this needs no messaging and works in a frame whose
    // parent never hears from it. Timestamps are wall clock plus milliseconds since this
    // document started, because "how long after the page began" is the number that has
    // mattered every single time.
    const T0 = Date.now();
    function dbg(m) {
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
                if (mine && mine.key === d.host) runTest(d.seqIndex | 0, d.stepIndex | 0);
                break;
            }
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
        // APPENDS. Teaching a popup found three pages into a site must not wipe the age
        // gate taught on its landing page — that is the whole reason `clicks` is a list.
        // Deleting a sequence is Settings' job, and it is per-sequence there.
        const seq = newSeq(teachState.steps);
        const kept = seqsOf(prev);
        rules[host] = {
            v: SCHEMA_V,
            host,
            subdomains: !!teachState.subdomains,
            enabled: prev ? prev.enabled !== false : true,
            clicks: kept.concat([seq]),
            prefs: (prev && prev.prefs) || null
        };
        saveRules(rules);
        const n = teachState.steps.length;
        const total = rules[host].clicks.length;
        log('“' + seqName(seq, total - 1) + '” saved for ' + host + ' (' + n +
            (n === 1 ? ' click' : ' clicks') + '; ' + total +
            (total === 1 ? ' sequence for this host)' : ' sequences for this host)'));
        endTeaching();
        toast('Forget Me Not: saved ' + n + (n === 1 ? ' click' : ' clicks') + ' for ' + host +
              (total > 1 ? ' — ' + total + ' sequences now taught here.' : '.'));
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

    // ---------------- Shared UI bits ----------------
    // Used by both halves. The prefs review panel and Settings are the one place the
    // click runner and the preference replayer are meant to share anything, so these
    // live at module scope rather than being duplicated on each side of the seam.
    function smallBtn(label, bg, fg) {
        const b = document.createElement('button');
        b.textContent = label;
        b.style.cssText = 'padding: 4px 10px; border-radius: 6px; border: none; font-size: 12px;' +
            'font-weight: 700; cursor: pointer; white-space: nowrap; background: ' + bg +
            '; color: ' + (fg || '#1e1e2e') + ';';
        return b;
    }
    function mkCheck(checked, onChange) {
        const c = document.createElement('input');
        c.type = 'checkbox';
        c.checked = checked;
        c.style.cssText = 'accent-color: #89b4fa; cursor: pointer;';
        c.addEventListener('change', () => onChange(c.checked));
        return c;
    }

    // ---------------- Preferences: the baseline ----------------
    // A capture is a diff, so it needs a "before", and choosing the wrong one is a
    // mistake this project has already paid for twice on the click side. Snapshotting at
    // document-start would put the site's entire start-up in the diff — on Wikipedia that
    // is `client-js`, `mw-ready`, `vector-sticky-header-visible` and every session and
    // analytics key the page writes — burying the one line that matters, exactly as the
    // v0.6.0 success test was buried by the same churn.
    //
    // The baseline is therefore "the state of the page at the last moment before you
    // touched anything": one snapshot, taken in a capture-phase listener on the first
    // pointerdown / keydown / click. The capture path starts at `window`, so this runs
    // before any handler the site has on the element — the page has not yet reacted to
    // the click when the snapshot is taken.
    //
    // docs/PREFS.md specifies this as a rolling snapshot re-taken every ~500ms and frozen
    // at first interaction. Same definition, and the polling is not needed to reach it:
    // freezing AT the interaction is strictly more accurate (a poll is up to 500ms stale),
    // costs nothing on a page nobody touches, and — the reason that actually decided it —
    // it can tell "you never interacted with this page" apart from "you interacted and
    // nothing changed". Rolling silently merges those two into an empty diff, which is
    // the wrong answer for the common case of setting a preference inside an embedded
    // frame, whose events the top frame never sees. The rejected `load`+2000ms design
    // stays rejected: an early scroll would freeze it before the site had finished
    // starting up, which is the one thing the baseline exists to prevent.
    //
    // Deliberately NOT gated on the master switch. Off means nothing fires; taking a
    // snapshot fires nothing, and gating it would mean switching Forget Me Not on
    // mid-visit left you with no before-state and no way to know why.
    const PREF_MAX_VALUE = 4096;      // longest value worth carrying into GM storage
    const FREEZE_ON = ['pointerdown', 'keydown', 'click'];

    let baseline = null;              // frozen snapshot, or null until first interaction
    // Set in EVERY frame, unlike the baseline: replay is per frame, and "has the user
    // touched this document?" is the question that stops re-assertion from stamping a
    // preference back over one they deliberately changed mid-visit.
    let touched = false;

    function storeMap(store) {
        const o = {};
        // Storage throws outright in a sandboxed frame and on a site the user has
        // blocked it for. A capture that cannot see storage is still a valid capture of
        // the DOM, so this degrades to an empty map rather than taking the panel down.
        try {
            for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                if (k !== null) o[k] = store.getItem(k);
            }
        } catch (_) {}
        return o;
    }

    // Class is pulled out of the attribute map: it is the one attribute with add/remove
    // semantics, and reporting it in both places would offer the user the same change
    // twice under two shapes.
    function elState(el) {
        if (!el) return null;
        const attrs = {};
        try {
            for (const a of el.attributes) if (a.name !== 'class') attrs[a.name] = a.value;
        } catch (_) {}
        return {
            cls: (el.getAttribute('class') || '').split(/\s+/).filter(Boolean),
            attrs
        };
    }

    const snapshot = () => ({
        t: Date.now(),
        root: elState(document.documentElement),
        body: elState(document.body),
        ls: storeMap(localStorage),
        ss: storeMap(sessionStorage)
    });

    (function watchInteraction() {
        const onTouch = (e) => {
            // TRUSTED events only, and this is load-bearing rather than fastidious: the
            // click runner dispatches its own pointerdown/click, so without this guard a
            // host that has both a taught gate and preferences froze its baseline at
            // ~7ms — document-start in all but name, the very design the baseline exists
            // to replace — and switched re-assertion off before the page had finished
            // loading. Measured on fixture-simple.html with both halves on one host.
            // Another userscript clicking the page is not the user either.
            if (!e.isTrusted) return;
            touched = true;
            if (isTop && !baseline) {
                // Narrate BEFORE snapshotting, not after. Under tests/gm-shim.js the trace
                // lives in the page's own localStorage, so a line written after the
                // snapshot would show up in every capture diff as a storage change the
                // site never made. Costs nothing in the real script, where GM storage is
                // a separate store.
                dbg('preference baseline frozen at first ' + e.type +
                    ' — everything the site did before this is its own start-up, not a preference');
                baseline = snapshot();
                baseline.why = e.type;
            }
            for (const t of FREEZE_ON) window.removeEventListener(t, onTouch, true);
        };
        for (const t of FREEZE_ON) window.addEventListener(t, onTouch, { capture: true, passive: true });
    })();

    // ---------------- Preferences: the classifier ----------------
    // Annotates and pre-decides; it never blocks. The user is the gate. It exists to save
    // labour on the question the review panel actually asks — "which of these did you
    // mean to set?" — and is not an authority on safety.
    const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    const ID_WORDS = ['id', 'ids', 'uid', 'uuid', 'guid', 'sid', 'session', 'token', 'auth',
                      'visitor', 'device', 'fingerprint', 'tracking', 'analytics'];

    // Whole words only, splitting on punctuation AND camelCase humps. A bare substring
    // test is unusable here: "id" is inside `sidebar`, `hidden`, `width` and `provider`,
    // so it would arrive unticked on the very preferences this feature exists to keep.
    function nameWords(name) {
        return String(name)
            .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
            .split(/[^A-Za-z0-9]+/)
            .map(w => w.toLowerCase())
            .filter(Boolean);
    }

    function classify(name, value) {
        const v = value == null ? '' : String(value);
        // Value first, then the name: when both fire, "looks like a UUID" tells the user
        // more than "the key is called clickId" does.
        if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))
            return { flag: 'idlike', why: 'looks like a UUID' };
        if (UUID_RE.test(v))
            return { flag: 'idlike', why: 'contains a UUID' };
        if (/^\d{10,}$/.test(v))
            return { flag: 'idlike', why: 'a ' + v.length + '-digit number — almost always a timestamp or an id' };
        if (v.length >= 24 && /^[A-Za-z0-9+/]+={0,2}$/.test(v) && /[A-Z]/.test(v) && /[a-z]/.test(v))
            return { flag: 'idlike', why: 'looks like base64 or a token (' + v.length + ' chars)' };
        if (v.length >= 32 && /[A-Z]/.test(v) && /[a-z]/.test(v) && /[0-9]/.test(v))
            return { flag: 'idlike', why: 'a long mixed-case token (' + v.length + ' chars)' };
        if (v.length > 200)
            return { flag: 'idlike', why: 'a long value (' + v.length + ' chars) — contents not reviewed' };
        const words = nameWords(name);
        const hit = ID_WORDS.find(w => words.includes(w));
        if (hit) return { flag: 'idlike', why: 'the name contains “' + hit + '”' };
        return { flag: 'ok', why: '' };
    }

    // ---------------- Preferences: the diff ----------------
    // Identity of an entry, used to merge a fresh capture into prefs already stored so a
    // second capture cannot wipe the first — the same rule teaching follows since v0.11.0.
    // A class entry is identified by the class NAME, not by whether this capture added or
    // removed it. On one element a class is either present or absent, so "+theme-dark"
    // and "−theme-dark" are two states of one entry, not two entries — and treating them
    // as two is incoherent the moment the user flips a preference and captures again:
    // the stored set would then say both add it and remove it. That makes a class behave
    // exactly like an attribute, where the name is the identity and the value is the state.
    const entryId = (e) =>
        e.kind + '|' + (e.sel || '') + '|' +
        (e.kind === 'class' ? ((e.add && e.add.length) ? e.add[0] : (e.remove || [])[0])
            : e.kind === 'attr' ? e.name : e.key);

    // What this entry currently says, for "has it changed since we last saw it?".
    const entryState = (e) => e.kind === 'class'
        ? ((e.add && e.add.length) ? '+' : '-')
        : (e.value === null ? ' absent' : String(e.value));

    function classDiff(a, b, sel, out) {
        // One entry per class, not one entry carrying two arrays. The workflow is to trim
        // until it stops working and step back one, and that is impossible if six of
        // Wikipedia's clientpref classes arrive welded into a single tick box.
        for (const c of b.cls) if (!a.cls.includes(c)) {
            const k = classify(c, c);
            out.push({ kind: 'class', sel, add: [c], remove: [], flag: k.flag, why: k.why });
        }
        for (const c of a.cls) if (!b.cls.includes(c)) {
            const k = classify(c, c);
            out.push({ kind: 'class', sel, add: [], remove: [c], flag: k.flag, why: k.why });
        }
    }

    function attrDiff(a, b, sel, out) {
        for (const n of Object.keys(b.attrs)) {
            if (a.attrs[n] === b.attrs[n]) continue;
            const k = classify(n, b.attrs[n]);
            out.push({ kind: 'attr', sel, name: n, value: b.attrs[n], flag: k.flag, why: k.why });
        }
        // A DOM removal IS replayable and a storage removal is not, and the asymmetry is
        // worth stating: the document is served identically on every visit, so an
        // attribute the user cleared is back again next time and has to be cleared again.
        // A storage key they deleted was never there to begin with in a fresh container.
        for (const n of Object.keys(a.attrs)) {
            if (n in b.attrs) continue;
            out.push({ kind: 'attr', sel, name: n, value: null, flag: 'ok', why: '' });
        }
    }

    function storeDiff(a, b, kind, out, notes) {
        for (const key of Object.keys(b)) {
            if (a[key] === b[key]) continue;
            if (String(b[key]).length > PREF_MAX_VALUE) { notes.big++; continue; }
            const k = classify(key, b[key]);
            out.push({ kind, key, value: b[key], flag: k.flag, why: k.why });
        }
        for (const key of Object.keys(a)) if (!(key in b)) notes.gone++;
    }

    function diffPrefs(base, now) {
        const out = [], notes = { gone: 0, big: 0 };
        if (base.root && now.root) { classDiff(base.root, now.root, ':root', out); attrDiff(base.root, now.root, ':root', out); }
        if (base.body && now.body) { classDiff(base.body, now.body, 'body', out); attrDiff(base.body, now.body, 'body', out); }
        storeDiff(base.ls, now.ls, 'ls', out, notes);
        storeDiff(base.ss, now.ss, 'ss', out, notes);
        for (const e of out) e.enabled = e.flag === 'ok';
        return { entries: out, notes };
    }

    // ---------------- Preferences: the review panel ----------------
    // ONE panel, built once, shown in two places: straight after "Remember this site"
    // with the fresh diff in it, and re-opened per host from Settings. Both are needed —
    // the decision wants the context you have at capture time, and the trim-until-it-
    // breaks workflow is impossible if review only ever happens once.
    const KIND_ORDER = ['class', 'attr', 'ls', 'ss'];
    const KIND_TITLE = {
        class: 'Classes on the page',
        attr: 'Attributes on the page',
        ls: 'localStorage',
        ss: 'sessionStorage'
    };

    function entryLabel(e) {
        if (e.kind === 'class') return e.sel + '  ' + (e.add.length ? '+ ' + e.add[0] : '− ' + e.remove[0]);
        if (e.kind === 'attr') return e.sel + '  ' + e.name + (e.value === null ? '  (removed)' : '');
        return e.key;
    }
    const shortVal = (v, n) => (v == null ? '' : (v.length > n ? v.slice(0, n) + '…' : v));

    // The one rule that keeps this honest: an entry the user left unticked AND the
    // classifier called id-like does not get its value written to GM storage. Replay
    // would never have used it, and keeping a copy of the identifier the container exists
    // to destroy — in the one store the container cannot reach — is the exact harm this
    // project is built to avoid. The key and the reason are kept, so re-opening the panel
    // still shows that you excluded it; re-ticking it needs a fresh capture.
    const keepsValue = (e) => e.enabled || e.flag !== 'idlike';
    function forStorage(e) {
        const o = Object.assign({}, e);
        delete o.fresh;
        if ((o.kind === 'ls' || o.kind === 'ss' || o.kind === 'attr') && !keepsValue(o)) {
            o.value = null;
            o.redacted = true;
        }
        return o;
    }

    function savePrefs(hostKey, entries, capturedAt) {
        const rules = getRules();
        const prev = rules[hostKey];
        const kept = entries.map(forStorage);
        // Mirror of the per-sequence delete in Settings: a host with nothing taught and
        // nothing remembered is clutter, and leaving the husk behind means the rule list
        // fills up with entries that do nothing and cannot be explained.
        if (!kept.length && !seqsOf(prev).length) {
            delete rules[hostKey];
            saveRules(rules);
            return;
        }
        rules[hostKey] = {
            v: SCHEMA_V,
            host: hostKey,
            subdomains: prev ? !!prev.subdomains : false,
            enabled: prev ? prev.enabled !== false : true,
            clicks: seqsOf(prev),
            prefs: kept.length ? { captured: capturedAt || new Date().toISOString(), entries: kept } : null
        };
        saveRules(rules);
    }

    function openPrefsReview(hostKey, entries, opts) {
        if (!isTop || document.getElementById('gs-prefs')) return;
        const o = opts || {};

        const host = document.createElement('div');
        host.id = 'gs-prefs';
        host.style.cssText = 'all: initial;';
        const root = host.attachShadow({ mode: 'open' });
        const reset = document.createElement('style');
        reset.textContent = ':host { all: initial; } * { box-sizing: border-box; }';
        root.appendChild(reset);

        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 2147483647; background: rgba(0,0,0,0.6);
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
        title.textContent = 'Forget Me Not — what to remember for ' + hostKey;

        // The framing is load-bearing, not decorative. Asked "which of these look risky?"
        // the user is being made to audit entropy, which they cannot do and should not
        // have to. Asked "which did you mean to set?" they answer at a glance, and that
        // question is the one that actually separates the state they caused (free to
        // replay — they would have clicked it anyway) from the state the site caused
        // (which the container was going to destroy).
        const desc = document.createElement('div');
        desc.style.cssText = 'font-size: 12px; color: #9399b2; line-height: 1.45;';
        desc.textContent = 'Which of these did you mean to set? Tick those and they will be put back on ' +
            'every visit, before the page loads. Nothing is sent to the site — these values are kept here ' +
            'and written into your own browser. Fewer is better: keep the smallest set that works.';

        const list = document.createElement('div');
        list.style.cssText = 'flex: 1; min-height: 100px; overflow: auto; display: flex; flex-direction: column;' +
            'gap: 10px; border: 1px solid #313244; border-radius: 8px; padding: 8px;';

        function drawRows() {
            while (list.firstChild) list.removeChild(list.firstChild);
            if (!entries.length) {
                const empty = document.createElement('div');
                empty.style.cssText = 'color: #6c7086; font-size: 12px; padding: 8px;';
                empty.textContent = 'Nothing captured for this host.';
                list.appendChild(empty);
                return;
            }
            for (const kind of KIND_ORDER) {
                const group = entries.filter(e => e.kind === kind);
                if (!group.length) continue;

                const gh = document.createElement('div');
                gh.style.cssText = 'font-size: 11px; font-weight: 700; color: #89b4fa; text-transform: uppercase;' +
                    'letter-spacing: .04em; margin-top: 2px;';
                gh.textContent = KIND_TITLE[kind];
                list.appendChild(gh);

                for (const e of group) {
                    const row = document.createElement('div');
                    row.style.cssText = 'background: #313244; border-radius: 8px; padding: 6px 10px;' +
                        'display: flex; gap: 8px; align-items: flex-start;';

                    const cb = mkCheck(!!e.enabled, (v) => {
                        e.enabled = v;
                        // Re-drawn rather than mutated in place so the redaction warning
                        // on an id-like row appears and disappears with the tick, which is
                        // the only moment the user can see that rule operating.
                        drawRows();
                    });
                    cb.style.cssText += 'margin-top: 2px;';
                    // A redacted entry has no value left, so there is nothing here to tick
                    // — the box is empty, not forbidden. This is not the classifier
                    // blocking a decision (it never does); it is the only state where
                    // ticking could not possibly do anything, and a control that silently
                    // does nothing is worse than one that explains itself.
                    if (e.redacted) {
                        cb.disabled = true;
                        cb.title = 'Its value was not kept, so there is nothing to put back. ' +
                            'Capture this site again to review it with its value.';
                    }

                    const body = document.createElement('div');
                    body.style.cssText = 'flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px;';

                    const head = document.createElement('div');
                    head.style.cssText = 'display: flex; gap: 6px; align-items: baseline;';
                    const name = document.createElement('span');
                    name.style.cssText = 'font-size: 12px; font-weight: 700; overflow: hidden;' +
                        'text-overflow: ellipsis; white-space: nowrap;';
                    name.textContent = entryLabel(e);
                    name.title = entryLabel(e);
                    head.appendChild(name);
                    if (e.fresh && o.merged) {
                        const tag = document.createElement('span');
                        tag.style.cssText = 'font-size: 10px; color: #1e1e2e; background: #a6e3a1;' +
                            'border-radius: 4px; padding: 0 5px; font-weight: 700;';
                        tag.textContent = 'new';
                        head.appendChild(tag);
                    }
                    body.appendChild(head);

                    if (e.kind === 'ls' || e.kind === 'ss' || (e.kind === 'attr' && e.value !== null)) {
                        const val = document.createElement('div');
                        val.style.cssText = 'font: 11px/1.4 ui-monospace, Consolas, monospace; color: #a6adc8;' +
                            'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                        val.textContent = e.redacted && !e.enabled
                            ? '(value not kept — re-capture to restore it)'
                            : shortVal(String(e.value), 140);
                        val.title = e.redacted && !e.enabled ? '' : String(e.value == null ? '' : e.value);
                        body.appendChild(val);
                    }

                    if (e.flag === 'idlike') {
                        const why = document.createElement('div');
                        why.style.cssText = 'font-size: 11px; color: ' + (e.enabled ? '#f9e2af' : '#9399b2') + ';';
                        why.textContent = (e.enabled ? '⚠ ' : '') + e.why +
                            (e.enabled ? ' — you have chosen to replay it anyway.'
                                       : ' — left out, and its value will not be stored.');
                        body.appendChild(why);
                    }

                    row.append(cb, body);
                    list.appendChild(row);
                }
            }
        }
        drawRows();

        const notes = document.createElement('div');
        notes.style.cssText = 'font-size: 11px; color: #6c7086; line-height: 1.45;';
        const noteBits = [];
        if (o.notes && o.notes.gone) {
            noteBits.push(o.notes.gone + ' storage key(s) the site deleted are not listed — a deletion ' +
                'cannot be replayed into a fresh container, where the key was never there.');
        }
        if (o.notes && o.notes.big) {
            noteBits.push(o.notes.big + ' value(s) over ' + PREF_MAX_VALUE + ' characters were left out as too large to carry.');
        }
        if (o.capturedAt && !o.merged) noteBits.push('Captured ' + new Date(o.capturedAt).toLocaleString() + '.');
        notes.textContent = noteBits.join(' ');

        const foot = document.createElement('div');
        foot.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap; align-items: center;';
        const status = document.createElement('span');
        status.style.cssText = 'font-size: 11px; color: #a6e3a1; flex: 1; min-width: 0;' +
            'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';

        const commit = () => {
            const on = entries.filter(e => e.enabled).length;
            savePrefs(hostKey, entries, o.merged || !o.capturedAt ? null : o.capturedAt);
            log(on + ' preference(s) saved for ' + hostKey + ' (' + entries.length + ' reviewed)');
            dbg('saved ' + on + ' of ' + entries.length + ' preference entries for ' + hostKey);
            return on;
        };

        const saveBtn = smallBtn('Save', '#a6e3a1');
        saveBtn.title = 'Keep the ticked entries. Nothing is applied until the next load.';
        saveBtn.addEventListener('click', () => {
            const on = commit();
            host.remove();
            toast('Forget Me Not: remembering ' + on + (on === 1 ? ' thing' : ' things') + ' for ' + hostKey + '.');
        });

        // Trimming is the intended workflow — untick, reload, see whether the site still
        // looks right, and step back one when it does not — so the reload has to be here
        // rather than something the user is told to go and do.
        const saveGo = smallBtn('Save & reload', '#89b4fa');
        saveGo.title = 'Save, then reload the page to see whether this set is enough.';
        saveGo.addEventListener('click', () => { commit(); location.reload(); });

        const forgetBtn = smallBtn('Forget these', '#f38ba8');
        forgetBtn.title = 'Drop every preference stored for this host. Taught clicks are left alone.';
        forgetBtn.addEventListener('click', () => {
            savePrefs(hostKey, [], null);
            log('preferences cleared for ' + hostKey);
            host.remove();
            toast('Forget Me Not: forgot the preferences for ' + hostKey + '.');
        });

        const cancel = smallBtn('Cancel', '#45475a', '#cdd6f4');
        cancel.addEventListener('click', () => host.remove());

        foot.append(saveBtn, saveGo, forgetBtn, status, cancel);

        panel.append(title, desc, list, notes, foot);
        overlay.appendChild(panel);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) host.remove(); });
        root.appendChild(overlay);
        document.documentElement.appendChild(host);
    }

    // ---------------- Preferences: "Remember this site" ----------------
    function captureNow() {
        if (!isTop) return;
        if (!baseline) {
            toast('Forget Me Not: I have no “before” for this page yet. Set the site up the way ' +
                  'you like it — click something — then choose this again.');
            dbg('capture asked for with no baseline — nothing has been interacted with on this page');
            return;
        }
        const hit = ruleForHost(location.hostname);
        const hostKey = hit ? hit.key : location.hostname;
        const stored = (hit && hit.rule && hit.rule.prefs) || null;
        const prev = (stored && Array.isArray(stored.entries)) ? stored.entries.slice() : [];

        const { entries, notes } = diffPrefs(baseline, snapshot());

        // A second capture MERGES, for the same reason teaching appends: a preference set
        // three pages into a site must not wipe the one set on the landing page.
        //
        // An entry already reviewed keeps the DECISION the user made about it, but takes
        // the NEW VALUE. Those pull in opposite directions and both are needed: dropping
        // the new value means changing a preference and re-capturing silently stores the
        // old one, while dropping the decision means every re-capture re-ticks something
        // the user deliberately excluded. Only the value is the site's to update; the tick
        // is the user's.
        const byId = new Map(prev.map(e => [entryId(e), e]));
        let added = 0, changed = 0;
        for (const e of entries) {
            const old = byId.get(entryId(e));
            if (!old) { e.fresh = true; byId.set(entryId(e), e); added++; continue; }
            const moved = entryState(old) !== entryState(e) || old.redacted;
            if (e.kind === 'class') { old.add = e.add; old.remove = e.remove; }
            else old.value = e.value;
            old.flag = e.flag;
            old.why = e.why;
            delete old.redacted;
            if (moved) { old.fresh = true; changed++; }
        }
        const merged = Array.from(byId.values());
        const fresh = merged.filter(e => e.fresh);

        if (!merged.length) {
            toast('Forget Me Not: nothing has changed on this page since you first touched it.');
            dbg('capture found no differences from the baseline');
            return;
        }
        dbg('captured ' + added + ' new and ' + changed + ' updated change(s) since the baseline (' +
            fresh.filter(e => e.enabled).length + ' of those ticked), ' + prev.length + ' already stored');
        openPrefsReview(hostKey, merged, {
            notes,
            merged: prev.length > 0,
            capturedAt: stored ? stored.captured : null
        });
    }

    // ---------------- Preferences: replay ----------------
    // Runs at document-start, in EVERY frame, for whatever rule matches that frame's own
    // host — capture is top-frame only, replay is not, and the asymmetry is intended: a
    // frame gets the rule for its own host, or it gets nothing.
    //
    // No interaction with the click runner, by design. If replay makes a gate not appear,
    // the runner simply never matches step 1 and says so. The two halves share the
    // settings UI, the host-keyed storage and the trace, and nothing else — which is why
    // this section registers its own load listeners rather than joining boot().
    const REASSERT_AT = 1000;         // ms after load, the last re-application
    // Bounded so a site that rewrites the root element in response to every change cannot
    // turn this into a ping-pong. Five is plenty for a start-up that assigns className
    // once or twice; a site that needs more than five is one to find out about, not to
    // out-stubborn.
    const EARLY_FIXES = 5;

    function prefsHere() {
        if (!isOn()) return null;     // off means BOTH halves off. One switch.
        const hit = ruleForHost(location.hostname);
        const p = hit && hit.rule && hit.rule.prefs;
        if (!p || !Array.isArray(p.entries)) return null;
        // A redacted entry has no value left to write. It is already unticked, so this is
        // belt-and-braces — but a hand-edited or imported rule could tick one, and that
        // must not end with the string "null" written into a site's storage.
        const on = p.entries.filter(e => e && e.enabled && !e.redacted);
        return on.length ? { key: hit.key, entries: on } : null;
    }

    const targetFor = (sel) => (sel === 'body' ? document.body : document.documentElement);

    // true / false / null, where null means "cannot tell yet" — <body> at document-start.
    function domHolds(e) {
        const el = targetFor(e.sel);
        if (!el) return null;
        if (e.kind === 'class') {
            return (e.add && e.add.length) ? el.classList.contains(e.add[0])
                                           : !el.classList.contains((e.remove || [])[0]);
        }
        return e.value === null ? !el.hasAttribute(e.name) : el.getAttribute(e.name) === e.value;
    }

    function applyDomEntry(e) {
        const el = targetFor(e.sel);
        if (!el) return false;
        try {
            if (e.kind === 'class') {
                if (e.add && e.add.length) el.classList.add(e.add[0]);
                else el.classList.remove((e.remove || [])[0]);
            } else if (e.value === null) {
                el.removeAttribute(e.name);
            } else {
                el.setAttribute(e.name, e.value);
            }
        } catch (_) { return false; }
        return true;
    }

    // Written once, at document-start, before any site script — that is the whole trick of
    // rung 2. Never re-asserted: by the time a site has started up it has already read
    // whatever it was going to read, and writing again mid-visit would only fight a value
    // the site chose, invisibly, until the next load.
    function replayStorage(entries) {
        let wrote = 0, kept = 0;
        for (const e of entries) {
            if (e.kind !== 'ls' && e.kind !== 'ss') continue;
            if (e.value == null) continue;
            const store = e.kind === 'ls' ? localStorage : sessionStorage;
            try {
                // ONLY IF ABSENT. Replay exists to restore what the container destroyed;
                // a value still sitting there was not destroyed, which means this browser
                // kept it and the user may have changed it since. Overwriting would stamp
                // an old preference back over a newer one — the same harm as re-clicking a
                // toggle that stayed on screen.
                if (store.getItem(e.key) !== null) { kept++; continue; }
                store.setItem(e.key, String(e.value));
                wrote++;
            } catch (_) {}
        }
        return { wrote, kept };
    }

    const replayed = new Map();       // entryId → applied at least once in this document
    const reasserted = new Map();     // entryId → how many times the site overwrote it

    function replayDom(entries) {
        const first = [], back = [];
        for (const e of entries) {
            if (e.kind !== 'class' && e.kind !== 'attr') continue;
            const holds = domHolds(e);
            if (holds === null) continue;             // <body> not built yet; try next pass
            const id = entryId(e);
            if (!replayed.has(id)) {
                // The FIRST application of an entry always happens, even after the user has
                // touched the page. A body entry cannot be written before <body> exists, so
                // gating this on `touched` too would mean a click during parsing silently
                // cost you every preference on <body>.
                if (!holds) applyDomEntry(e);
                replayed.set(id, true);
                first.push(entryLabel(e));
                continue;
            }
            if (holds) continue;
            // Re-assertion, and it stops at the first user interaction: a preference the
            // user deliberately changed mid-visit must not be put back.
            if (touched) continue;
            if (applyDomEntry(e)) {
                reasserted.set(id, (reasserted.get(id) || 0) + 1);
                back.push(entryLabel(e));
            }
        }
        return { first, back };
    }

    // The health signal. A pass that changed nothing is not a re-application and writes no
    // line: docs/PREFS.md asks for a trace line per re-application, and a heartbeat on
    // every quiet pass would bury the one that matters under four times as many that do
    // not. A site that needs re-asserting is a site that is fighting us, and one that
    // suddenly starts needing it has changed under the rule.
    function replayPass(why, entries) {
        const r = replayDom(entries);
        if (r.first.length) dbg('applied at ' + why + ': ' + r.first.join(', '));
        if (r.back.length) {
            dbg('re-asserted at ' + why + ': ' + r.back.join(', ') +
                ' — the site had overwritten ' + (r.back.length === 1 ? 'it' : 'them'));
        }
    }

    // Called once, immediately after the last re-application. Without it, a replay that was
    // quietly undone looks identical in the trace to one that worked — and a log claiming
    // something happened when it did not is the failure mode that cost this project three
    // versions on the click side. This is what makes the claim auditable.
    function auditPrefs(entries) {
        const dom = entries.filter(e => e.kind === 'class' || e.kind === 'attr');
        if (!dom.length) return;
        if (touched) { dbg('no preference audit — you interacted with the page, so anything that changed is yours'); return; }

        const lost = dom.filter(e => domHolds(e) === false).map(entryLabel);
        // "It holds" and "it holds because we kept putting it back" are not the same
        // result, and a summary that conflates them is exactly the unauditable verdict
        // this project has been bitten by. A site that overwrites is one that will win as
        // soon as it moves its overwrite past the last re-assertion — and if a storage
        // entry exists for the same preference, that is the steadier rung. This line is
        // how the user finds out which case they are in.
        const fought = dom.filter(e => reasserted.get(entryId(e))).length;
        const how = fought ? ' (' + fought + ' of them only because ' +
            (fought === 1 ? 'it was' : 'they were') + ' put back after the site overwrote ' +
            (fought === 1 ? 'it' : 'them') + ')' : '';
        if (lost.length) {
            reportLost(lost, dom.length);
        } else {
            dbg('all ' + dom.length + ' page preference(s) hold as re-assertion finishes' + how);
        }
        watchForLosses(dom);
    }

    function reportLost(lost, total) {
        dbg('LOST ' + lost.length + ' of ' + total + ' page preference(s) — re-assertion has finished and the site has put ' +
            (lost.length === 1 ? 'it' : 'them') + ' back: ' + lost.join(', '));
        log(lost.length + ' preference(s) did not survive: ' + lost.join(', '));
    }

    // A check at one fixed moment cannot see a site that takes the preference away later,
    // and that is not hypothetical: `fixture-pref-hostile.html?reset=6000` normalises the
    // root class after the last re-application, and a timed audit reported "all preferences
    // still hold" over a page that was already back in light mode three seconds later.
    // A trace that says that is worse than one that says nothing.
    //
    // So the audit's positive line is scoped to what it can actually see ("as re-assertion
    // finishes"), and everything after it is covered by this: observe, never re-apply,
    // report the first loss and stop. Re-applying here would be the hazard re-assertion is
    // already bounded to avoid — an endless fight with the site, and with the user.
    // Which attributes any of these entries can possibly be affected by.
    function attrNamesOf(dom) {
        const names = ['class'];
        for (const e of dom) if (e.kind === 'attr' && names.indexOf(e.name) === -1) names.push(e.name);
        return names;
    }

    // The scheduled passes are DOMContentLoaded / load / load+1s, and on Wikipedia that is
    // not soon enough. Measured 2026-08-17 on its own served markup: we write the theme
    // class at +1ms, MediaWiki's `client-nojs` → `client-js` script ASSIGNS THE WHOLE
    // className from a string it captured earlier at +2ms — restoring the light theme — and
    // the DOMContentLoaded pass does not put it back until +54ms. On a real page load
    // DOMContentLoaded is far later than that and first paint can easily land inside the
    // gap, which is a visible flash of the theme the user rejected.
    //
    // So drift during start-up is repaired on the mutation that causes it, not on a timer.
    // It hands over to the scheduled passes at DOMContentLoaded and is bounded by
    // EARLY_FIXES. Note this is a REPAIRING observer, unlike watchForLosses below, and the
    // difference is deliberate: before the user has touched anything, putting a preference
    // back is what we are for; after re-assertion has finished, only reporting is.
    function watchEarlyDrift(entries) {
        const dom = entries.filter(e => e.kind === 'class' || e.kind === 'attr');
        if (!dom.length) return;
        let obs = null, fixes = 0;
        const stop = () => { try { obs.disconnect(); } catch (_) {} obs = null; };
        try {
            obs = new MutationObserver(() => {
                if (!obs) return;
                if (touched || fixes >= EARLY_FIXES) { stop(); return; }
                if (!dom.some(e => replayed.has(entryId(e)) && domHolds(e) === false)) return;
                fixes++;
                replayPass('start-up', entries);
            });
            obs.observe(document.documentElement,
                { attributes: true, subtree: true, attributeFilter: attrNamesOf(dom) });
        } catch (_) { return; }
        document.addEventListener('DOMContentLoaded', () => { if (obs) stop(); }, { once: true });
    }

    function watchForLosses(dom) {
        const names = attrNamesOf(dom);
        let obs = null;
        const stop = () => { try { obs.disconnect(); } catch (_) {} obs = null; };
        try {
            obs = new MutationObserver(() => {
                if (!obs) return;
                if (touched) { stop(); return; }
                const lost = dom.filter(e => domHolds(e) === false).map(entryLabel);
                if (!lost.length) return;
                stop();
                reportLost(lost, dom.length);
            });
            obs.observe(document.documentElement,
                { attributes: true, subtree: true, attributeFilter: names });
        } catch (_) {}
    }

    (function replayBoot() {
        const p = prefsHere();
        if (!p) return;
        const s = replayStorage(p.entries);
        const d = replayDom(p.entries);
        dbg('replaying preferences for ' + p.key + ' — storage: wrote ' + s.wrote + ', left ' + s.kept +
            ' already there' + (d.first.length ? '; page: ' + d.first.join(', ') : '; nothing on the page yet'));

        const later = (why) => replayPass(why, p.entries);
        if (document.readyState === 'loading') {
            watchEarlyDrift(p.entries);     // only meaningful while the page is still parsing
            document.addEventListener('DOMContentLoaded', () => later('DOM ready'), { once: true });
        } else {
            later('DOM ready');
        }
        const onLoad = () => {
            later('load');
            setTimeout(() => {
                later('load+' + (REASSERT_AT / 1000) + 's');
                auditPrefs(p.entries);          // immediately after the LAST re-application
            }, REASSERT_AT);
        };
        if (document.readyState === 'complete') setTimeout(onLoad, 0);
        else window.addEventListener('load', onLoad, { once: true });
    })();

    // ---------------- Testing a rule against this page ----------------
    let testWait = null;   // { key, found } while a broadcast test is outstanding

    function runTest(seqIndex, stepIndex) {
        const hit = ruleForHost(location.hostname);
        if (!hit) return;
        const seq = seqsOf(hit.rule)[seqIndex];
        if (!seq || !seq.steps || !seq.steps.length) return;
        const step = seq.steps[stepIndex] || seq.steps[0];
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
        toast('Forget Me Not: found step 1 of “' + testWait.name + '” — highlighted in green.');
    }

    // Asks every frame, including this one, and treats "nobody answered" as the negative.
    function startTest(key, seqIndex, name) {
        testWait = { key, name, found: false };
        broadcast({ type: 'test', host: key, seqIndex: seqIndex | 0, stepIndex: 0 });
        setTimeout(() => {
            if (testWait && testWait.key === key && !testWait.found) {
                toast('Forget Me Not: “' + name + '” matches nothing on this page right now.');
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
            '"Remember this site" captures the preferences you just set and puts them back on every ' +
            'later visit, without telling the site anything. "Teach this page" is the fallback for ' +
            'state that is not stored anywhere: it records the clicks you make to dismiss a gate and ' +
            'repeats them, for about ' + Math.round(watchDefault() / 1000) + ' seconds after each load.';

        // smallBtn / mkCheck are module scope — see "Shared UI bits".

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

        globalRow.append(onLabel, watchLabel);

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

                const seqs = seqsOf(r);
                const pEntries = (r.prefs && Array.isArray(r.prefs.entries)) ? r.prefs.entries : [];
                const meta = document.createElement('span');
                meta.style.cssText = 'font-size: 11px; color: #9399b2; white-space: nowrap;';
                meta.textContent = seqs.length + (seqs.length === 1 ? ' sequence' : ' sequences') +
                    (pEntries.length ? ' · ' + pEntries.filter(e => e.enabled).length + ' of ' +
                        pEntries.length + ' prefs' : '');

                // The second of the two places the one review panel appears. It is
                // re-openable per host precisely because trimming is the workflow: the
                // decision made at capture time is not the last word on it.
                const prefBtn = pEntries.length ? smallBtn('Prefs', '#cba6f7', '#11111b') : null;
                if (prefBtn) {
                    prefBtn.title = 'Review what is remembered for ' + key +
                        ' — tick, untick, or forget it entirely.';
                    prefBtn.addEventListener('click', () => {
                        host.remove();
                        openPrefsReview(key, pEntries.map(e => Object.assign({}, e)),
                                        { capturedAt: r.prefs.captured });
                    });
                }

                const delBtn = smallBtn('Delete', '#f38ba8');
                delBtn.title = 'Remove this host and every sequence taught for it.';
                delBtn.addEventListener('click', () => {
                    const rr = getRules();
                    delete rr[key];
                    saveRules(rr);
                    log('rule deleted for ' + key);
                    drawList();
                    arm(true);
                });

                head.append(en, name, meta);
                if (prefBtn) head.appendChild(prefBtn);
                head.appendChild(delBtn);

                // One block per sequence. They are independent — a host can hold the age
                // gate from its landing page and an unrelated popup from three pages in —
                // so each gets its own Test, its own Delete, and its own counters.
                const steps = document.createElement('div');
                steps.style.cssText = 'display: flex; flex-direction: column; gap: 6px; font-size: 11px; color: #a6adc8;';
                seqs.forEach((seq, si) => {
                    const block = document.createElement('div');
                    block.style.cssText = 'display: flex; flex-direction: column; gap: 2px;' +
                        'border-left: 2px solid #45475a; padding-left: 8px;';

                    const shead = document.createElement('div');
                    shead.style.cssText = 'display: flex; align-items: center; gap: 6px;';
                    const sname = document.createElement('span');
                    sname.style.cssText = 'flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis;' +
                        'white-space: nowrap; color: #cdd6f4; font-weight: 700;';
                    sname.textContent = seqName(seq, si);
                    const smeta = document.createElement('span');
                    smeta.style.cssText = 'color: #9399b2; white-space: nowrap;';
                    smeta.textContent = seq.steps.length + (seq.steps.length === 1 ? ' click · ' : ' clicks · ') +
                        'last fired ' + fmtWhen(seq.lastFired);
                    smeta.title = 'Fired ' + (seq.fires || 0) + ' time(s) since it was taught.';

                    const sTest = smallBtn('Test', '#89b4fa');
                    sTest.title = 'Look for this sequence’s first click on the page behind this dialog — in the page itself and in every frame on it.';
                    sTest.addEventListener('click', () => startTest(key, si, seqName(seq, si)));

                    const sDel = smallBtn('✕', '#f38ba8');
                    sDel.title = 'Delete just this sequence, leaving the others alone.';
                    sDel.addEventListener('click', () => {
                        const rr = getRules();
                        const list2 = seqsOf(rr[key]);
                        const at = list2.findIndex(x => x.id === seq.id);
                        if (at !== -1) list2.splice(at, 1);
                        // A host with no sequences left and no prefs is just clutter.
                        if (!list2.length && !(rr[key] && rr[key].prefs)) delete rr[key];
                        saveRules(rr);
                        log('sequence “' + seqName(seq, si) + '” deleted for ' + key);
                        drawList();
                        arm(true);
                    });
                    shead.append(sname, smeta, sTest, sDel);
                    block.appendChild(shead);

                    seq.steps.forEach((s, i) => {
                        const line = document.createElement('div');
                        line.style.cssText = 'overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
                        line.textContent = (i + 1) + '. ' + s.label;
                        line.title = s.path.map(p => p.s).join('  ≫  ');
                        block.appendChild(line);
                    });
                    steps.appendChild(block);
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

        const rememberBtn = smallBtn('Remember this site', '#cba6f7', '#11111b');
        rememberBtn.title = 'Capture what changed on ' + location.hostname +
            ' since you first touched this page, and choose what to keep.';
        rememberBtn.addEventListener('click', () => { host.remove(); captureNow(); });

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

        foot.append(teachBtn, rememberBtn, exportBtn, importBtn, traceBtn, clearTraceBtn, status, closeBtn);

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
            let n = 0, skipped = 0;
            for (const k of Object.keys(parsed)) {
                const r = parsed[k];
                // v2 only. A v1 export (flat `steps`) is rejected rather than converted —
                // there is no migration path anywhere in this script by design, and
                // silently accepting one here would be the compatibility path by the back
                // door. Re-teaching is seconds.
                const seqs = seqsOf(r).filter(s => s && Array.isArray(s.steps) && s.steps.length);
                // A host may legitimately carry preferences and no taught clicks at all —
                // that is the whole point of the replay ladder, where clicking is the
                // fallback. Requiring a sequence here silently dropped those rules.
                const pref = (r && r.prefs && Array.isArray(r.prefs.entries) && r.prefs.entries.length)
                    ? r.prefs : null;
                if (!seqs.length && !pref) { skipped++; continue; }
                rules[k] = Object.assign({ v: SCHEMA_V, host: k, subdomains: false, enabled: true },
                                         r, { clicks: seqs.map(s => Object.assign(newSeq([]), s)), prefs: pref });
                n++;
            }
            saveRules(rules);
            status.style.color = skipped ? '#f9e2af' : '#a6e3a1';
            status.textContent = 'Merged ' + n + ' rule(s).' +
                (skipped ? ' Skipped ' + skipped + ' with neither a v2 “clicks” array nor preferences — re-teach those.' : '');
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
        GM_registerMenuCommand('Forget Me Not: remember this site', captureNow);
        GM_registerMenuCommand('Forget Me Not: settings', openSettings);
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
