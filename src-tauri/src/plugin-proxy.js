// Desktop plugin proxy — injected into the DSH content webview at document
// creation, BEFORE the DSH boot script assigns window.__DSH_BOOT__.
//
// It owns three interception points:
//   1. __DSH_BOOT__  — merges desktop-managed plugin entries into the host
//                      boot graph, so plugins placed in the desktop plugins
//                      directory are visible from the very first boot.
//   2. __ModuleLoader__ — wraps the client bundle registration sink, letting
//                      the desktop shell track every client plugin factory.
//   3. __DSH_MODULES__ — captures the ClientModuleSystem instance and patches
//                      it with desktopAddEntry/desktopRemoveEntry, enabling
//                      runtime plugin graph changes without a page reload.
//
// The proxy also polls the desktop bridge's /plugins/state endpoint. The
// bridge serves plugin bundles and publishes the current desktop plugin
// manifest; polling is intentionally simple (no SSE dependency) and only runs
// while the DSH page is alive.
(function () {
  var bridge = "__BRIDGE__";
  var initialEntries = __INITIAL_ENTRIES__;
  var initialSession = __INITIAL_SESSION__;
  var currentSession = typeof initialSession === "string" ? initialSession : null;

  var known = new Map(); // id -> WebBootEntry (desktop-managed only)
  var bootSeen = false;
  var modules = undefined;
  var factories = new Map();

  function isObject(v) {
    return v !== null && typeof v === "object";
  }

  // ---------------------------------------------------------------- __DSH_BOOT__
  var bootSlot = undefined;
  Object.defineProperty(window, "__DSH_BOOT__", {
    configurable: true,
    enumerable: true,
    get: function () {
      return bootSlot;
    },
    set: function (value) {
      bootSlot = mergeBoot(value);
      bootSeen = true;
    }
  });

  function mergeBoot(value) {
    if (!isObject(value) || !Array.isArray(value.entries)) return value;
    var entries = value.entries.slice();
    known.forEach(function (entry) {
      if (!entries.some(function (e) { return isObject(e) && e.id === entry.id; })) {
        entries.push(entry);
      }
    });
    return {
      rev: value.rev,
      entries: entries
    };
  }

  // ------------------------------------------------------------ __ModuleLoader__
  var loaderSlot = undefined;
  Object.defineProperty(window, "__ModuleLoader__", {
    configurable: true,
    enumerable: true,
    get: function () {
      return loaderSlot;
    },
    set: function (value) {
      loaderSlot = wrapLoader(value);
    }
  });

  function wrapLoader(real) {
    if (!isObject(real) || real.__dshDesktopWrapped) return real;
    var proxy = {
      __dshDesktopWrapped: true,
      load: function (handoff) {
        if (isObject(handoff) && typeof handoff.id === "string") {
          factories.set(handoff.id, handoff.factory);
        }
        return real.load.call(real, handoff);
      }
    };
    return proxy;
  }

  // ------------------------------------------------------------ __DSH_MODULES__
  Object.defineProperty(window, "__DSH_MODULES__", {
    configurable: true,
    enumerable: true,
    get: function () {
      return modules;
    },
    set: function (value) {
      modules = value;
      patchModules(value);
    }
  });

  function patchModules(value) {
    if (!isObject(value)) return;
    try {
      if (typeof value.desktopAddEntry !== "function") {
        value.desktopAddEntry = function (entry) {
          if (!isObject(entry) || typeof entry.id !== "string") return;
          if (!this.graphRows) this.graphRows = new Map();
          this.graphRows.set(entry.id, {
            id: entry.id,
            url: entry.url,
            rev: entry.rev
          });
          // Drop stale materialization; the next prefetch/import reloads.
          this.invalidate(entry.id);
          if (typeof this.prefetch === "function") {
            this.prefetch(entry.id).catch(function () {});
          }
        };
      }
      if (typeof value.desktopRemoveEntry !== "function") {
        value.desktopRemoveEntry = function (id) {
          if (typeof id !== "string") return;
          this.invalidate(id);
          if (this.graphRows) this.graphRows.delete(id);
        };
      }
    } catch (e) {
      // The module system may be frozen/minified differently; never break boot.
    }
  }

  // ------------------------------------------------------------- state polling
  function sessionAllowed(entry, session) {
    if (!Array.isArray(entry.sessions) || entry.sessions.length === 0) return true;
    if (session === null || session === undefined) return false;
    return entry.sessions.indexOf(session) !== -1;
  }

  function applyState(state) {
    if (!isObject(state) || !Array.isArray(state.entries)) return;
    var session = (typeof state.currentSession === "string" && state.currentSession) ? state.currentSession : null;
    var sessionChanged = session !== currentSession;
    currentSession = session;

    var next = new Map();
    state.entries.forEach(function (entry) {
      if (isObject(entry) && typeof entry.id === "string" && sessionAllowed(entry, session)) {
        next.set(entry.id, entry);
      }
    });

    // Removed entries (including session-scoped plugins no longer allowed).
    known.forEach(function (entry, id) {
      if (!next.has(id)) {
        known.delete(id);
        if (bootSeen && modules) {
          try { modules.desktopRemoveEntry(id); } catch (e) {}
        }
      }
    });

    // Added or changed entries. On session change, re-add all allowed entries
    // so the module system picks up the new graph.
    next.forEach(function (entry, id) {
      var old = known.get(id);
      if (old === undefined || sessionChanged || old.rev !== entry.rev) {
        known.set(id, entry);
        if (bootSeen && modules) {
          try { modules.desktopAddEntry(entry); } catch (e) {}
        }
      }
    });

    // If boot has not happened yet, a later __DSH_BOOT__ assignment will merge
    // the current `known` map through mergeBoot() automatically.
  }

  function poll() {
    fetch(bridge + "/plugins/state", { cache: "no-store" })
      .then(function (res) {
        if (!res.ok) throw new Error("plugins/state " + res.status);
        return res.json();
      })
      .then(applyState)
      .catch(function () {})
      .then(function () {
        setTimeout(poll, 1000);
      });
  }

  // Seed the known map with the manifest captured at shell startup. Session-
  // scoped plugins wait until the observer reports a matching session.
  if (Array.isArray(initialEntries)) {
    initialEntries.forEach(function (entry) {
      if (isObject(entry) && typeof entry.id === "string" && sessionAllowed(entry, currentSession)) {
        known.set(entry.id, entry);
      }
    });
  }

  setTimeout(poll, 300);
})();
