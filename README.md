# DSH Desktop

DeepSeek Harness 桌面版 —— 基于 Rust + Tauri 的启动包装与桌面壳。

## 架构

```
① 启动动画窗口 (splash)         ② 主界面窗口 (main)
不透明 · 区域裁剪圆角            无边框 · 区域裁剪圆角 · 自定义标题栏
Rust 状态机驱动                  子 WebView 全宽加载 DSH Web UI（就绪后才挂载）
大号 DeepSeek 鲸鱼 logo          动画播完自动进入（无按钮）

主题桥：注入脚本（DSH 页面内）→ 本地回环 HTTP 桥 → 壳事件
        → 壳/标题栏/splash 颜色实时跟随 DSH 前端主题（浅色/深色动态切换）
```

- 壳前端：Vite + React + TS（MPA：`index.html` 主窗口 / `splash.html` 启动动画）
- 后端：Tauri v2（Rust），模块：
  - `discover.rs` 环境检测（node/npm/pnpm/dsh/依赖 五项探针）
  - `provision.rs` 真实自动安装（node/pnpm/dsh 下载安装到 runtime）
  - `host.rs` 进程管理（spawn/就绪行/健康检查/进程树清理/附着）
  - `bridge.rs` 主题桥 + 插件桥（回环 HTTP + token + `/plugins/state` + bundle 服务）
  - `plugins.rs` 插件目录扫描 / 哈希 / 轮询热更新

## 启动流程（严格顺序，检测不过不启动）

1. **检测运行环境**：node / npm / pnpm / dsh CLI / 依赖 五项真实探针
   （`dsh-launch.json` → `harness-versions` 最新包 → PATH/env 回退）
2. **自动安装缺失组件**（真实安装，日志实时显示在 splash）：
   - nodejs：npmmirror 下载 node-v22.19.0-win-x64 → `runtime\node`
   - pnpm：`npm install -g pnpm@11.7.0 --registry=npmmirror --prefix runtime\pnpm-global`
   - dsh：`npm install --prefix runtime\dsh @deepseek-ai/dsh`
   - DSH_HOME：自动初始化
   - 安装后重新检测，仍缺 → splash 错误面板（日志 + 重新检测）
3. **附着或启动**：端口探测（17890/3080）已有实例则附着；否则
   `node <cli> --profile web --port 0`（stdout 就绪行解析 + HTTP 健康检查）
4. **自动进入界面**：挂载子 WebView → 显示主窗口 → splash 关闭销毁

## 开发

```sh
npm install            # NODE_ENV=production 环境下需加 --include=dev
npm run tauri dev      # 开发运行（Vite HMR + cargo 增量编译）
npm run build          # 前端构建
cargo build            # Rust 构建（src-tauri 下）
node scripts\make-icon.mjs && npx tauri icon app-icon.png   # 重新生成图标
scripts\verify-theme.ps1    # 主题联动验证（需 CDP 9222）
```

> 注意：本机环境变量 `NODE_ENV=production` 会让 npm 跳过 devDependencies，
> 安装依赖时用 `NODE_ENV=development npm install --include=dev`。
> crates.io 慢：`$CARGO_HOME\config.toml` 已配 rsproxy 镜像。

## 环境变量

| 变量 | 说明 |
|---|---|
| `DSH_CONTENT_URL` | 子 WebView 加载的 DSH Web UI 地址（默认 `http://127.0.0.1:17890`） |
| `DSH_SPLASH_HOLD_MS` | 延长 splash 停留时间（毫秒，调试用，默认 700） |

## 里程碑

- [x] M1 双窗口骨架：splash 圆角 + 无边框主窗 + 子 WebView
- [x] M2 环境检测（五项探针）+ host 进程管理 + 附着/启动
- [x] M2.5 真实自动安装（node/pnpm/dsh，演练验证通过）
- [x] 主题桥：DSH 主题 → 壳动态联动（浅色/深色实时切换验证通过）
- [x] M3 注入代理层：接管 `__DSH_BOOT__` / `__ModuleLoader__` / `__DSH_MODULES__`
      （真机 CDP 验证通过）
- [x] M4 前后端插件热插拔 + 会话级隔离：新增 / 改代码 / 删除三条路径均免刷新
      （真机 CDP 验证通过）+ 后端 overlay 热重载 + session observer/过滤
- [x] M5 设置 / 托盘 / 诊断导出（设置面板、关闭到托盘、开机自启、诊断导出）
- [x] M6 打包（NSIS `.exe` 安装包）

## 插件系统

```
plugins/<name>/client.js   前端插件（window.__ModuleLoader__.load + apply(ctx)）
plugins/<name>/server.js   后端插件（写入 $DSH_HOME/desktop-overlay/cordis.yml）
```

热更新分成两半，因为注入脚本跑在 cordis 之前、拿不到 loader：

- `plugin-proxy.js`（initialization_script）劫持三个全局钩子、轮询 bridge
  `/plugins/state`、维护模块图的 graph row，并把 `added` / `rebuilt` / `removed`
  变更发布到 `window.__DSH_DESKTOP__`；
- `@dsh-desktop/hmr`（内建 cordis 客户端插件）订阅该变更流，在 cordis 里完成
  fiber 热交换：`invalidate` → `prefetch` → 摘除 registry 记录 → 排空旧 fiber
  → 移除该插件的 `<style>` → `entry.refresh()`。

顺序不可颠倒：registry 记录不先摘除，Loader 会把 entry 永久标成 `disabled`；
`entry.fiber` 不显式删除，`refresh()` 会直接空转。详见 `hmr-plugin.js` 头注释。

调试：`scripts\cdp-eval.ps1 -UrlMatch 17890 -Expression "<js>"`（需 CDP 9222，
以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动）。
