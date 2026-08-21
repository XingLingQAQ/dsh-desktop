# DSH Desktop 插件目录

把插件目录放进这里即可被桌面壳扫描到，无需重启：

```text
plugins/
  my-plugin/
    package.json   # 可选；name / dsh.client / exports["./client"]
    client.js      # 前端 client bundle（必需，或由 package.json 指向）
```

## 前端插件约定

`package.json` 示例：

```json
{
  "name": "my-plugin",
  "version": "0.0.1",
  "dsh": {
    "client": {
      "platform": "web",
      "immediately": true
    }
  },
  "exports": {
    "./client": "./client.js"
  }
}
```

`client.js` 必须通过 `window.__ModuleLoader__.load({ id, factory })` 注册，
并导出 Cordis 风格的 `apply(ctx)`：

```js
window.__ModuleLoader__.load({
  id: "my-plugin",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    function apply(ctx) {
      // 注册 UI / 服务 / 命令
    }
    exports.apply = apply;
    return module.exports;
  }
});
```

## 会话隔离

在 `package.json` 的 `dsh.client.sessions` 里列出允许的会话 ID，插件就只会在
这些会话中生效：

```json
{
  "name": "my-plugin",
  "dsh": {
    "client": {
      "platform": "web",
      "sessions": ["session-abc", "session-def"]
    }
  },
  "exports": {
    "./client": "./client.js"
  }
}
```

桌面壳内置了一个 session observer 插件，会把 DSH 当前会话 ID 上报给桥；
代理层会根据 `sessions` 字段动态添加/移除插件，因此切换会话时无需刷新页面。
不写 `sessions` 的插件仍然是全局生效。

## 后端插件

同一个插件目录里放 `server.js` / `index.mjs` / `index.js` 即可作为后端插件：

```text
plugins/
  my-plugin/
    client.js   # 前端（可选）
    server.js   # 后端（可选）
```

后端插件按 Cordis 插件格式导出 `name` 和 `apply(ctx)`：

```js
export const name = 'my-plugin-server'

export function apply(ctx) {
  // 注册服务 / 工具 / 事件
}
```

桌面壳会把后端插件写进 `$DSH_HOME/desktop-overlay/cordis.yml`，并 touch
`profiles/web/cordis.patch.yml` 触发 DSH 的 live patch watcher，从而在 Host
运行中热应用后端插件变更。

## 热更新

- 桌面壳每秒扫描一次本目录；
- 变更通过 `/plugins/state` 发布，注入的代理层负责更新模块图的 graph row，
  并把 `added` / `rebuilt` / `removed` 变更推送给内置的 `@dsh-desktop/hmr` 插件；
- `@dsh-desktop/hmr` 在 cordis 里完成真正的热替换：`invalidate` → `prefetch`
  → 先摘除 registry 记录 → 排空旧 fiber → 移除该插件注入的 `<style>`
  → `entry.refresh()` 重新实例化，因此改 `client.js` 不需要刷新页面；
- 新增目录会 `loader.create()` 挂载新插件，删除目录会 `loader.remove()` 卸载；
- 修改/新增/删除 `server.js` 会重写后端 overlay 并触发 DSH patch 热重载。

## 环境变量

- `DSH_DESKTOP_PLUGINS_DIR`：覆盖插件根目录（默认是项目根下的 `plugins/`）。
- `DSH_HOME`：DSH 数据目录（后端 overlay 写入 `$DSH_HOME/desktop-overlay/`）。
