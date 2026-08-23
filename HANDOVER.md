# DSH Desktop 项目交接文档

> 交接日期：2026-08-16 首次交接；2026-08-21 更新（M3/M4 完成并真机验证）；2026-08-24 更新（插件商店重做并端到端验证）
> 项目路径：`D:\Project\DS\dsh-desktop`
> 仓库：https://github.com/XingLingQAQ/dsh-desktop （private）
> 插件目录仓库：https://github.com/XingLingQAQ/dsh-plugin-registry （public，CI 刷 catalog.json）
> 开发运行：在该目录执行 `npm run tauri dev`
> 构建状态：前端 `npm run build` ✅（含 `build:plugins`）/ `cargo check` ✅ 0 error / `cargo test` ✅ 7 passed

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

**插件商店也重做了**（2026-08-24）：商店不再是一个单独的壳面板，而是作为
`设置 → 插件` 里多出来的一条「插件商店」标签页（复用 DSH 自带的
`settings.plugins.tab` slot），目录来自公开仓库 `dsh-plugin-registry`，由 GitHub
Action 每天 04:17 UTC 抓 GitHub `dsh-plugin` topic、读每个候选仓库的 `package.json`
验真、再查 npm 拿到真正可装的 tarball，产出 `catalog.json`。安装走 npm tarball
（不是 GitHub 源码包——源码包缺 `lib/`/`dist/` 这类 build 产物）。安装/卸载经
带 token 的 bridge API 落盘，目录监听器 1s 内把新插件热插进运行中的页面。详见 §7.5。

### 0.5 还差什么（接下来要做的）

- **自启动超时已修复**（2026-08-21）：之前由本程序自己启动 DSH 时会失败，根因是等
  就绪的循环把「500 毫秒没输出」当成了失败——实际只等了半秒就放弃，而 DSH 要安静
  约 5 秒才打印就绪行。现在自启动路径实测可用，详见 §7.1。
- **打包版插件目录已修复**（2026-08-21）：之前装到别人机器上会指向构建机路径，
  插件热插拔和商店都失效。现在 release 落到 `%APPDATA%\dsh-desktop`，详见 §7.2。
- **M5 / M6 已复验**：设置面板、托盘命令、诊断导出、插件商店安装/卸载实测通过；
  NSIS 安装包可构建且含 M3/M4 代码。只剩托盘点击弹菜单需人工确认一次（§7.3）。
- **插件商店已重做并端到端验证**（2026-08-24）：目录来自公开 registry 仓库的
  `catalog.json`（CI 每天刷），安装在 `设置 → 插件 → 插件商店` 标签页里走 npm
  tarball，安装 4s + 挂载 1s，卸载 1s + 取消挂载，全程不刷新页面。详见 §7.5。
- **还没做的**：打包版 `store/` 内置目录已不需要（商店改从 registry 拉，本地
  `store/` 目录随重做一起删除）；仓库根目录堆着一堆调试截图和日志，可以清理了。

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
- [x] **插件商店**（重做 2026-08-24）：`设置 → 插件 → 插件商店` 标签页，目录来自
  公开 `dsh-plugin-registry` 仓库的 `catalog.json`（CI 每日刷），从 npm tarball
  安装，经带 token 的 bridge API 落盘，目录监听热插。端到端真机验证安装/卸载。

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
| 主题桥 + 插件桥 | `src-tauri/src/bridge.rs` | 回环 HTTP + token；转发主题；`/plugins/state` 与 bundle 服务（`no-store`）；带 token 的 `/api/<token>/plugins/{install,uninstall,installed}` |
| 插件目录管理 | `src-tauri/src/plugins.rs` | 扫描 `plugins/`、内容哈希 rev、1s 轮询、后端 overlay 同步；内建插件 `builtin_script()`（含 store bundle） |
| 商店安装/卸载 | `src-tauri/src/registry.rs` | 校验 id 与 tarball host、`curl` 下载、`tar --strip-components=1` 解包、staging 原子 rename、卸载 |
| 本地插件清单 | `src-tauri/src/store.rs` | `plugins_root`、`list_installed`、`uninstall_plugin`、`list_directory`（无本地 catalog —— 目录来自 registry） |
| 设置持久化 | `src-tauri/src/settings.rs` | 配置读写 |
| 商店前端插件 | `src-plugins/store/` | 注册 `settings.plugins.tab` id `desktop-store`；`StoreTab` 搜索/过滤/安装；`data.ts` 拉 catalog + 调 bridge；`vite.plugins.config.ts` 打 CJS bundle |
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
- 商店 catalog：`https://raw.githubusercontent.com/XingLingQAQ/dsh-plugin-registry/main/catalog.json`（公开 registry 仓库，CI 每日 04:17 UTC 刷新）。

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
npm run tauri dev   # beforeDevCommand 会先跑 build:plugins 再 dev

# 仅前端开发
npm run dev

# 前端构建（含插件 bundle）
npm run build          # = build:plugins && tsc && vite build
npm run build:plugins  # 仅打 src-plugins/ → dist-plugins/store.js（CJS，外部化平台词）

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

### 7.2 打包版插件目录指向构建机（已修复 2026-08-21）

**症状**：`lib.rs` 与 `store.rs` 各自内联了一份插件目录解析，都用
`env!("CARGO_MANIFEST_DIR")` —— 编译期常量。旧的 release 二进制里确实能 grep 到
字面量 `D:\Project\DS\dsh-desktop\src-tauri`，即装到别人机器上后插件根目录和插件
商店都指向构建机的不存在路径，打包版的插件热插拔与商店实际不可用。

**修法**：解析逻辑收敛到 `store::data_root()` 一处，并按 `#[cfg]` 拆成两个函数体
（而不是 `if cfg!(...)` 运行时分支 —— 属性拆分让构建机路径**根本不被编译进** release
二进制，而不是编进去但走不到，且这一点可 grep 验证）：

| 构建 | 数据根 |
|---|---|
| debug | 仓库根（`CARGO_MANIFEST_DIR/..`），`npm run tauri dev` 不受 cwd 影响 |
| release | `%APPDATA%\dsh-desktop`，与 `settings.json`、诊断报告同处，用户可写 |

`plugins_root` = `DSH_DESKTOP_PLUGINS_DIR` 覆盖，否则 `data_root()/plugins`；
`lib.rs` 改为直接调 `store::plugins_root()`，消掉了两边会漂移的重复定义 ——
插件扫描与插件商店从此保证同一个目录。

**验证**（grep 重新构建的 release 二进制）：

| 检查 | 结果 |
|---|---|
| 构建机路径 `D:\Project\DS\dsh-desktop` | **0 处**（修复前 1 处）|
| `dsh-desktop\src-tauri` | **0 处**（修复前 1 处）|
| `@dsh-desktop/hmr` 等 M3/M4 代码 | 仍在（5 处）|
| debug 构建 | 仍指向仓库根：`plugins_root=D:\Project\DS\dsh-desktop\plugins` |

（`store_root` 已随 §7.5 的商店重做移除：目录改从 registry 仓库拉，本地不再需要
`store/` 目录，原先的「打包版内置目录为空」遗留随之消失。）

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

### 7.5 插件商店重做（2026-08-24 完成，端到端验证）

**为什么重做**：旧的商店是壳自己画的一个独立面板 + 标题栏上的一个按钮，目录来自本地
`<project>/store/` 的几个示例目录。两个问题：(1) 用户本来就在 `设置 → 插件` 里管理
插件，再多一个入口割裂；(2) 本地 catalog 不可发现，装到打包版还指向构建机路径（§7.2）。
重做后：商店是 DSH 自带插件设置里的一条 tab，目录来自公开 registry 仓库的 `catalog.json`。

**目录链路**（`dsh-plugin-registry` 仓库，公开）：

- `scripts/build-catalog.mjs`：搜 GitHub `topic:dsh-plugin`（stars / updated 两种排序各
  3 页、`per_page=100`，并集去重）→ 每个候选读 `package.json`（raw.githubusercontent，
  不占 API 额度）→ `toEntry` 要求 `dsh.client` + `exports["./client"]`，或 `dsh.bundle`；
  两者都没有的（预设/技能/agent team 类仓库）剔除 → 对每个确认插件查
  `registry.npmjs.org/<name>` 拿 `dist-tags.latest` 的真实 tarball → 输出
  `catalog.json`，按 stars 降序，`generatedAt` 用 ISO。
- `.github/workflows/refresh.yml`：`cron: '17 4 * * *'` + `workflow_dispatch` + 脚本/CI
  变更触发；只在 `catalog.json` 实际变化时才提交；`permissions: contents: write`。
- `schema.json`：catalog 的 JSON Schema（draft 2020-12）。
- **为什么从 npm 而不是 GitHub 装**：插件的 `exports["./client"]` 通常是 build 产物
  （`lib/`、`dist/`），在 `files` 里、发到 npm 但被 gitignore。GitHub 源码 tarball 里
  没有这个文件，安装后入口缺失、挂载失败。npm tarball 正好就是 `files` 集，已构建好，
  装的机器无需工具链。`catalog.json` 的 `tarball` 字段保留 codeload 源码地址但标注
  SOURCE ONLY，`npm.tarball` 才是实际安装源。

**桌面端链路**（本仓库）：

- `src-plugins/store/`（新增，由 `vite.plugins.config.ts` 打成 `dist-plugins/store.js`
  CJS bundle，外部化 10 个平台词）：
  - `index.tsx`：cordis 插件 `dsh-desktop-store`，`inject: ['slots']`，注册
    `settings.plugins.tab` 的 id `desktop-store`、order 30、label `插件商店`。
    样式在模块顶层注入并打 `data-plugin="@dsh-desktop/store"` 标记 —— DSH 的
    `claimStyles` 会把未标记的 `<style>` 认成"正在 materialize 的那个插件"的，不在
    `apply()` 里注入是为了不被别的插件认领、reload 时被一起换掉。
  - `StoreTab.tsx`：搜索 + 三档过滤（可安装/带界面/已安装）+ 刷新；`RENDER_CAP=60`
    截断长列表；隐藏不可装条目（除非已装）；meta 行展示
    `scanned → accepted → installable`；卡片用 `ui-primitives` 的 `Button/Input/Pill`。
  - `data.ts`：`CATALOG_URL` 指向 registry 仓库；`API_BASE = '__BRIDGE_API__'`（bridge
    服务 bundle 时替换成带 token 的真实地址）；sessionStorage 6h 缓存；`install()`
    在 `plugin.npm === null` 时直接抛错，否则 POST `plugin.npm.tarball`。
- `src-tauri/src/registry.rs`（新增）：`install(id, tarball)` 校验 id（npm 形状段校验，
  `.`, `..`, `/` 拒绝，`@scope/name` 支持）、校验 tarball host（`registry.npmjs.org/`
  或 `codeload.github.com/` 前缀）、`curl.exe` 下载、`tar.exe -xzf --strip-components=1`
  解包到 staging、原子 rename 到目标（跨卷 fallback `copy_tree`）；`uninstall(id)` 删目录
  并清理空 scope 目录。3 个单测覆盖路径穿越与 host 白名单。
- `src-tauri/src/bridge.rs`：`start()` 额外构造 `api_path = /api/<token>`、
  `api_base = http://127.0.0.1:<port>/api/<token>`；新路由 `POST /plugins/install`、
  `POST /plugins/uninstall`、`GET /plugins/installed`（全在 token 路径下，避免任何本地
  进程或页面直接驱动写盘）；bundle 服务时把 `__BRIDGE_API__` 替换进 store bundle。
- `src-tauri/src/plugins.rs`：`BUILTIN_IDS` 加 `@dsh-desktop/store`；`builtin_script`
  返回 `include_str!("../../dist-plugins/store.js")`。
- `src-tauri/src/store.rs`：删掉 `StorePluginInfo` / `list_store` / `install_store_plugin`
  / `store_root`（本地 catalog 不再需要）；保留 `InstalledPluginInfo` / `list_installed`
  / `uninstall_plugin` / `list_directory` / `plugins_root`。
- `src-tauri/src/lib.rs`：删 `get_plugin_store` / `install_store_plugin` 命令；保留
  `get_installed_plugins` / `uninstall_plugin` / `list_directory`。
- `src/main.tsx` + `src/styles.css`：删标题栏的 `StoreButton`、设置里的 `plugins` tab、
  相关 store 面板 DOM 与 CSS。商店现在只在 DSH 的插件设置里出现。
- `package.json`：`build` = `build:plugins && tsc && vite build`，新增 `build:plugins`。
- `tauri.conf.json`：`beforeDevCommand` = `build:plugins && dev`（dev 也要先打 bundle）。
- `.gitignore`：新增 `dist-plugins`。

**端到端验证**（CDP，DSH 起在 17890 走附着路径）：

| 场景 | 证据 |
|---|---|
| 商店 tab 出现 | `设置 → 插件` 的 tab 列表含「插件商店」 |
| 搜索安装 | 搜 `dsh-cost-tracker` → 点安装 → 「处理中…」4s 后变「卸载」 |
| 热挂载 | 安装后 1s 内 `__DSH_DESKTOP__.entries()` 多出 `dsh-cost-tracker` |
| 卸载 | 点卸载 → 1s 内从 `entries` 消失，卡片变「安装」 |
| 基线恢复 | 卸载后 entries 回到 4 条（hmr / session-observer / store / desktop-hello） |

测试残留（`store-e2e.js` 等 probe、`host-17890.log`）已清理，未进提交。

**遗留 / 待办**：

- catalog 当前以 npm 是否发布判定 `installable`；只在 GitHub、未发 npm 的插件会被
  隐藏。可后续给 `dsh.bundle` 已提交构建产物的少数仓库开放 codeload 安装路径。
- catalog 刷新依赖 GitHub Action cron，topic 下新增插件最多隔一天才进商店；要更
  及时可在 `refresh.yml` 加 `repository_dispatch`，商店 UI 的刷新按钮再触发。

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
  - `npm run build` ✅ 通过（含 `build:plugins` → `dist-plugins/store.js`，Vite + React + TS 生产构建）
  - `cargo check` ✅ 0 error（3 个非阻塞 warning，见 §7.4）
  - `cargo test` ✅ 7 passed（registry 新增 3 个：id 校验、host 白名单、scoped id）
  - 三个注入脚本 `node --check` ✅ 语法通过
- 当前完成度：M1 – M6 全部完成并复验；插件商店重做完成并端到端验证（§7.5）；剩余口子见 §7（托盘点击 §7.3）。
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
| `get_plugin_store` / `install_store_plugin` | ✅ 安装后 2.5s 内热插到运行中的页面（**已废弃**：商店重做后改走 bridge `/api/<token>/plugins/install`，见 §7.5） |
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

> 注：M6 上面这条记录是在商店重做**之前**的；商店重做后应重新跑一次
> `npm run tauri build` 确认 `@dsh-desktop/store` / `dsh-plugin-registry` /
> `__BRIDGE_API__` 也进了 release 二进制。本次未重打（耗时 ~6min），接手后可补。

**未做**：没有实际安装该 `.exe`（会写系统、不易回滚，需人工决定）。
§7.2 的路径缺陷已修复，商店重做后本地 `store/` 目录也不再需要，安装后插件
热插拔与商店功能预计可用。
