// The px browser shell: a toolbar, an address bar and one Scramjet frame.
// Rendering happens in this browser; the relay only moves bytes.
(function () {
  "use strict";

  // Search engine used for non-URL input. DuckDuckGo tolerates datacenter
  // egress IPs better than Google does.
  var SEARCH = "https://duckduckgo.com/?q=%s";

  var $ = function (id) { return document.getElementById(id); };
  var toolbar = $("toolbar");
  var address = $("address");
  var landing = $("landing");
  var landingInput = $("landing-input");
  var landingError = $("landing-error");
  var frameHost = $("frame-host");
  var dot = $("status-dot");
  var who = $("who");

  var frame = null;
  var ready = null;

  function setStatus(state, title) {
    dot.className = "dot " + state;
    dot.title = title;
  }

  function showError(err) {
    landingError.textContent = err && err.message ? err.message : String(err);
    landingError.hidden = false;
  }

  /** Turn free text into a URL: full URLs pass through, bare hosts get https, everything else is a search. */
  function toUrl(input) {
    input = input.trim();
    if (!input) return null;
    try { return new URL(input).toString(); } catch (e) { /* not a URL */ }
    try {
      var url = new URL("https://" + input);
      if (url.hostname.indexOf(".") !== -1 || url.hostname === "localhost") return url.toString();
    } catch (e) { /* not a URL either */ }
    return SEARCH.replace("%s", encodeURIComponent(input));
  }

  async function init() {
    setStatus("busy", "Starting the proxy");
    try {
      var ctx = await window.pxSetup();
      frame = ctx.scramjet.createFrame();
      frame.frame.id = "frame";
      frame.frame.title = "Proxied page";
      frameHost.appendChild(frame.frame);
      frame.addEventListener("urlchange", function (e) {
        address.value = e.url;
      });
      setStatus("ok", "Proxy ready");
      document.body.dataset.ready = "1";
    } catch (err) {
      setStatus("err", "Proxy failed to start");
      showError(err);
      throw err;
    }

    try {
      var res = await fetch("/api/whoami");
      if (res.ok) who.textContent = (await res.json()).email || "";
    } catch (e) { /* cosmetic */ }
  }

  function go(input) {
    var url = toUrl(input);
    if (!url) return;
    ready.then(function () {
      landing.hidden = true;
      frameHost.hidden = false;
      address.value = url;
      frame.go(url);
    }, function () { /* init already reported the error */ });
  }

  function goHome() {
    frameHost.hidden = true;
    landing.hidden = false;
    address.value = "";
    landingInput.focus();
  }

  $("nav-form").addEventListener("submit", function (e) { e.preventDefault(); go(address.value); });
  $("landing-form").addEventListener("submit", function (e) { e.preventDefault(); go(landingInput.value); });
  $("back").addEventListener("click", function () { if (frame) frame.back(); });
  $("forward").addEventListener("click", function () { if (frame) frame.forward(); });
  $("reload").addEventListener("click", function () { if (frame && !frameHost.hidden) frame.reload(); });
  $("home").addEventListener("click", goHome);

  // Keyboard: Ctrl/Cmd+L focuses the address bar, like a real browser.
  document.addEventListener("keydown", function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "l") {
      e.preventDefault();
      (frameHost.hidden ? landingInput : address).focus();
      (frameHost.hidden ? landingInput : address).select();
    }
  });

  ready = init();
  window.px = { go: go, home: goHome, get frame() { return frame; } };
})();
