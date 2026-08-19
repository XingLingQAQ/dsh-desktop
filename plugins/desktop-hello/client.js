// Desktop sample client plugin.
//
// This is a deliberately minimal DSH client plugin: it registers a factory
// through the desktop-injected `window.__ModuleLoader__` proxy and exports a
// Cordis-style `apply(ctx)` so the client runner mounts it.
//
// To see the hot-reload path in action:
//   1. keep the desktop app running,
//   2. edit this file (e.g. change the console.log text),
//   3. the bridge re-hashes the bundle and the proxy calls
//      `modules.desktopAddEntry` → `invalidate` + `prefetch`,
//   4. the client runner reloads the plugin without a page refresh.
window.__ModuleLoader__.load({
  id: "desktop-hello",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    function apply(ctx) {
      console.log("[desktop-hello] plugin mounted");
      // A real plugin would register UI slots / services / commands here.
    }

    exports.apply = apply;
    return module.exports;
  }
});
