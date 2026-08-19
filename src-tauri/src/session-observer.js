// Desktop session observer — injected into the DSH page as a tiny built-in
// client plugin. It subscribes to `ctx.sessions.currentProvideInfo` and reports
// the current session id to the desktop bridge so session-scoped desktop
// plugins can be added/removed dynamically.
window.__ModuleLoader__.load({
  id: "@dsh-desktop/session-observer",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    var bridge = "__BRIDGE__";

    function sessionIdOf(info) {
      if (!info || typeof info !== "object") return null;
      if (typeof info.sessionId === "string") return info.sessionId;
      if (typeof info.id === "string") return info.id;
      return null;
    }

    function report(info) {
      var id = sessionIdOf(info);
      try {
        fetch(bridge + "/report/session", {
          method: "POST",
          body: JSON.stringify({ sessionId: id }),
          keepalive: true
        }).catch(function () {});
      } catch (e) {}
    }

    function apply(ctx) {
      try {
        if (ctx.sessions && ctx.sessions.currentProvideInfo) {
          report(ctx.sessions.currentProvideInfo.getSnapshot());
          ctx.sessions.currentProvideInfo.subscribe(report);
        }
      } catch (e) {
        // The sessions service may not be ready on every surface; the poller
        // will re-read the manifest and this plugin is allowed to stay quiet.
      }
    }

    exports.apply = apply;
    exports.inject = ["sessions"];
    return module.exports;
  }
});
