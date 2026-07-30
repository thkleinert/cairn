// Viewport height custom properties. Lives in its own file (not inline in
// index.html) so the Content-Security-Policy can stay `script-src 'self'`
// with no inline-script carve-outs.
//
// Measured on a real device: in an iOS standalone PWA, window.innerHeight
// silently excludes the top safe-area inset (status bar) — 844 (real
// screen) - 797 (innerHeight) = 47, exactly this device's inset-top —
// even though fixed-position content still correctly extends up there.
// That 47px gap is the bug. screen.height is the true physical height
// and isn't short by that amount, so use it in standalone mode; a
// regular browser tab still uses innerHeight, correctly respecting
// Safari's own chrome. Runs before the splash paints so there's no
// flash of the wrong size.
(function () {
  // navigator.standalone is iOS-only — deliberately. On installed Android
  // PWAs screen.height *includes* the system bars, so using it there pushes
  // the bottom nav off-screen; Android's innerHeight is already correct.
  function isIosStandalone() {
    return window.navigator.standalone === true;
  }
  function setAppHeight() {
    var height;
    if (isIosStandalone()) {
      // iOS never swaps screen.width/height on rotation (and ignores the
      // manifest's orientation lock), so pick the dimension that matches
      // the current orientation instead of trusting screen.height.
      var landscape = window.matchMedia('(orientation: landscape)').matches;
      height = landscape
        ? Math.min(window.screen.width, window.screen.height)
        : Math.max(window.screen.width, window.screen.height);
    } else {
      height = window.innerHeight;
    }
    document.documentElement.style.setProperty('--app-height', height + 'px');
  }
  setAppHeight();
  window.addEventListener('resize', setAppHeight);
  window.addEventListener('orientationchange', function () { setTimeout(setAppHeight, 100); });

  // --app-height (above) is driven by innerHeight/screen.height, and on
  // iOS NEITHER of those shrinks when the on-screen keyboard opens — only
  // window.visualViewport.height reflects the keyboard. So anything sized
  // against --app-height while the keyboard is up thinks it has the whole
  // screen to work with. --visual-height tracks the genuinely-visible area
  // instead (screen minus keyboard), for keyboard-aware UI like the
  // place-search suggestions, which must never grow up behind the status
  // bar when the keyboard has eaten the bottom half of the screen.
  // window's own resize event doesn't fire on iOS keyboard toggles;
  // visualViewport's does, so it's the source of truth here.
  function setVisualHeight() {
    var vv = window.visualViewport;
    var height = vv ? vv.height : window.innerHeight;
    // offsetTop: how far the visible viewport's top sits below the layout
    // viewport's top. iOS shifts this down when it scrolls to keep a
    // focused input above the keyboard, so a position:fixed overlay must
    // offset by it to stay aligned with what's actually on screen.
    var offsetTop = vv ? vv.offsetTop : 0;
    document.documentElement.style.setProperty('--visual-height', height + 'px');
    document.documentElement.style.setProperty('--visual-offset-top', offsetTop + 'px');
  }
  setVisualHeight();
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', setVisualHeight);
    window.visualViewport.addEventListener('scroll', setVisualHeight);
  }
  window.addEventListener('resize', setVisualHeight);
  window.addEventListener('orientationchange', function () { setTimeout(setVisualHeight, 100); });
})();
