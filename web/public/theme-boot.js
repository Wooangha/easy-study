// The 화면 테마 before the first paint (DESIGN §24). A classic, synchronous script that index.html loads first in
// <head>, so a page set to 라이트 or 다크 (web/src/lib/theme.ts) never shows the other theme while the app loads. It
// is a file, not inline, which keeps a future `script-src 'self'` CSP possible.
//
// The setting is the localStorage item "easy-study:theme", JSON-encoded like every item of web/src/lib/storage.ts
// (the text `"dark"`, quotes included); absent = 시스템 설정. Besides data-theme it sets the root's inline
// color-scheme: index.html declares `color-scheme: light dark`, so a forced 라이트 page on a dark system would get a
// dark canvas and dark native controls until the stylesheet is in.
//
// Inside the desktop app on macOS and Windows the shell has already given the window its theme, so the page's
// prefers-color-scheme is right from the start; this origin's copy of the setting may be stale (changed while another
// server was shown) and would only flash the wrong theme. On Linux the WebView may not follow the shell's theme: the
// copy is used there, and the shell's state push corrects it.
(function () {
  try {
    var desktop = window.__EASY_STUDY_DESKTOP__;
    if (desktop && desktop.os !== 'linux') return;
    var raw = window.localStorage.getItem('easy-study:theme');
    var pref = raw;
    try {
      pref = JSON.parse(raw);
    } catch (e) {
      // written by hand without quotes: the bare value
    }
    if (pref !== 'light' && pref !== 'dark') return;
    var root = document.documentElement;
    root.setAttribute('data-theme', pref);
    root.style.colorScheme = pref;
  } catch (e) {
    // localStorage unavailable (blocked, private mode): the system's theme
  }
})();
