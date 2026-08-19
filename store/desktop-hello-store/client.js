window.__ModuleLoader__.load({
  id: "desktop-hello-store",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    function apply(ctx) {
      console.log("[desktop-hello-store] plugin mounted from store");
    }
    exports.apply = apply;
    return module.exports;
  }
});
