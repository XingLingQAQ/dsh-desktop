# DSH Desktop 项目交接文档

> 交接日期：2026-08-16 首次交接；2026-08-21 更新（M3/M4 完成并真机验证）
> 项目路径：`D:\Project\DS\dsh-desktop`
> 仓库：https://github.com/XingLingQAQ/dsh-desktop （private）
> 开发运行：在该目录执行 `npm run tauri dev`
> 构建状态：前端 `npm run build` ✅ / `cargo check` ✅ 0 error / `cargo test` ✅ 4 passed

---

## 0. 一页纸交接（本次交接内容整理）

### 0.1 DSH Desktop 是什么

这是一个把 **DeepSeek Harness（DSH）** 包装成桌面应用的程序。
平时用 DSH 要在浏览器里打开一个网址，现在这个桌面版让你双击图标就能用，
看起来像一个正儿八经的本地软件。

### 0.2 打开之后会看到什么

**第一步，启动画面：**
- 屏幕上先弹出一个圆角的小卡片，上面是一只大鲸鱼（DeepSeek 官方图标），
  旁边有光环一圈圈扩散；
- 卡片上会依次打勾三件事：**检查环境 → 启动服务 → 等待就绪**；
- 下面还有实时滚动的文字，告诉你每一步在干什么。

**第二步，主界面：**
- 启动画面消失后，进入一个无边框、四个角是圆的大窗口；
- 顶部有一条我们自己做的标题栏（鲸鱼小图标、软件名、状态灯、端口号，
  以及最小化 / 最大化 / 关闭按钮）；
- 标题栏下面就是完整的 DSH 界面——和浏览器里用的一模一样，
  会话、工作区、模型选择都在。

### 0.3 它替你操心的事

- **自动检查环境**：每次启动先检查五样东西齐不齐——Node.js、npm、pnpm、
  DSH 本体、它的依赖；缺哪个就自动下载安装哪个，进度显示在启动画面上。
- **自动连接**：如果 DSH 服务已经在跑（比如浏览器里开着），它就直接“接上”；
  没在跑就自己启动一个。
- **颜色会跟着变**：在 DSH 界面里把主题从浅色切成深色，外面标题栏和启动动画
  的配色立刻跟着变，浑然一体。
- **关窗口就是退出**：关掉主窗口，程序退出，自己启动的服务也会被干净地清理掉，
  不留垃圾进程。

### 0.4 现在做到了什么程度

启动流程、环境检测、自动安装、主题联动、圆角无边框窗口、动画节奏——都做好了，能用。

**插件热插拔也做完了**，而且是真机验证过的：把插件目录丢进 `plugins/`，界面立刻
多出功能；改插件代码保存，界面立刻跟着变——整个过程页面一次都不刷新。删掉目录，
功能立刻消失。前端插件和后端插件都支持。插件还能只在指定会话里生效。

设置面板、托盘、开机自启、诊断导出、NSIS 安装包的代码也都在（本次未逐项复验）。

### 0.5 还差什么（接下来要做的）

- **自启动超时已修复**（2026-08-21）：之前由本程序自己启动 DSH 时会失败，根因是等
  就绪的循环把「500 毫秒没输出」当成了失败——实际只等了半秒就放弃，而 DSH 要安静
  约 5 秒才打印就绪行。现在自启动路径实测可用，详见 §7.1。
- **打包版插件目录还指向构建机**：装到别人机器上后插件热插拔和插件商店会失效，
  详见 §7.2。这是现在最要紧的一个。
- **M5 / M6 已复验**：设置面板、托盘命令、诊断导出、插件商店安装/卸载实测通过；
  NSIS 安装包可构建且含 M3/M4 代码。只剩托盘点击弹菜单需人工确认一次（§7.3）。
- 仓库根目录堆着一堆调试截图和日志，可以清理了。

### 0.6 几句要紧的交代

1. 机器上还开着一个旧版 DSH 客户端，那个别动；新桌面版可与旧版并存。
2. 程序现在放在 `D:\Project\DS\dsh-desktop` 文件夹里。
3. 运行方式是在那个文件夹里执行 `npm run tauri dev`（开发模式）。
4. `git push` 直连 GitHub 会超时，需要带本机代理：
   `git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push`

---

## 1. 项目是什么

DSH Desktop 是把 **DeepSeek Harness（DSH）** 包装成桌面应用的启动器/桌面壳。

- 平时使用 DSH 需要在浏览器打开网址；
- 本程序让用户双击图标即可使用，体验接近原生本地软件；
- 底层是 **Tauri v2（Rust + WebView）**，前端为 **Vite + React + TS**。

---

## 2. 用户可见形态

### 2.1 启动画面（Splash）

- 圆角小卡片，中央为大鲸鱼（DeepSeek 官方图标）；
- 周边有一圈圈扩散光环动画；
- 卡片上依次打勾三件事：
  1. 检查环境
  2. 启动服务
  3. 等待就绪
- 下方有实时滚动日志，显示当前每一步在做什么。

### 2.2 主界面（Main）

- 无边框、四角圆角的大窗口；
- 顶部为自绘标题栏：
  - 鲸鱼小图标
  - 软件名 + 版本号
  - 状态灯（检测中 / 启动中 / 运行中 / 异常）
  - 端口号
  - 最小化 / 最大化 / 关闭按钮
- 标题栏下方为完整 DSH Web UI（子 WebView 加载），
  会话、工作区、模型选择等与浏览器版一致。

---

## 3. 已实现能力（当前完成度）

- [x] **启动流程**：Splash → 环境检测 → 启动/附着 → 就绪 → 进入主界面。
- [x] **环境检测**：Node.js / npm / pnpm / DSH 本体 / 依赖，五项探针。
- [x] **自动安装**：缺失组件自动下载安装，进度实时显示在 Splash。
- [x] **自动连接**：
  - 端口探测 `17890` / `3080`，已有 DSH 实例则直接附着；
  - 无实例则自动 `node <cli> --profile web --port 0` 启动。
- [x] **主题联动**：DSH 页面内注入脚本 → 本地回环 HTTP 桥 → 壳事件，
  浅色/深色切换时标题栏、Splash 配色实时跟随。
- [x] **圆角无边框窗口**：Windows 下使用 `SetWindowRgn` 圆角裁剪，
  最大化时清除圆角区域避免黑边。
- [x] **关窗即退出**：关闭主窗口触发程序退出，自己启动的 DSH 服务会被清理。

### 里程碑对照

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M1 | 双窗口骨架：Splash 圆角 + 无边框主窗 + 子 WebView | ✅ 已完成 |
| M2 | 环境检测（五项探针）+ host 进程管理 + 附着/启动 | ✅ 已完成 |
| M2.5 | 真实自动安装（node / pnpm / dsh，演练验证通过） | ✅ 已完成 |
| 主题桥 | DSH 主题 → 壳动态联动（浅色/深色实时切换验证通过） | ✅ 已完成 |
| M3 | 注入代理层（`__DSH_BOOT__` / `__ModuleLoader__` / `__DSH_MODULES__` 接管） | ✅ 已完成（真机 CDP 验证通过） |
| M4 | 前后端插件热插拔 + 会话级隔离 | ✅ 已完成（新增/改代码/删除三条路径免刷新，真机验证；后端 overlay 热重载 + session observer/过滤） |
| M5 | 设置 / 托盘 / 诊断导出 | ✅ 已完成（设置面板、关闭到托盘、开机自启、诊断导出） |
| M6 | 打包（NSIS `.exe` 安装包） | ✅ 已完成（`DSH Desktop_0.1.0_x64-setup.exe`） |

---

## 4. 技术架构

```
① 启动动画窗口 (splash)          ② 主界面窗口 (main)
不透明 · 区域裁剪圆角            无边框 · 区域裁剪圆角 · 自定义标题栏
Rust 状态机驱动                  子 WebView 全宽加载 DSH Web UI（就绪后才挂载）
大号 DeepSeek 鲸鱼 logo          动画播完自动进入（无按钮）

主题桥：注入脚本（DSH 页面内）→ 本地回环 HTTP 桥 → 壳事件
        → 壳/标题栏/splash 颜色实时跟随 DSH 前端主题（浅色/深色动态切换）

插件桥：plugins/ 目录（1s 轮询，内容哈希做 rev）
        → bridge `/plugins/state` + `/plugins/<id>/client.js`（no-store）
        → plugin-proxy.js（劫持三个全局钩子 · 维护 graph row · 发布变更）
        → window.__DSH_DESKTOP__
        → @dsh-desktop/hmr 插件（在 cordis 内换 fiber，免刷新生效）
```

### 主要模块

| 模块 | 路径 | 职责 |
|---|---|---|
| 壳前端 | `src/` | React + TS：Splash、主窗口标题栏、主题应用、托盘菜单 |
| 后端主逻辑 | `src-tauri/src/lib.rs` | 启动状态机、窗口生命周期、圆角、子 WebView 挂载、注入脚本装配 |
| 环境检测 | `src-tauri/src/discover.rs` | node / npm / pnpm / dsh / 依赖五项探针 |
| 自动安装 | `src-tauri/src/provision.rs` | 下载安装缺失的 node / pnpm / dsh |
| 进程管理 | `src-tauri/src/host.rs` | spawn、就绪行解析、健康检查、进程树清理、附着 |
| 主题桥 + 插件桥 | `src-tauri/src/bridge.rs` | 回环 HTTP + token；转发主题；`/plugins/state` 与 bundle 服务（`no-store`） |
| 插件目录管理 | `src-tauri/src/plugins.rs` | 扫描 `plugins/`、内容哈希 rev、1s 轮询、后端 overlay 同步 |
| 设置 / 商店 | `src-tauri/src/settings.rs`、`store.rs` | 配置持久化；插件商店 |
| 前端插件代理 | `src-tauri/src/plugin-proxy.js` | 注入 DSH 页面：接管三个全局钩子、维护 graph row、发布变更到 `__DSH_DESKTOP__` |
| 前端热更新驱动 | `src-tauri/src/hmr-plugin.js` | 内建 cordis 插件（`inject: loader/modules`）：在 cordis 内完成 fiber 热交换 |
| 会话观察脚本 | `src-tauri/src/session-observer.js` | 内建 cordis 插件：上报当前会话 id，驱动会话级插件过滤 |
| 主题注入脚本 | `src-tauri/src/theme-observer.js` | 注入 DSH 页面，监听主题变化 |

### 为什么热更新要拆成两半

注入脚本（`initialization_script`）跑在 DSH bundle 之前，那时 cordis 还不存在，
拿不到 `ctx.loader`，因此它只能管模块图的 graph row。真正让插件“换代码就生效”
必须换掉 cordis fiber，而这只能在一个 cordis 插件内部做——这就是
`@dsh-desktop/hmr` 存在的原因。两者通过 `window.__DSH_DESKTOP__` 变更流对接，
HMR 插件订阅之前的变更会被缓冲重放，所以 boot 期间的变更不会丢。

---

## 5. 关键配置

- 主窗口：`1280x820`，最小 `800x600`，无边框，初始隐藏；
- Splash：`440x470`，无边框，置顶，跳过任务栏；
- 端口探测：`17890` / `3080`；
- 启动超时：45 秒；
- 自定义标题栏高度：`46px`（Rust 与 CSS 需保持一致）；
- 圆角半径：`12px`；
- 桌面插件目录：默认 `plugins/`（当前工作目录下），示例插件在 `plugins/desktop-hello/`。

### 环境变量

| 变量 | 说明 |
|---|---|
| `DSH_CONTENT_URL` | 子 WebView 加载的 DSH Web UI 地址（默认 `http://127.0.0.1:17890`） |
| `DSH_SPLASH_HOLD_MS` | 延长 Splash 停留时间（毫秒，调试用，默认 700） |
| `DSH_DESKTOP_PLUGINS_DIR` | 覆盖桌面插件根目录（默认当前目录下的 `plugins/`） |

---

## 6. 开发与运行

```sh
# 开发模式（推荐）
cd D:\Project\DS\dsh-desktop
npm run tauri dev

# 仅前端开发
npm run dev

# 前端构建
npm run build

# Rust 构建（需在 src-tauri 下）
cargo build

# 重新生成图标
node scripts\make-icon.mjs && npx tauri icon app-icon.png
```

### 本机注意事项

- 本机 `NODE_ENV=production` 会让 npm 跳过 devDependencies，
  安装依赖时使用：
  ```sh
  NODE_ENV=development npm install --include=dev
  ```
- crates.io 慢，`$CARGO_HOME\config.toml` 已配置 rsproxy 镜像。
- 已初始化 git，remote 指向 https://github.com/XingLingQAQ/dsh-desktop （private）。
  直连 GitHub 会超时，推送需带本机代理（见 §8）。

---

## 6.5 DSH 上游架构要点（改插件前必读）

这一节是读 DSH 源码得到的结论，**本仓库代码里看不出来**，但改插件系统必须知道。

### 实装源码在哪

```
C:\Users\XingLingQAQ\AppData\Roaming\DeepSeek Harness\harness-versions\<hash>\
```

这是完整的 pnpm monorepo（`apps/cli`、`apps/web`、`packages/` 约 50 个包），
带 `src/` TypeScript 源码，比 GitHub 快且就是实际运行的版本。DSH 上游仓库是
https://github.com/deepseek-ai/deepseek-harness ，一句话概括其架构：
**"Everything is a Plugin"** —— 用 `@deepseek-ai/cordis` 插件框架组合一切。

### 三个全局钩子是 DSH 官方的，不是我们造的

| 钩子 | 定义位置 | 是什么 |
|---|---|---|
| `__DSH_BOOT__` | `packages/client/web/src/boot.tsx:98` | host 注入的 boot 图，`parseBootManifest` 消费 |
| `__DSH_MODULES__` | `packages/client/web/src/boot.tsx:112` | `ClientModuleSystem` 实例 |
| `__ModuleLoader__` | `packages/client/modules/src/client/system.ts:88` | bundle 注册 sink |

而 `desktopSetRow` / `desktopDropRow` 是**我们**打给 `ClientModuleSystem` 的补丁。

### 线上格式约定（造插件条目必须严格匹配）

`packages/client/modules/src/client/manifest.ts`：

- 线上形状是 `{ rev: string, entries: WebBootEntry[] }`；
- 每条 entry 必须有 **字符串** `id` / `url` / `rev`，否则 `parseBootManifest` 直接抛错；
- `inject` 必须是字符串数组、`immediately` 必须是布尔（可省略）；
- **多余字段会被忽略**，所以我们额外带的 `sessions` 字段是安全的；
- URL 约定就是 `/plugins/<id>/client.js?rev=<rev>` —— 和 `plugins.rs` 生成的一致。

`ClientModuleSystem` 的公开 API 只有 `import` / `registerStatic` / `prefetch` /
`invalidate` 和 `loadCache`；`graphRows` / `factories` 是 TS private（运行时仍可访问）。

### fiber 热交换的顺序约束（写错会静默失败）

参照 DSH 自己的 `packages/client/hmr/src/client/index.ts`：

1. `invalidate(id)` 必须在 `prefetch(id)` **之前** —— factory 还活着时 prefetch 是
   空操作，且在未删除的注册上重跑 bundle 会抛 duplicate 错；
2. **先摘 registry 记录**（`entry.ctx.registry.delete(runtime.callback)`）再让旧
   fiber 的 disposer 触发，否则 Loader 会走 self-dispose 分支，把 entry **永久**
   标成 `disabled: true`；
3. `entry.fiber` 必须**显式 delete** —— dispose 不会清它，而 `refresh()` 一看到
   `this.fiber` 还在就直接 return，热更新静默失效；
4. 级联不用记账：下游 fiber 按 provider fiber uid 算激活轮次，换掉 provider
   fiber 会原生重新级联。

Loader 的运行时 API（`vendor/loader/lib/types/config/tree.d.ts`）：
`create(options)` 新增 entry、`remove(id)` 停止并移除、`resolve(id)`、`entries()`。

### bundle 必须 no-store

DSH 的 `defaultLoadBundle` 用 `<script src=url>` 加载。热更新是重跑同一个 URL 路径，
响应被缓存就会把要替换掉的旧 factory 又注册一遍——所以 `bridge.rs` 给 bundle 和
`/plugins/state` 都加了 `Cache-Control: no-store`。

---

## 7. 待办 / 下一步路线

M1 – M6 的代码都已接入，以下是**真正还开着的口子**，按优先级排列。

### 7.1 自启动超时（已修复 2026-08-21）

**症状**：本程序自己 spawn DSH 时报「启动超时：未在预期时间内就绪」，附着路径正常。

**根因**：不是 DSH 慢。`lib.rs` 等就绪的循环把 `wait_event(500ms)` 的**正常轮询空转**
当成了致命错误：

```rust
Err(()) => { ...; fail("启动超时：未在预期时间内就绪"); return; }
```

DSH 在打印就绪行之前会安静 ~4.9 秒（实测），所以第一次 500ms 静默就触发失败——
实际超时是 **0.5 秒而不是 45 秒**，`BOOT_TIMEOUT` 与 `deadline` 成了死代码。

排查时已用实测排除全部外部因素（两者均 ~4.9s 出就绪行，且带正常 `\n` 结尾）：

| 调用方式 | 时间到就绪 |
|---|---|
| app 完整命令（`--patch` overlay + `--port 0` + `DSH_LAUNCH_ENVIRONMENT=desktop`） | 4873 ms |
| 裸命令（无 patch、`--port 0`） | 4841 ms |

**修法**：`Err(())` 只表示"这轮没有事件"，继续循环；仅在进程真的退出或到达 `deadline`
时才失败（并在该分支 sleep 100ms，避免通道 disconnect 后空转打满 CPU）。
同时补上 spawn 路径遗漏的 `set_step(..., "连接就绪")` —— 之前就绪后状态灯标签仍停在
"等待服务就绪"。

**验证**（17890/3080 均空闲，强制走 spawn 路径）：`attached: false`、
`port: 61317`（`--port 0` 随机端口）、`label: "连接就绪"`、`done: true`、`error: null`，
日志有「就绪: http://127.0.0.1:61317」；插件三条目正常加载，改插件代码热更新照旧生效。

### 7.2 打包版插件目录指向构建机（M6 已知缺陷，最高优先级）

`lib.rs:786` 与 `store.rs:39` 都用 `env!("CARGO_MANIFEST_DIR")` —— **编译期**常量。
release 二进制里确实烧进了字面量 `D:\Project\DS\dsh-desktop\src-tauri`（grep 可验证）。

后果：**装到别人机器上后，插件根目录和插件商店会指向构建机的
`D:\Project\DS\dsh-desktop\...`**，该路径在用户机上不存在，于是打包版的插件热插拔
与插件商店实际不可用，除非用户手动设 `DSH_DESKTOP_PLUGINS_DIR`。

`lib.rs:784-785` 的注释表明这是为了让 `npm run tauri dev` 不受 cwd 影响 —— 开发场景
解决了，打包场景没考虑。建议修法：release 下解析到 `%APPDATA%\dsh-desktop\plugins`
（或 exe 同级目录），仅 debug 下回退到 manifest 路径。

### 7.3 托盘点击弹菜单未自动验证

`show_tray_menu` 只由托盘图标点击事件触发，CDP 无法模拟托盘点击。它调用的三个命令
（`show_main_window` / `open_settings` / `quit_app`）本身实测可用，但"点托盘弹出菜单"
这个交互需要人工点一次确认。

### 7.4 可选改进

- `plugins.rs:start_watcher` 目前是 1s 全量轮询，每次都重读所有 `client.js` 算哈希；
  插件多了 IO 会涨，可换 `notify` crate 做文件监听（去抖 300–500ms）。
- 已知竞态（DSH 官方 HMR 也有、并明确接受）：保存发生在 bundle 加载途中时，
  `invalidate()` 不清 `pendingArrival`，`arrive()` 会复用旧的 pending promise。
- 清理仓库根目录的调试截图与日志（`m1-*.png`、`max-*.png`、`tauri-dev*.log` 等）。
- 3 条无害 Rust warning：`discover.rs:151` 多余 `mut`、`lib.rs:602` 无用赋值、
  `host.rs:127` 死代码。

---

## 8. 交接注意事项（务必记住）

1. **旧版 DSH 客户端不要动**：本机可能还开着一个旧版 DSH 客户端，
   本新桌面版与其可并存。
2. **项目位置固定**：`D:\Project\DS\dsh-desktop`。
3. **运行方式固定**：`npm run tauri dev`（开发模式）。
4. 仓库根目录留有大量调试截图/日志（`m1-*.png`、`max-*.png`、`tauri-dev*.log` 等），
   属于过程产物，可后续清理，但当前先保留便于回溯。
5. **推送需要代理**：git 直连 GitHub 会 `Failed to connect to github.com:443`，
   而 curl 直连正常。推送时带上本机代理（不改全局 config）：
   ```sh
   git -c http.proxy=http://127.0.0.1:7890 -c https.proxy=http://127.0.0.1:7890 push
   ```
6. **调试 DSH 页面用 CDP**：以
   `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动，
   再用 `scripts\cdp-eval.ps1 -UrlMatch 17890 -Expression "<js>"` 在页面里求值。
   （注意：旧的 `scripts\cdp-debug.ps1` 有个 bug——会把 CDP 事件帧误当成命令回复；
   `cdp-eval.ps1` 已按 request id 匹配修正。）

---

## 9. 接手后建议第一步

1. 先 `npm run tauri dev` 跑通一次，确认启动画面、主界面、主题联动正常
   （若卡在“等待服务就绪”，见 §7.1；可先手动把 DSH 起在 17890 走附着路径）；
2. 阅读 `src-tauri/src/lib.rs` 的启动状态机，理解 `Splash → Main` 的切换；
3. 熟悉 `discover.rs` / `provision.rs` / `host.rs` 的环境检测与进程管理；
4. 改插件系统前**先读 §6.5**（DSH 上游架构要点），再看两处代码：
   `src-tauri/src/plugin-proxy.js`（graph row + 变更发布）与
   `src-tauri/src/hmr-plugin.js`（cordis fiber 热交换，头注释写明了顺序约束）。

---

## 10. 交接确认（接手方记录）

- 已确认项目路径 `D:\Project\DS\dsh-desktop`，开发运行命令为 `npm run tauri dev`。
- 已阅读 `HANDOVER.md`、`README.md`、`package.json`、`src-tauri/tauri.conf.json` 及核心 Rust 模块。
- 已核验当前可构建状态：
  - `npm run build` ✅ 通过（Vite + React + TS 生产构建）
  - `cargo check` ✅ 0 error（3 个非阻塞 warning，见 §7.3）
  - `cargo test` ✅ 4 passed
  - 三个注入脚本 `node --check` ✅ 语法通过
- 当前完成度：M1 – M6 全部完成并复验；剩余口子见 §7（自启动超时、打包版插件目录、托盘点击）。
- 注意事项已记录：旧版 DSH 客户端不动；本项目可与旧版并存；推送需带代理；调试截图/日志暂保留。

### 本次 M3/M4 实机验证记录（CDP）

以 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222` 启动，
先手动把 DSH 起在 `17890` 让壳走附着路径，再用 `scripts\cdp-eval.ps1` 探测：

| 场景 | 证据 |
|---|---|
| 基线 | `__DSH_DESKTOP__.subscribe` / `desktopSetRow` / `desktopDropRow` 均在；三个内建+样例插件都已 materialize |
| 改代码 | `desktop-hello` rev `c6ab5303…` → `e6ec250c…`；新 `console.log` 文本出现；`exports` 对象已换 |
| 新增插件 | 新目录出现后自动 `loader.create()`，插件 `apply` 日志出现 |
| 删除插件 | 目录删除后从 `entries` 与 `loadCache` 双双消失 |
| 免刷新 | 全程 `window` 上的 marker 值不变，证明页面从未 reload |

**已知问题（非本次改动引入）**：自启动路径出现「启动超时：未在预期时间内就绪」，
详见 §7.1。附着路径（17890/3080 已有实例）工作正常。

### 本次 M5/M6 复验记录

M5 全部经 CDP 调 Tauri 命令实测通过（`withGlobalTauri: false`，走
`__TAURI_INTERNALS__.invoke`）：

| 能力 | 结果 |
|---|---|
| `get_settings` / `set_close_to_tray` / `set_workspace_folder` | ✅ 读写并持久化到 `%APPDATA%\dsh-desktop\settings.json` |
| `export_diagnostics` | ✅ 生成 1645 字节报告（设置、启动状态、日志尾、插件清单、当前会话），无 BOM 的正确 UTF-8 |
| `get_plugin_store` / `install_store_plugin` | ✅ 安装后 2.5s 内热插到运行中的页面 |
| `uninstall_plugin` | ✅ 卸载后从页面移除 |
| `get_installed_plugins` | ✅ `has_client` / `has_server` 判定正确 |
| `list_directory` | ✅ 目录优先排序 |
| `get_launch_state` | ✅ step=3 已就绪、`attached: true` |
| 开机自启 | 只读验证：`reg add/delete/query` 逻辑正确；注册表项全程未写入 |

M6：`npm run tauri build` ✅ 通过（release 编译 6m13s，0 error），产出
`src-tauri\target\release\bundle\nsis\DSH Desktop_0.1.0_x64-setup.exe`（1.95 MB），
release exe 8.31 MB / ProductName `DSH Desktop` / FileVersion `0.1.0`。
grep 二进制确认 M3/M4 代码确实打进去了：`@dsh-desktop/hmr`、`registry.delete`、
`Cache-Control: no-store`、`__DSH_DESKTOP__` 均在。

**未做**：没有实际安装该 `.exe`（会写系统、不易回滚，需人工决定）。
配合 §7.2 的路径缺陷，安装后插件功能预计不可用。
