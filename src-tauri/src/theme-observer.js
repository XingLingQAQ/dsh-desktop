// Theme observer — injected into the DSH content webview at document creation.
// Watches the DSH theme (body[data-ds-dark-theme] + --dsw-alias-* CSS variables)
// and reports snapshots to the desktop shell's local bridge.
(function () {
  var bridge = "__BRIDGE__";
  var press = "__PRESS__";
  // 用户按在 DSH 页面上时报一声，好让不该盖在上面的浮层（更新弹窗）收起来。
  // 捕获阶段 + 不 await：这一点必须比页面自己的处理更早、也不能拖慢它。
  function reportPress() {
    try {
      fetch(press, { method: "POST", body: "", keepalive: true }).catch(function () {});
    } catch (e) {}
  }
  document.addEventListener("mousedown", reportPress, true);
  document.addEventListener("touchstart", reportPress, true);
  var VARS = [
    "--dsw-alias-bg-base",
    "--dsw-alias-bg-layer-1",
    "--dsw-alias-bg-layer-2",
    "--dsw-alias-bg-overlay",
    "--dsw-alias-border-l1",
    "--dsw-alias-border-l2",
    "--dsw-alias-brand-primary",
    "--dsw-alias-brand-primary-invert",
    "--dsw-alias-label-primary",
    "--dsw-alias-label-primary-inverted",
    "--dsw-alias-label-secondary",
    "--dsw-alias-label-tertiary",
    "--dsw-specific-sidebar-fill",
    "--dsw-alias-state-success-primary",
    "--dsw-alias-state-error-primary",
    "--dsw-alias-state-warn-primary",
    "--dsw-alias-interactive-bg-hover",
    // Not a colour: the shell's own surfaces set text in DSH's mono stack so a
    // hash or a version reads the same here as it does in the page.
    "--dsw-font-markdown-code-font-family"
  ];
  function snap() {
    var out = { dark: false, vars: {} };
    try {
      out.dark = document.body
        ? document.body.hasAttribute("data-ds-dark-theme")
        : false;
    } catch (e) {}
    try {
      // 别名变量定义在 body 上（design-platform.css），html 不会继承 body 的
      // 自定义属性，因此优先读 body，必要时回退到 documentElement。
      var target = document.body || document.documentElement;
      var cs = getComputedStyle(target);
      for (var i = 0; i < VARS.length; i++) {
        var v = cs.getPropertyValue(VARS[i]).trim();
        if (!v && target !== document.documentElement) {
          v = getComputedStyle(document.documentElement)
            .getPropertyValue(VARS[i])
            .trim();
        }
        if (v) out.vars[VARS[i]] = v;
      }
    } catch (e) {}
    return out;
  }
  function report() {
    try {
      fetch(bridge, {
        method: "POST",
        body: JSON.stringify(snap()),
        keepalive: true
      }).catch(function () {});
    } catch (e) {}
  }
  function observe() {
    if (!document.body) {
      setTimeout(observe, 200);
      return;
    }
    var obs = new MutationObserver(report);
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-ds-dark-theme"]
    });
    obs.observe(document.documentElement, { attributes: true });
    report();
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", observe);
  } else {
    observe();
  }
  setInterval(report, 1500);
})();
