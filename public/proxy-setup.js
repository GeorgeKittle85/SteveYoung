// Shared bootstrap for index.html and bootstrap.html: configures Scramjet,
// registers the service worker and points the transport at this origin's
// Wisp relay. Exposes a single promise-returning function on window.
(function () {
  "use strict";

  // Must match PROXY_PREFIX in src/index.ts.
  var PREFIX = "/scramjet/";
  var TRANSPORT = "/epoxy/index.mjs";
  var WISP_URL = (location.protocol === "https:" ? "wss" : "ws") + "://" + location.host + "/wisp/";

  var setupPromise = null;

  function pxSetup() {
    if (setupPromise) return setupPromise;
    setupPromise = (async function () {
      if (!("serviceWorker" in navigator)) {
        throw new Error("This browser does not support service workers, which px needs.");
      }
      var ScramjetController = $scramjetLoadController().ScramjetController;
      var scramjet = new ScramjetController({
        prefix: PREFIX,
        files: {
          wasm: "/scram/scramjet.wasm.wasm",
          all: "/scram/scramjet.all.js",
          sync: "/scram/scramjet.sync.js",
        },
      });
      await scramjet.init();
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      var connection = new BareMux.BareMuxConnection("/baremux/worker.js");
      if ((await connection.getTransport()) !== TRANSPORT) {
        await connection.setTransport(TRANSPORT, [{ wisp: WISP_URL }]);
      }
      return { scramjet: scramjet, connection: connection, prefix: PREFIX, wispUrl: WISP_URL };
    })();
    return setupPromise;
  }

  window.pxSetup = pxSetup;
})();
