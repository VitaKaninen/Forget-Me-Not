// Minimal GM_* shim so Forget-Me-Not.user.js can be loaded by a plain page for testing.
// GM storage is persistent and shared across frames, so localStorage is the right stand-in
// (sessionStorage would lose rules on reload, which is exactly what the tests check).
// Menu commands have nowhere to go in a plain page, so they are parked on window for the
// test driver to invoke by name.
(function () {
    window.__gsMenu = {};
    window.GM_setValue = (k, v) => localStorage.setItem('GM:' + k, String(v));
    window.GM_getValue = (k, d) => {
        const v = localStorage.getItem('GM:' + k);
        if (v === null) return d;
        if (v === 'true') return true;
        if (v === 'false') return false;
        return v;
    };
    window.GM_deleteValue = (k) => localStorage.removeItem('GM:' + k);
    window.GM_registerMenuCommand = (name, fn) => { window.__gsMenu[name] = fn; };
})();
