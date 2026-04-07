# LODOP Bridge Desktop - Implementation Notes

本文档描述当前项目的实现现状，作为开发协作与后续迭代的技术基线。

## 1. 系统架构

项目采用三层结构：

1. **Desktop Shell (Tauri / Rust)**
   - 负责桌面窗口、命令桥接、主机扫描、代理入口与本地存储。
2. **Frontend (React / TypeScript)**
   - 负责 UI 交互、主机发现与绑定流程、设置管理与诊断展示。
3. **Node Core (TypeScript)**
   - 负责配置管理、日志、网络辅助能力与可复用核心模块。

## 2. 关键模块

### 2.1 Tauri (`src-tauri/`)

- `tauri.conf.json`
  - `productName`: `LODOP Bridge`
  - `identifier`: `com.lodop.bridge.desktop`
- `src/storage.rs`
  - 桌面配置路径：`~/.lodop-bridge-desktop/config.json`
  - 保存绑定主机、收藏主机、扫描设置等状态
- `src/proxy/*`
  - 提供本地代理入口
  - 转发并重写 CLodop 相关请求
- `src/scanner.rs`
  - 负责端口探测、主机信息拉取与扫描结果组织

### 2.2 Frontend (`frontend/`)

- 页面模块：
  - 主机发现
  - 当前绑定
  - 设置
- 关键能力：
  - 通过 Tauri `invoke` 调用 Rust 命令
  - 使用统一 UI 组件构建配置与状态界面
  - 维护用户交互反馈（加载态、错误态、提示态）

### 2.3 Node Core (`src/`)

- `src/config/manager.ts`
  - Node 配置目录：`~/.lodop-bridge`
  - 提供配置读取、绑定信息持久化与白名单管理
- `src/logger/logger.ts`
  - 基于 Winston 输出结构化日志
  - `service`: `lodop-bridge`
- `config/default.json`
  - 默认日志目录：`~/.lodop-bridge/logs`
  - 默认配置文件：`~/.lodop-bridge/config.json`

## 3. 构建与发布

### 3.1 本地构建

- `npm run build:mac`
  - 生成 macOS Universal 安装包（Intel + Apple Silicon）
- `npm run build:win`
  - 生成 Windows NSIS 安装包

### 3.2 CI/CD（GitHub Actions）

- 工作流：`.github/workflows/desktop-release.yml`
- 触发：推送 `v*` 标签
- 输出：
  - `.dmg`（macOS）
  - `.exe`（Windows）
- 发布：
  - 自动创建或更新同名 GitHub Release 并上传产物

## 4. 命名与标识基线

- 仓库名：`lodop-bridge-desktop`
- npm 包名：`lodop-bridge-desktop`
- Rust 包名：`lodop-bridge-desktop`
- 产品名：`LODOP Bridge`
- Bundle ID：`com.lodop.bridge.desktop`

## 5. 当前约束

- 当前版本按“彻底改名”执行，不对旧命名目录做兼容读取。
- 不包含旧技术栈历史叙述，文档和代码均以当前架构为准。
