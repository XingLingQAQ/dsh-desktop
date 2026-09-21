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

  // ------------------------------------------------------- ownership bookkeeping
  // A plugin is not trusted to clean up after itself. Every node a plugin puts
  // into the document while its `apply` runs is recorded under its id and
  // tagged, so unmounting can reclaim whatever the plugin's own disposer missed
  // (or never ran at all). Without this, a plugin that appends to `document.body`
  // and relies on an `apply`-returned disposer leaves its UI on screen after the
  // shell has already disposed its fiber — the plugin looks "paused" everywhere
  // except the part the user can see.
  //
  // Only the synchronous `apply` window is attributed here. Timers, listeners
  // and sockets a plugin opens later are a separate ledger (not yet built), so
  // a paused plugin can still tick in the background — it just cannot show.
  var OWNER_ATTR = "data-dsh-owner";
  var ledgers = new Map(); // plugin id -> { nodes: [] }
  var instrumented = new Set(); // plugin ids whose apply the shell wrapped
  var owner = null; // plugin id whose apply is currently on the stack
  var patchedDom = false;

  function ledgerFor(id) {
    var ledger = ledgers.get(id);
    if (ledger === undefined) {
      ledger = { nodes: [], timers: [], intervals: [], frames: [], listeners: [], closables: [], observers: [] };
      ledgers.set(id, ledger);
    }
    return ledger;
  }

  // ------------------------------------------------------- async attribution
  // The synchronous `apply` window catches everything a plugin builds up front,
  // but the interesting leaks come later: a plugin that awaits its config and
  // only then opens an interval and an event stream. Native `await` resumes
  // outside any wrapper we can install, so the owner cannot simply be carried
  // along — the fallback is to ask the call stack whose bundle is calling.
  //
  // Every desktop plugin bundle is served from `/plugins/<id>/client.js`, so a
  // stack frame naming that path identifies the owner. The answer is cached per
  // callback object, which is why a repeatedly-scheduled `tick` costs one stack
  // walk in total rather than one per call.
  var ownedFns = new WeakMap();

  function attributeFromStack() {
    if (instrumented.size === 0) return null;
    var stack;
    try {
      stack = new Error().stack;
    } catch (e) {
      return null;
    }
    if (typeof stack !== "string") return null;
    var found = null;
    instrumented.forEach(function (id) {
      if (found === null && stack.indexOf("/plugins/" + id + "/") !== -1) found = id;
    });
    return found;
  }

  // Owner of the code calling right now: the apply window if one is open,
  // otherwise whoever the stack points at. `fn` is only used as a cache key.
  function callerOwner(fn) {
    if (owner !== null) return owner;
    if (typeof fn === "function") {
      var cached = ownedFns.get(fn);
      if (cached !== undefined) return cached;
      var resolved = attributeFromStack();
      ownedFns.set(fn, resolved);
      return resolved;
    }
    return attributeFromStack();
  }

  // Run a plugin's callback with its owner restored, so anything it schedules in
  // turn is attributed without another stack walk.
  function inOwner(id, fn) {
    if (typeof fn !== "function") return fn;
    return function () {
      var previous = owner;
      owner = id;
      try {
        return fn.apply(this, arguments);
      } finally {
        owner = previous;
      }
    };
  }

  function claim(node) {
    if (owner === null || !isObject(node)) return;
    // Tag elements so a reclaim can also find them after a re-mount replaced
    // this ledger (a leftover from the previous generation is still ours).
    try {
      if (node.nodeType === 1 && node.getAttribute(OWNER_ATTR) === null) {
        node.setAttribute(OWNER_ATTR, owner);
      }
    } catch (e) {}
    ledgerFor(owner).nodes.push(node);
  }

  // Patch the insertion points once, globally. They are pass-through unless a
  // plugin's apply is on the stack, so DSH's own DOM work is never recorded.
  function patchDom() {
    if (patchedDom) return;
    patchedDom = true;
    var protos = [
      [Node.prototype, ["appendChild", "insertBefore", "replaceChild"]],
      [Element.prototype, ["append", "prepend", "insertAdjacentElement", "after", "before"]]
    ];
    protos.forEach(function (pair) {
      var proto = pair[0];
      pair[1].forEach(function (method) {
        var original = proto[method];
        if (typeof original !== "function") return;
        proto[method] = function () {
          var result = original.apply(this, arguments);
          if (owner !== null) {
            for (var i = 0; i < arguments.length; i++) {
              var arg = arguments[i];
              if (isObject(arg) && typeof arg.nodeType === "number") claim(arg);
            }
          }
          return result;
        };
      });
    });
  }

  var patchedAsync = false;

  // Timers, listeners, streams and observers a plugin opens go on its ledger so
  // a paused plugin actually stops working, not just stops showing. Pass-through
  // whenever the caller is not an instrumented plugin.
  function patchAsync() {
    if (patchedAsync) return;
    patchedAsync = true;

    var rawSetTimeout = window.setTimeout;
    var rawSetInterval = window.setInterval;
    var rawRaf = window.requestAnimationFrame;

    window.setTimeout = function (fn) {
      var id = callerOwner(fn);
      if (id === null) return rawSetTimeout.apply(window, arguments);
      var args = [].slice.call(arguments);
      args[0] = inOwner(id, fn);
      var handle = rawSetTimeout.apply(window, args);
      ledgerFor(id).timers.push(handle);
      return handle;
    };

    window.setInterval = function (fn) {
      var id = callerOwner(fn);
      if (id === null) return rawSetInterval.apply(window, arguments);
      var args = [].slice.call(arguments);
      args[0] = inOwner(id, fn);
      var handle = rawSetInterval.apply(window, args);
      ledgerFor(id).intervals.push(handle);
      return handle;
    };

    if (typeof rawRaf === "function") {
      window.requestAnimationFrame = function (fn) {
        var id = callerOwner(fn);
        if (id === null) return rawRaf.call(window, fn);
        var handle = rawRaf.call(window, inOwner(id, fn));
        ledgerFor(id).frames.push(handle);
        return handle;
      };
    }

    // Listeners on the shared targets only: a plugin's own elements go away with
    // the nodes, and instrumenting every element would tax the whole page.
    [window, document, document.documentElement].forEach(function (target) {
      if (!target || typeof target.addEventListener !== "function") return;
      var rawAdd = target.addEventListener;
      target.addEventListener = function (type, handler, options) {
        var id = callerOwner(handler);
        if (id === null) return rawAdd.apply(this, arguments);
        var bound = inOwner(id, handler);
        ledgerFor(id).listeners.push({ target: this, type: type, handler: bound, options: options });
        return rawAdd.call(this, type, bound, options);
      };
    });

    patchClosable("EventSource");
    patchClosable("WebSocket");
    patchObserver("MutationObserver");
    patchObserver("ResizeObserver");
    patchObserver("IntersectionObserver");
  }

  // Long-lived connections: recorded so a pause closes them instead of leaving a
  // paused plugin streaming from its backend.
  function patchClosable(name) {
    var Original = window[name];
    if (typeof Original !== "function") return;
    function Wrapped(url, config) {
      var instance = arguments.length > 1 ? new Original(url, config) : new Original(url);
      var id = callerOwner(null);
      if (id !== null) ledgerFor(id).closables.push(instance);
      return instance;
    }
    Wrapped.prototype = Original.prototype;
    ["CONNECTING", "OPEN", "CLOSED", "CLOSING"].forEach(function (key) {
      if (key in Original) Wrapped[key] = Original[key];
    });
    window[name] = Wrapped;
  }

  function patchObserver(name) {
    var Original = window[name];
    if (typeof Original !== "function") return;
    var rawObserve = Original.prototype.observe;
    if (typeof rawObserve !== "function") return;
    Original.prototype.observe = function () {
      var id = callerOwner(null);
      if (id !== null) ledgerFor(id).observers.push(this);
      return rawObserve.apply(this, arguments);
    };
  }

  function reclaim(id, label) {
    var removed = 0;
    var stopped = 0;
    var ledger = ledgers.get(id);
    if (ledger !== undefined) {
      ledger.nodes.forEach(function (node) {
        try {
          if (typeof node.remove === "function") {
            node.remove();
            removed += 1;
          }
        } catch (e) {}
      });
      ledger.timers.forEach(function (handle) {
        try { clearTimeout(handle); stopped += 1; } catch (e) {}
      });
      ledger.intervals.forEach(function (handle) {
        try { clearInterval(handle); stopped += 1; } catch (e) {}
      });
      ledger.frames.forEach(function (handle) {
        try { cancelAnimationFrame(handle); stopped += 1; } catch (e) {}
      });
      ledger.listeners.forEach(function (row) {
        try { row.target.removeEventListener(row.type, row.handler, row.options); stopped += 1; } catch (e) {}
      });
      ledger.closables.forEach(function (conn) {
        try {
          if (typeof conn.close === "function") { conn.close(); stopped += 1; }
        } catch (e) {}
      });
      ledger.observers.forEach(function (observer) {
        try {
          if (typeof observer.disconnect === "function") { observer.disconnect(); stopped += 1; }
        } catch (e) {}
      });
      ledgers.delete(id);
    }
    // Anything still tagged with this id — a leftover from a generation whose
    // ledger is gone, e.g. one recorded before a reload.
    try {
      var stragglers = document.querySelectorAll("[" + OWNER_ATTR + "=\"" + String(id).replace(/"/g, "\\\"") + "\"]");
      for (var i = 0; i < stragglers.length; i++) {
        stragglers[i].remove();
        removed += 1;
      }
    } catch (e) {}
    if (removed > 0 || stopped > 0) {
      // Loud on purpose: a plugin whose own cleanup worked leaves nothing to
      // reclaim, so any count here names a plugin that needs fixing.
      console.warn(
        "[dsh-desktop] reclaimed " + String(removed) + " node(s) and stopped " + String(stopped) +
        " effect(s) from \"" + String(id) + "\" on " + (label || "unmount") +
        " - the plugin's own cleanup did not release them"
      );
    }
    return removed + stopped;
  }

  // Wrap a plugin's `apply` so the shell owns its teardown. The original return
  // value is passed through UNTOUCHED: cordis accepts a disposer function, a
  // promise, or an (async) iterator of disposers, and rewriting that shape would
  // silently drop the disposers of generator-style plugins. The reclaim is
  // registered as a separate effect BEFORE the plugin body runs, so it disposes
  // LAST — after the plugin's own cleanup has had its turn.
  function instrumentApply(id, realApply) {
    return function (ctx) {
      var previous = owner;
      var registered = false;
      if (isObject(ctx) && typeof ctx.effect === "function") {
        try {
          ctx.effect(function () {
            return function () { reclaim(id, "unmount"); };
          }, "dsh-desktop: reclaim " + id);
          registered = true;
        } catch (e) {}
      }
      owner = id;
      try {
        var returned = realApply.apply(this, arguments);
      } finally {
        owner = previous;
      }
      // No effect hook available (a plugin called with a bare context): fall
      // back to wrapping a plain-function disposer, the only shape that can be
      // wrapped without changing what cordis collects.
      if (!registered && (returned === undefined || typeof returned === "function")) {
        var ownDisposer = returned;
        return function () {
          if (typeof ownDisposer === "function") {
            try {
              ownDisposer();
            } catch (error) {
              console.error("[dsh-desktop] cleanup of \"" + String(id) + "\" threw", error);
            }
          }
          reclaim(id, "unmount");
        };
      }
      return returned;
    };
  }

  // Copy every own property descriptor (getters included — bundlers define
  // exports as accessors) onto a fresh object, with one key overridden.
  function cloneWith(source, key, value) {
    var out = Object.create(Object.getPrototypeOf(source) || Object.prototype);
    var keys = Object.getOwnPropertyNames(source).concat(Object.getOwnPropertySymbols(source));
    keys.forEach(function (name) {
      if (name === key) return;
      try {
        Object.defineProperty(out, name, Object.getOwnPropertyDescriptor(source, name));
      } catch (e) {}
    });
    Object.defineProperty(out, key, {
      value: value, enumerable: true, configurable: true, writable: true
    });
    return out;
  }

  // A plugin may be a bare function (`module.exports = function (ctx) {}`) rather
  // than an `{ apply }` object. Classes are deliberately left alone: cordis
  // instantiates those with `new`, which a plain wrapper cannot stand in for.
  function instrumentFunctionPlugin(id, fn) {
    var wrapped = instrumentApply(id, fn);
    Object.getOwnPropertyNames(fn).forEach(function (key) {
      if (key === "length" || key === "name" || key === "prototype") return;
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(fn, key));
      } catch (e) {}
    });
    return wrapped;
  }

  // Install the wrapper on whichever object carries `apply`. In-place patching
  // is preferred so the exports object keeps its identity (cordis keys a
  // plugin's runtime on the `apply` function it resolves, and reads
  // `name`/`inject`/`Config` off the same object). Bundled plugins often expose
  // `apply` as a getter with no setter, where the assignment cannot stick — those
  // get a descriptor-preserving copy instead.
  function instrumentExports(id, exports) {
    var nested = false;
    var target = exports;
    if (isObject(target) && typeof target.apply !== "function"
      && isObject(target.default) && typeof target.default.apply === "function") {
      target = target.default;
      nested = true;
    }
    if (typeof target !== "function" && isObject(exports) && typeof exports.default === "function") {
      target = exports.default;
      nested = true;
    }
    if (typeof target === "function" && !/^class[\s{]/.test(String(target))) {
      if (target.__dshInstrumented === true) return exports;
      var wrappedFn = instrumentFunctionPlugin(id, target);
      wrappedFn.__dshInstrumented = true;
      instrumented.add(id);
      return nested ? cloneWith(exports, "default", wrappedFn) : wrappedFn;
    }
    if (!isObject(target) || typeof target.apply !== "function") return exports;
    if (target.__dshInstrumented === true) return exports;
    var wrapped = instrumentApply(id, target.apply);
    try {
      target.apply = wrapped;
      target.__dshInstrumented = true;
    } catch (e) {}
    if (target.apply === wrapped) {
      instrumented.add(id);
      return exports;
    }
    var copy = cloneWith(target, "apply", wrapped);
    copy.__dshInstrumented = true;
    instrumented.add(id);
    return nested ? cloneWith(exports, "default", copy) : copy;
  }

  function instrumentFactory(id, factory) {
    if (typeof factory !== "function") return factory;
    return function (require) {
      return instrumentExports(id, factory.apply(this, arguments));
    };
  }

  patchDom();
  patchAsync();

  // The host groups many bundles into one fetch: `/plugins/??a/client.js,b/…`
  // lists every member in the query string, and with enough plugins installed
  // that URL grows to a couple of kilobytes. Chromium refuses any request whose
  // headers total more than ~2 KB, and its own baseline headers already use
  // nearly all of that — so the grouped URL comes back 431 Request Header
  // Fields Too Large and every bundle in the group fails to load. Since the
  // whole application tier shares one group, one oversized URL takes the entire
  // plugin system down: the boot page shows "Failed to load plugins" and
  // nothing mounts.
  //
  // The server has no such limit (a direct request of the same URL succeeds),
  // so the fix is to stop asking for a small library in one URL. A batch is
  // split into one batch per member, each naming only its own bundle — a
  // hundred-odd bytes — which is what `mergeBoot` does below for the desktop's
  // own entries anyway.
  var MAX_BATCH_URL = 1500;

  function splitBatch(batch, byId) {
    if (!isObject(batch) || typeof batch.url !== "string") return null;
    if (batch.url.length <= MAX_BATCH_URL) return null;
    if (!Array.isArray(batch.entries) || batch.entries.length < 2) return null;
    var out = [];
    for (var i = 0; i < batch.entries.length; i++) {
      var id = batch.entries[i];
      var row = byId.get(id);
      // A member without a row of its own cannot be split out safely: there is
      // no url to name, and dropping it would silently unmount a plugin.
      if (row === undefined || typeof row.url !== "string") return null;
      out.push({
        phase: batch.phase,
        url: sameOriginUrl(row.url),
        rev: row.rev,
        entries: [id]
      });
    }
    return out;
  }

  // ------------------------------------------------------------ bundle urls
  // 桌面插件的包由壳自己的 loopback 桥服务，监听的是另一个端口。DSH 页面用
  // 普通 `<script src>` 加载包，所以那个绝对地址是跨源的，Chromium 会拒绝，
  // 于是整行报 `bundle script undefined failed to load`，客户端半永远起不来。
  // 纯桌面插件能活着，是因为它的行会被宿主自己的相对地址重写；而一个同时被
  // 宿主从 profile 挂载的插件保留绝对形式，恰好就是起不来的那个。
  //
  // 所以桌面地址一律改成相对页面自身来源的形式，由宿主半的
  // `dsh-desktop-bundles` 路由把同样的字节再发一遍。相对地址原样留着：那已经
  // 是宿主自己的 `/plugins/??…` 形式，同源且可用。
  var BUNDLE_ROUTE = "/dsh-desktop-bundles";

  function sameOriginUrl(url) {
    if (typeof url !== "string" || url === "") return url;
    // 已经是相对地址（宿主自己的 `/plugins/??…` 形式）——不用动。
    if (url.charAt(0) === "/") return url;
    var m = /^https?:\/\/[^/]+(\/plugins\/.*)$/.exec(url);
    if (m === null) return url;
    // `…/plugins/<id>/client.js?rev=…` → `/dsh-desktop-bundles/plugins/<id>/…`。
    // query 一并带上，因为桥的缓存与 rev 都以它为准。
    return BUNDLE_ROUTE + m[1];
  }

  // 一条 batch 的 url 会把该批每个包的名字列进 query string。插件多到一定程度
  // 这条 URL 就超过浏览器的请求头总量上限（约 2KB，见 `mergeBoot` 里的说明），
  // 整批包一起加载失败。超过 `MAX_BATCH_URL` 的分组就拆成每个包一条。
  var MAX_BATCH_URL = 1500;

  /**
   * 把一条过大的 batch 拆成每个 entry 一条。
   * @param {{ url?: string, phase?: string, entries?: string[] }} batch - 原来的分组。
   * @param {Map<string, { url?: string, rev?: string }>} byId - entry id 到自身行的索引。
   * @returns {Array<{phase: unknown, url: string, rev: unknown, entries: string[]}> | null}
   *   拆好的 batch 列表；任何成员缺少自己的行就返回 null，表示不拆。
   */
  function splitBatch(batch, byId) {
    if (!isObject(batch) || typeof batch.url !== "string") return null;
    if (batch.url.length <= MAX_BATCH_URL) return null;
    if (!Array.isArray(batch.entries) || batch.entries.length < 2) return null;
    var out = [];
    for (var i = 0; i < batch.entries.length; i++) {
      var id = batch.entries[i];
      var row = byId.get(id);
      // 成员没有自己的行就不能安全拆出来：没有地址可写，而丢掉它就等于悄悄
      // 卸载一个插件。宁可整条不拆，让问题保持在原处。
      if (row === undefined || typeof row.url !== "string") return null;
      out.push({
        phase: batch.phase,
        url: sameOriginUrl(row.url),
        rev: row.rev,
        entries: [id]
      });
    }
    return out;
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
    // 一个既被 DSH Loader 挂载、又归桌面管的插件，它这行是宿主给的，地址也是
    // 绝对的——所以要就地重写，而不只是走下面 `added` 那条路。少了这一步，最
    // 需要同源路由的那个插件恰好拿不到它。
    var entries = value.entries.map(function (entry) {
      if (!isObject(entry) || typeof entry.url !== "string") return entry;
      var rewritten = sameOriginUrl(entry.url);
      if (rewritten === entry.url) return entry;
      var copy = {};
      for (var key in entry) {
        if (Object.prototype.hasOwnProperty.call(entry, key)) copy[key] = entry[key];
      }
      copy.url = rewritten;
      return copy;
    });
    var added = [];
    known.forEach(function (entry) {
      if (!entries.some(function (e) { return isObject(e) && e.id === entry.id; })) {
        entries.push(entry);
        added.push(entry);
      }
    });
    // 保留宿主写进来的其他字段，只换 entries / 追加 batches。
    // 之前这里是重新拼一个 {rev, entries}，把别的都丢了——新版 DSH 的
    // client-modules 会校验 `batches` 必须是数组，字段一没就抛
    // "boot manifest batches must be an array"，整个插件加载失败。
    var merged = {};
    for (var key in value) {
      if (Object.prototype.hasOwnProperty.call(value, key)) merged[key] = value[key];
    }
    // 而且每个 entry 都必须属于某个 batch，否则会换一个错继续炸
    // （"belongs to no initial-load batch"）。宿主给它的 entry 分好了组合包，
    // 我们的插件是另外服务的，所以每个自己配一个单条的 batch：
    // url 就是该 entry 自己的 url，rev 也是。
    if (Array.isArray(merged.batches)) {
      // 一条 batch 的 url 就是它那批 entry 的取包地址，所以宿主指向桥的
      // batch 必须跟着它描述的 entry 一起改。
      //
      // 更重要的是：宿主会把几十个包塞进一条 URL（`/plugins/??a,b,c…`），
      // 插件装多了这条 URL 就长到两千多字节。Chromium 对请求头总量有约 2KB
      // 的硬上限，而它自己的基础头部已经吃掉绝大部分，于是这条 URL 直接被
      // 431 (Request Header Fields Too Large) 打回，整批包一个都加载不出来。
      // 宿主服务器本身没有这个限制（同样的 URL 直接请求是通的），所以症结
      // 是"一条 URL 问一小座库"。这里把过大的一条拆成每个包一条，各自只报
      // 自己的地址——百来字节，跟下面给桌面插件配单条 batch 是同一个道理。
      var byId = new Map();
      entries.forEach(function (entry) {
        if (isObject(entry) && typeof entry.id === "string") byId.set(entry.id, entry);
      });
      var batches = [];
      merged.batches.forEach(function (batch) {
        if (!isObject(batch) || typeof batch.url !== "string") {
          batches.push(batch);
          return;
        }
        var split = splitBatch(batch, byId);
        if (split !== null) {
          for (var i = 0; i < split.length; i++) batches.push(split[i]);
          return;
        }
        var rewritten = sameOriginUrl(batch.url);
        if (rewritten === batch.url) {
          batches.push(batch);
          return;
        }
        var copy = {};
        for (var key in batch) {
          if (Object.prototype.hasOwnProperty.call(batch, key)) copy[key] = batch[key];
        }
        copy.url = rewritten;
        batches.push(copy);
      });
      added.forEach(function (entry) {
        batches.push({
          phase: "application",
          url: sameOriginUrl(entry.url),
          rev: entry.rev,
          entries: [entry.id]
        });
      });
      merged.batches = batches;
    }
    merged.rev = value.rev;
    merged.entries = entries;
    return merged;
  }

  // ------------------------------------------------------------ __ModuleLoader__
  // DSH injects the facade inline at serve time as a plain object:
  //   { mode:"queue", pendingQueue:[], load(r){...}, create(opts){...} }
  // Boot calls `moduleLoader.create(...)` (so `create` MUST survive), and the
  // ClientModuleSystem constructor later reassigns `mode`/`load` on the SAME
  // object. The old wrapper returned a load-only stub `{load}`, which dropped
  // `create` → "i.create is not a function" → "Failed to load plugins".
  // A Proxy forwards every property (create/mode/pendingQueue, plus the
  // constructor's reassignments) to the real facade and only intercepts `load`
  // to capture client plugin factories for desktop bookkeeping.
  var wrappedLoaders = new WeakMap();
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
    if (!isObject(real)) return real;
    var existing = wrappedLoaders.get(real);
    if (existing !== undefined) return existing;
    var proxy = new Proxy(real, {
      get: function (target, prop, receiver) {
        if (prop === "load") {
          return function (handoff) {
            if (isObject(handoff) && typeof handoff.id === "string") {
              var id = handoff.id;
              // DSH's own client packages are shipped with the shell and never
              // unmounted by the desktop, so instrumenting them buys nothing and
              // would tag hundreds of nodes. Everything else — third-party
              // plugins and the desktop's own — goes through the wrapper.
              if (id.indexOf("@deepseek-ai/") !== 0) {
                handoff = Object.assign({}, handoff, {
                  factory: instrumentFactory(id, handoff.factory)
                });
              }
              factories.set(id, handoff.factory);
            }
            // Read target.load fresh each call: the ClientModuleSystem
            // constructor reassigns it from queue-push to live-register after
            // boot, and we must invoke whichever is current. For the live
            // arrow function the .call receiver is a no-op, so it is safe.
            return target.load.call(target, handoff);
          };
        }
        if (prop === "create") {
          // DSH's web boot (packages/client/web/src/boot.ts) calls
          // `moduleLoader.create({...})` once to build the ClientModuleSystem,
          // then keeps the instance private — unlike boot.tsx, boot.ts NEVER
          // publishes `window.__DSH_MODULES__`. Without this intercept the
          // proxy's `modules` local stays undefined, `live` stays false, and
          // no `added`/`rebuilt`/`removed` ever reaches the hmr plugin — so a
          // plugin dropped into the desktop directory never mounts in the
          // running webview. Capturing `create`'s return value is the only
          // injection point that survives boot.ts; it mirrors how boot.tsx
          // would have set __DSH_MODULES__. Patching modules here also flips
          // `live` true for the state already polled before boot finished,
          // so nothing is lost across the boot seam.
          return function (options) {
            var instance = target.create.call(target, options);
            // Publish on the slot so any later reader of
            // window.__DSH_MODULES__ sees the live instance, exactly as
            // boot.tsx would have done. The setter runs patchModules and
            // re-runs applyState so buffered `added` events flush.
            try { window.__DSH_MODULES__ = instance; } catch (e) {}
            return instance;
          };
        }
        return Reflect.get(target, prop, receiver);
      }
    });
    wrappedLoaders.set(real, proxy);
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
      // Boot finished only after the ClientModuleSystem exists. State polled
      // while `modules` was undefined buffered its `added` events (emit saw no
      // listeners yet, OR applyState's `live` guard dropped them). Re-run the
      // diff against the last polled state now that `live` is true, so those
      // `added` events finally reach the @dsh-desktop/hmr plugin and mount.
      if (bootSeen) applyState(lastState);
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
          // Shape must match what the RUNNING client-modules bundle walks, and
          // that is not the same as what the source tree documents. Two fields
          // are load-bearing and neither is obvious:
          //
          //  - `arriveGraphRow` iterates `row.external` *and then* `row.inject`,
          //    resolving each against the graph. A row without `inject` throws
          //    `row.inject is not iterable` from inside `prefetch`, which the
          //    HMR driver awaits — so a hot swap silently stops half-way: the
          //    graph row updates, the caches clear, and the fiber is never
          //    replaced, with the rejection swallowed by the driver's queue.
          //  - `arrive` fetches `reloadUrl ?? row.initialUrl`, NOT `row.url`.
          //    A row published with only `url` therefore loads `undefined` and
          //    fails with `bundle script undefined failed to load`. The rows
          //    the host composes carry `initialUrl`, so this only ever breaks
          //    on rows this proxy publishes — which is every desktop plugin.
          //
          // Both arrays and the initial url are therefore always present.
          var rowUrl = sameOriginUrl(entry.url);
          this.graphRows.set(entry.id, {
            id: entry.id,
            url: rowUrl,
            initialUrl: rowUrl,
            rev: entry.rev,
            external: Array.isArray(entry.external) ? entry.external.slice() : [],
            inject: Array.isArray(entry.inject) ? entry.inject.slice() : []
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
    },
    // Belt-and-braces sweep for the fiber driver: the reclaim normally runs as
    // the plugin's own last disposer, but a plugin that was mounted without
    // going through the wrapper (or whose fiber was torn down some other way)
    // still leaves tagged nodes behind.
    reclaim: function (id) {
      return reclaim(id, "sweep");
    },
    // Diagnostics: which plugins the shell managed to wrap. A plugin missing
    // from this list is one whose teardown is still entirely its own business.
    instrumented: function () {
      var out = [];
      instrumented.forEach(function (id) { out.push(id); });
      return out;
    },
    // What the shell is currently holding for one plugin. Non-zero counts after
    // an unmount would mean the ledger leaked; non-zero counts while mounted are
    // simply what the plugin is using.
    ledger: function (id) {
      var ledger = ledgers.get(id);
      if (ledger === undefined) return null;
      return {
        nodes: ledger.nodes.length,
        timers: ledger.timers.length,
        intervals: ledger.intervals.length,
        frames: ledger.frames.length,
        listeners: ledger.listeners.length,
        closables: ledger.closables.length,
        observers: ledger.observers.length
      };
    }
  };

  // ------------------------------------------------------------- state polling
  var lastState = undefined; // last polled /plugins/state, replayed when modules lands

  function sessionAllowed(entry, session) {
    if (!Array.isArray(entry.sessions) || entry.sessions.length === 0) return true;
    if (session === null || session === undefined) return false;
    return entry.sessions.indexOf(session) !== -1;
  }

  function applyState(state) {
    if (!isObject(state) || !Array.isArray(state.entries)) return;
    lastState = state; // remember for the post-boot replay in the modules setter
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
