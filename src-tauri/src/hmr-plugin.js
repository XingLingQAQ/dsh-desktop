// Desktop HMR driver — a built-in client plugin that owns the cordis fiber
// lifecycle for desktop-managed plugins.
//
// The injected proxy (plugin-proxy.js) owns the graph rows and the bridge
// polling, but it runs before the loader exists and can never reach cordis.
// This plugin is the other half: it subscribes to the proxy's change feed and
// performs the add / rebuild / remove fiber work.
//
// The rebuild path mirrors DSH's own driver (packages/client/hmr). Two ordering
// rules there are load-bearing and silently fatal if reversed:
//   * the runtime record must leave the registry BEFORE the old fiber's
//     disposer emits, or the Loader takes its self-dispose branch and marks the
//     entry `disabled: true` permanently;
//   * `entry.fiber` must be deleted explicitly, because dispose never clears it
//     and `refresh()` returns early while it is still set.
// Cascade needs no bookkeeping: downstream fibers key their activation epoch on
// provider fiber uids, so replacing a provider fiber re-cascades natively.
window.__ModuleLoader__.load({
  id: "@dsh-desktop/hmr",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    function removeOwnedStyles(id) {
      var nodes = document.querySelectorAll("style[data-plugin]");
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].getAttribute("data-plugin") === id) nodes[i].remove();
      }
    }

    function apply(ctx) {
      var loader = ctx.loader;
      var modules = ctx.modules;
      var desktop = window.__DSH_DESKTOP__;

      // Entry tree ids are generated; the plugin id lives in `options.name`.
      function findEntry(id) {
        var iter = loader.entries();
        for (var next = iter.next(); !next.done; next = iter.next()) {
          var options = next.value.options;
          if (options.name === id || options.id === id) return next.value;
        }
        return undefined;
      }

      async function add(entry) {
        if (findEntry(entry.id) !== undefined) return rebuild(entry);
        // Sweep before mounting: a generation that ended badly (a throwing
        // apply, a reload mid-teardown) can leave tagged nodes behind, and a
        // plugin that guards against double-mounting by looking for its own
        // element would see those and quietly refuse to start.
        try { desktop.reclaim(entry.id); } catch (e) {}
        await modules.prefetch(entry.id);
        await loader.create({ name: entry.id });
      }

      async function rebuild(entry) {
        var id = entry.id;
        var target = findEntry(id);
        if (target === undefined) return add(entry);

        // Invalidate before prefetch: a live factory makes prefetch a no-op,
        // and re-executing a bundle over an undeleted registration throws.
        modules.invalidate(id);
        await modules.prefetch(id);

        var oldFiber = target.fiber;
        if (oldFiber !== undefined) {
          var runtime = oldFiber.runtime;
          if (runtime) target.ctx.registry.delete(runtime.callback);
          // Drain the unload so slot/subscription disposers finish before the
          // new factory materializes and re-registers.
          while (oldFiber.inertia !== undefined) await oldFiber.inertia;
          delete target.fiber;
        }

        // Styles go after the disposers drained and before materialization
        // re-injects them under the same stable tag ids. The proxy sweep joins
        // them: a plugin that leaves its own nodes behind would otherwise see
        // them on the next mount and skip re-mounting as a duplicate.
        removeOwnedStyles(id);
        try { desktop.reclaim(id); } catch (e) {}
        await target.refresh();
        if (target.fiber) await target.fiber.await();
      }

      async function remove(id) {
        var target = findEntry(id);
        if (target !== undefined) {
          // Dispose through the entry's OWN group, keyed by its bare store id.
          // `loader.remove(entry.id)` looks correct but is not: the tree-level
          // remove resolves a nested `parent:child` id and then hands that same
          // full path to the owning group, whose store is keyed by the bare id —
          // so the lookup misses and disposal is silently skipped, leaving the
          // plugin running (its `apply` disposer never fires, so DOM and timers
          // it owns survive the pause).
          //
          // Going through the group also skips the tree-level `write()` that
          // `loader.remove` performs, which is the point: persistence is the
          // shell's business, and letting the loader dump its composed tree back
          // over the watched profile patch duplicates every insert row and takes
          // the host down with «duplicate loader entry id».
          await target.parent.remove(target.options.id);
        }
        modules.invalidate(id);
        removeOwnedStyles(id);
        // Last word on teardown: the proxy reclaims anything the plugin put in
        // the document and did not take back. A plugin is not trusted to clean
        // up after itself, so "the fiber is gone" is not the same as "nothing of
        // it is left on screen".
        try { desktop.reclaim(id); } catch (e) {}
      }

      // Serialize: changes can arrive faster than a swap completes, and
      // interleaved dispose/execute chains corrupt the single-slot handoff.
      var queue = Promise.resolve();
      function enqueue(label, task) {
        queue = queue.then(task).catch(function (error) {
          ctx.logger.error("dsh-desktop/hmr: " + label + " failed");
          ctx.logger.error(error);
        });
      }

      function handle(change) {
        if (change.type === "added") {
          enqueue("add " + change.id, function () { return add(change.entry); });
        } else if (change.type === "rebuilt") {
          enqueue("rebuild " + change.id, function () { return rebuild(change.entry); });
        } else if (change.type === "removed") {
          enqueue("remove " + change.id, function () { return remove(change.id); });
        }
      }

      ctx.effect(function () {
        return desktop.subscribe(handle);
      }, "dsh-desktop/hmr: change feed");
    }

    exports.name = "dsh-desktop-hmr";
    exports.inject = ["loader", "modules"];
    exports.apply = apply;
    return module.exports;
  }
});
