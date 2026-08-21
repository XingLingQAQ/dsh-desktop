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
//                      it with desktopSetRow/desktopDropRow so desktop plugins
//                      can enter and leave the module graph at runtime.
//
// The proxy also polls the desktop bridge's /plugins/state endpoint. The
// bridge serves plugin bundles and publishes the current desktop plugin
// manifest; polling is intentionally simple (no SSE dependency) and only runs
// while the DSH page is alive.
//
// Fiber work is deliberately NOT done here: this script runs before cordis
// exists, so graph rows are all it can reach. Post-boot changes are published
// on window.__DSH_DESKTOP__ and consumed by the @dsh-desktop/hmr client plugin,
// which owns the loader entry and fiber lifecycle. Changes raised before that
// plugin subscribes are buffered, so none are lost during boot.
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
      // Row-only operations. Invalidate/prefetch and the fiber swap belong to
      // the @dsh-desktop/hmr plugin; doing them here too would race it.
      if (typeof value.desktopSetRow !== "function") {
        value.desktopSetRow = function (entry) {
          if (!isObject(entry) || typeof entry.id !== "string") return;
          if (!this.graphRows) this.graphRows = new Map();
          this.graphRows.set(entry.id, {
            id: entry.id,
            url: entry.url,
            rev: entry.rev
          });
        };
      }
      if (typeof value.desktopDropRow !== "function") {
        value.desktopDropRow = function (id) {
          if (typeof id !== "string") return;
          if (this.graphRows) this.graphRows.delete(id);
        };
      }
    } catch (e) {
      // The module system may be frozen/minified differently; never break boot.
    }
  }

  // -------------------------------------------------------------- change feed
  var listeners = [];
  var buffered = [];

  function emit(change) {
    if (listeners.length === 0) {
      buffered.push(change);
      return;
    }
    listeners.forEach(function (fn) {
      try { fn(change); } catch (e) {}
    });
  }

  window.__DSH_DESKTOP__ = {
    // Replays anything raised before the first subscriber, then streams.
    // Returns an unsubscribe function (cordis effect disposer).
    subscribe: function (fn) {
      if (typeof fn !== "function") return function () {};
      listeners.push(fn);
      var replay = buffered;
      buffered = [];
      replay.forEach(function (change) {
        try { fn(change); } catch (e) {}
      });
      return function () {
        var at = listeners.indexOf(fn);
        if (at !== -1) listeners.splice(at, 1);
      };
    },
    entries: function () {
      var out = [];
      known.forEach(function (entry) { out.push(entry); });
      return out;
    }
  };

  // ------------------------------------------------------------- state polling
  function sessionAllowed(entry, session) {
    if (!Array.isArray(entry.sessions) || entry.sessions.length === 0) return true;
    if (session === null || session === undefined) return false;
    return entry.sessions.indexOf(session) !== -1;
  }

  function applyState(state) {
    if (!isObject(state) || !Array.isArray(state.entries)) return;
    var session = (typeof state.currentSession === "string" && state.currentSession) ? state.currentSession : null;
    currentSession = session;

    var next = new Map();
    state.entries.forEach(function (entry) {
      if (isObject(entry) && typeof entry.id === "string" && sessionAllowed(entry, session)) {
        next.set(entry.id, entry);
      }
    });

    // A session switch needs no special case: entries that gained or lost
    // access differ between `known` and `next`, so the plain diff covers it.
    var live = bootSeen && modules;

    // Removed entries (including session-scoped plugins no longer allowed).
    known.forEach(function (entry, id) {
      if (next.has(id)) return;
      known.delete(id);
      if (!live) return;
      try { modules.desktopDropRow(id); } catch (e) {}
      emit({ type: "removed", id: id });
    });

    // New entries, and rebuilds (rev is a content hash of the bundle).
    next.forEach(function (entry, id) {
      var old = known.get(id);
      if (old !== undefined && old.rev === entry.rev) return;
      known.set(id, entry);
      if (!live) return;
      // The row must land before the hmr plugin prefetches this id.
      try { modules.desktopSetRow(entry); } catch (e) {}
      emit({ type: old === undefined ? "added" : "rebuilt", id: id, entry: entry });
    });

    // Before boot, a later __DSH_BOOT__ assignment merges `known` through
    // mergeBoot(), so the very first graph already carries these entries.
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
