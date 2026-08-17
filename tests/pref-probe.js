// Shared instrument for the four preference fixtures. Loaded AFTER gm-shim.js and BEFORE
// Forget-Me-Not.user.js, so the first thing it records is the state the document was
// actually served with — before anything, ours or the site's, has touched it.
//
// This file is a measuring device only. It never changes the page, never writes storage,
// and nothing in it may affect timing: the whole reason debug mode was deleted in v0.9.0
// is that an instrument which perturbs what it measures made the failing case stop
// failing while it was being watched.
//
// Why a shared file rather than the same twelve lines inlined in each fixture (which is
// what the click fixtures do): the MutationObserver here is timing-sensitive and easy to
// get subtly wrong, and four independent copies means getting it wrong four times. The
// per-fixture verdicts stay in their own pages, where they belong.
(function () {
    const T0 = performance.now();
    const at = () => Math.round(performance.now() - T0);

    // The timeline is the point of this file. Reading an end state tells you WHAT the
    // page settled on; it cannot tell you who wrote it, in what order, or whether it was
    // written twice — which is the entire question on fixture-pref-hostile.html.
    const timeline = [];
    const push = (what, detail) => { timeline.push({ t: at(), what, detail }); };

    // The site marks its own writes. Anything in the timeline WITHOUT a site mark at the
    // same moment came from outside the page — i.e. from Forget Me Not. That is the only
    // attribution available from in here; cross-check it against GM:fmn_trace, which is
    // our side's own record.
    const mark = (what, detail) => push('site: ' + what, detail === undefined ? '' : String(detail));

    const attrsOf = (el) => {
        const o = {};
        if (!el) return o;
        for (const a of el.attributes) o[a.name] = a.value;
        return o;
    };

    // GM:* keys are excluded from every storage view here. In the real script GM storage
    // is a separate store the page cannot see; tests/gm-shim.js has to back it with
    // localStorage (it is the only synchronous store that survives a reload and is shared
    // across frames), so without this filter our own rules, log and trace would show up
    // as "site storage" in every snapshot. See the trap note in ../CLAUDE.md.
    const mapOf = (store) => {
        const o = {};
        try {
            for (let i = 0; i < store.length; i++) {
                const k = store.key(i);
                if (k.startsWith('GM:')) continue;
                o[k] = store.getItem(k);
            }
        } catch (_) {}
        return o;
    };

    const snap = () => ({
        rootClass: document.documentElement.className,
        rootAttrs: attrsOf(document.documentElement),
        bodyClass: document.body ? document.body.className : null,
        bodyAttrs: attrsOf(document.body),
        bg: document.body ? getComputedStyle(document.body).backgroundColor : null,
        ls: mapOf(localStorage),
        ss: mapOf(sessionStorage)
    });

    push('served', document.documentElement.className || '(no class)');

    // Observed on documentElement with subtree:true rather than on <html> and <body>
    // separately, because <body> does not exist yet when this file runs and attaching to
    // it later would leave a hole exactly where the interesting writes are. Records for
    // anything other than the two elements we care about are dropped on arrival.
    try {
        new MutationObserver((recs) => {
            for (const r of recs) {
                const el = r.target;
                if (el !== document.documentElement && el !== document.body) continue;
                const who = el === document.body ? 'body' : 'html';
                push(who + '[' + r.attributeName + ']', {
                    from: r.oldValue === null ? '(absent)' : r.oldValue,
                    to: el.getAttribute(r.attributeName) === null ? '(absent)' : el.getAttribute(r.attributeName)
                });
            }
        }).observe(document.documentElement, { attributes: true, subtree: true, attributeOldValue: true });
    } catch (_) {}

    // The moment the rolling baseline is supposed to freeze, recorded independently of
    // the code that will do the freezing — so a capture can be checked against ground
    // truth rather than against its own claim.
    let firstInteraction = null;
    const seen = (e) => {
        if (firstInteraction !== null) return;
        firstInteraction = at();
        push('first interaction', e.type + (e.isTrusted ? '' : ' (synthetic)'));
    };
    for (const t of ['pointerdown', 'keydown', 'click']) {
        addEventListener(t, seen, { capture: true, passive: true });
    }

    window.__probe = {
        at, timeline, mark, snap,
        get firstInteraction() { return firstInteraction; },
        // Our side's own record, tail only. A fixture verdict that shows the page's
        // timeline next to our trace is how you tell "we re-asserted" from "the site
        // changed its mind".
        trace: (n) => {
            try { return JSON.parse(localStorage.getItem('GM:fmn_trace') || '[]').slice(-(n || 12)); }
            catch (_) { return []; }
        },
        // Every fixture's __verdict() ends here, so all four report the same core fields
        // in the same shape and a driver can diff them against each other.
        verdict: (extra) => Object.assign({
            firstInteraction,
            timeline,
            trace: window.__probe.trace()
        }, snap(), extra || {})
    };
})();
