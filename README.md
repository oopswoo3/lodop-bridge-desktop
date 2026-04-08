# LODOP Bridge Desktop

`lodop-bridge-desktop` 是一个基于 **Tauri + React + TypeScript + Node.js** 的跨平台桌面客户端，用于在本机桥接并访问局域网中已启动 LODOP / C-Lodop 的其他机器。

## 功能特性

- 主机发现：扫描局域网内可用 C-Lodop 服务
- 主机绑定：将桌面客户端绑定到指定打印主机
- 连通诊断：提供代理状态、请求路径与基础诊断信息
- 本地桥接：通过本地代理统一转发 CLodop 相关请求
- 收藏与备注：支持常用主机收藏、备注维护

## 使用场景

- 当前电脑为 macOS，无法直接安装或稳定使用 LODOP 软件
- 局域网内已有其他电脑已启动 LODOP / C-Lodop 服务
- 通过本工具将当前电脑桥接到远端打印主机，继续完成打印链路
- 远端主机可为 Windows 电脑，也可为其他可正常运行 LODOP 的机器

## 技术栈

- 桌面壳：Tauri 2.x（Rust）
- 前端：React 19 + Vite + TypeScript
- Node 核心：Express / WebSocket / Winston
- 打包：Tauri Bundler（macOS DMG、Windows NSIS）

## 环境要求

- Node.js >= 18
- npm >= 9
- Rust（stable）
- 平台依赖：
  - macOS：Xcode Command Line Tools
  - Windows：Visual Studio Build Tools（Rust MSVC 工具链）

## 本地开发

在仓库根目录执行：

```bash
npm ci
```

启动桌面开发环境：

```bash
npm run tauri:dev
```

仅启动前端：

```bash
npm run dev
```

## 构建发布

### 本地构建

```bash
# macOS Universal (Intel + Apple Silicon)
npm run build:mac

# Windows NSIS
npm run build:win
```

### GitHub Actions 自动发布

仓库内置 `Desktop Release` 工作流：

- 触发条件：推送 `v*` 标签（仅 `vX.Y.Z` 稳定版会执行构建与发布）
- 产物：
  - macOS `.dmg`（universal）
  - Windows `.exe`（nsis）
- 结果：自动创建/更新同名 GitHub Release 并上传产物

### 无签名安装与权限放行

当前构建为 `--no-sign`，首次安装运行时可能被系统拦截。

#### macOS（DMG / App）

1. 首次打开若提示“无法验证开发者”，前往：
   - 系统设置 → 隐私与安全性 → 仍要打开
2. 若仍被隔离属性阻止，可执行：

```bash
xattr -dr com.apple.quarantine "/Applications/LODOP Bridge.app"
sudo xattr -dr com.apple.quarantine "/Applications/LODOP Bridge.app"
```

#### Windows（NSIS / EXE）

1. SmartScreen 弹窗“Windows 已保护你的电脑”时：
   - 点击“更多信息” → “仍要运行”
2. 安装后首次运行如遇网络访问拦截：
   - 在“Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙”
   - 勾选 `LODOP Bridge`（至少放行“专用网络”）
3. 如企业策略阻止未知发布者，请让 IT 白名单该可执行文件或签发内部证书。

## 配置与数据目录

### Node 侧配置（桥接核心）

- 配置目录：`~/.lodop-bridge`
- 配置文件：`~/.lodop-bridge/config.json`
- 日志目录：`~/.lodop-bridge/logs`

### 桌面侧配置（Tauri）

- 配置文件：`~/.lodop-bridge-desktop/config.json`

> 当前版本采用彻底改名策略，不兼容旧目录，不执行自动迁移。

## 常用脚本

```bash
npm run dev          # 前端开发
npm run build        # 前端构建
npm run tauri:dev    # 桌面开发
npm run tauri:build  # 桌面构建（默认）
npm run build:mac    # macOS Universal 构建
npm run build:win    # Windows NSIS 构建
```

## 目录结构（核心）

```text
.
├── frontend/                 # React 前端
├── src-tauri/                # Tauri(Rust) 桌面与本地代理
├── src/                      # Node 核心能力（配置、日志、网络）
├── config/default.json       # 默认配置
└── .github/workflows/        # CI/CD 工作流
```

## 许可证

MIT
