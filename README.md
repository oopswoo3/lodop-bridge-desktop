# lodop-proxy-core

### 项目简介

`lodop-proxy-core` 是一个面向 Node.js / TypeScript 环境的 **LODOP 相关核心工具库**，主要提供：

- **配置管理**：读取和持久化本地 JSON 配置（默认位于 `~/.lodop-proxy/config.json`）。
- **日志系统**：基于 `winston` 的文件日志记录，支持滚动、日志级别等配置。
- **网络工具**：辅助计算网卡 CIDR、遍历网段内 IP、校验 IP 合法性等。
- **错误模型**：统一的错误码和异常类型。

原仓库曾包含 macOS Electron GUI 客户端，目前已移除，本仓库专注于 **可复用的 Node 核心逻辑**，以 npm 单包形式提供。

### 安装

使用 npm 安装（推荐 Node.js 版本 >= 18）：

```bash
npm install lodop-proxy-core
```

或在本地开发环境中（假设当前仓库未发布到 npm）：

```bash
# 在 lodop-nodejs 仓库根目录
npm install
npm run build

# 在其他项目中本地引用
npm install /path/to/lodop-nodejs
```

### 使用示例

#### 导出内容概览

库的入口为 `src/index.ts`，对外导出以下模块：

- 配置管理：`configManager`、`ConfigManager`、`AppConfig`、`BoundHost`
- 日志：`logger`
- 错误：`AppError`、`ErrorCode`、`ErrorMessages`、`createError`
- 网络工具：`getNetworkInterfaces`、`getIPsInCIDR`、`isValidIP` 等

#### 示例：使用配置管理和日志

```ts
import { configManager, logger, getNetworkInterfaces } from 'lodop-proxy-core'

// 读取当前绑定的主机
const boundHost = configManager.getBoundHost()
logger.info('当前绑定主机', { boundHost })

// 更新绑定主机
configManager.bindHost('192.168.1.100', 8000, 'http')

// 获取本机网卡信息
const ifaces = getNetworkInterfaces()
logger.info('网络接口列表', { ifaces })
```

### 配置说明

库使用 `config` 模块加载配置，默认配置文件为仓库内的 `config/default.json`：

```json
{
	"server": {
		"ports": [8000, 18000],
		"allowedOrigins": ["localhost", "127.0.0.1", "file://"],
		"host": "0.0.0.0"
	},
	"discovery": {
		"concurrent": 64,
		"timeout": 1200,
		"ports": [8000, 18000]
	},
	"bridge": {
		"headless": true,
		"browserPath": null,
		"maxInstances": 5,
		"idleTimeout": 30000,
		"connectionTimeout": 10000
	},
	"logging": {
		"level": "info",
		"dir": "~/.lodop-proxy/logs",
		"maxFiles": 10,
		"maxSize": "10m"
	},
	"config": {
		"path": "~/.lodop-proxy/config.json"
	}
}
```

- **server**：可用于上层应用配置本地服务监听端口、允许的 CORS Origin 等。
- **discovery**：用于网络扫描/发现类逻辑的并发数、超时时间、端口列表等。
- **bridge**：为未来与浏览器/其他进程通信预留的桥接配置。
- **logging**：
  - `logging.dir`：日志目录，支持 `~` 展开为用户主目录（例如 `~/.lodop-proxy/logs`）。
  - `logging.level`：日志级别，例如 `info`、`debug`。
  - `logging.maxFiles`：最多保留的日志文件数。
  - `logging.maxSize`：单个日志文件最大大小（如 `"10m"` 表示 10MB）。
- **config**：
  - `config.path`：应用配置文件实际存储路径，`ConfigManager` 会从该路径读写。

你可以通过环境变量 `NODE_CONFIG_DIR` 或在项目中添加自定义的 `config/{NODE_ENV}.json` 来覆盖默认配置。

### 错误与异常

`src/utils/errors.ts` 中定义了统一的错误码和异常类型，例如：

- `ErrorCode.E001`：未绑定主机
- `ErrorCode.E002`：主机离线
- `ErrorCode.E003`：端口不通
- `ErrorCode.E004`：Origin 被拒绝

可以通过 `createError(code, details)` 快速构造带有默认消息的错误对象，并在上层统一处理。

### 网络工具

`src/utils/network.ts` 提供了若干网络相关工具函数，例如：

- `getNetworkInterfaces()`：返回当前机器所有非内网 IPv4 网卡及其 CIDR 信息。
- `getIPsInCIDR(cidr: string)`：根据 CIDR（如 `"192.168.1.0/24"`）生成网段内所有可用 IP。
- `isValidIP(ip: string)`：校验 IP 字符串格式是否有效。

这些工具便于在上层实现局域网扫描、主机发现等功能。

### 运行环境

- Node.js **>= 18**（推荐 LTS 版本）。
- 仅依赖于 Node.js 标准库和 `config` / `winston` / `ipaddr.js` 等 npm 包，不再依赖 Electron 或浏览器环境。

### 许可证

MIT

# LODOP Monorepo

这是一个使用 pnpm 管理的 monorepo 仓库，目前仅包含 macOS 客户端子项目。

## 项目结构

```
lodop-nodejs/
├── packages/
│   └── macos-client/         # macOS Electron 客户端
├── package.json              # 根 package.json（workspace 管理）
├── pnpm-workspace.yaml       # pnpm workspace 配置
└── README.md
```

## 子项目

### macOS Client (`packages/macos-client`)

macOS 可安装的 GUI 客户端，用于在局域网内发现并选择 Windows C-Lodop 打印主机，并在 Mac 本地提供 `localhost` 兼容打印入口。

**功能特性：**

- 可视化界面：扫描局域网内可用的 Windows C-Lodop 主机
- 绑定记忆：保存默认绑定主机
- 状态显示：显示当前绑定主机在线/离线状态
- 本地代理服务：在 Mac 本地启动 HTTP 服务监听 `127.0.0.1:8000`
- 转发打印调用到 Windows 执行

> 历史说明：本仓库早期曾包含 Windows Discovery Agent 子项目，现已移除。如需 Windows 端发现增强工具，可参考历史版本或单独实现。

## 安装依赖

本项目使用 **pnpm** 作为包管理器。首次安装：

```bash
pnpm install
```

## 开发运行

### macOS 客户端

```bash
# 从根目录运行
pnpm dev:mac

# 或进入子目录运行
cd packages/macos-client
pnpm dev
```

## 构建安装包

### macOS 客户端

```bash
pnpm build:mac
```

构建完成后，安装包位于 `packages/macos-client/dist/` 目录下。

> Windows Discovery Agent 的构建说明已随子项目一并移除。

## macOS 客户端使用说明

### 1. 启动应用

启动应用后，会自动启动本地代理服务（监听 127.0.0.1:8000）。

### 2. 发现主机

1. 进入"主机发现"页面
2. 点击"开始扫描"按钮
3. 等待扫描完成，查看发现的主机列表
4. 也可以手动输入 IP:端口 添加主机

### 3. 绑定主机

1. 在发现的主机列表中，点击"选择"按钮
2. 绑定成功后，可以在"当前绑定"页面查看状态

### 4. 测试打印

1. 在"当前绑定"页面，点击"测试连接"验证连通性
2. 点击"测试打印"发送测试打印任务
3. 点击"打开 Demo 页"在浏览器中测试打印功能

### 5. 配置设置

在"设置"页面可以配置：

- 扫描并发数（默认 64）
- 扫描超时（默认 800ms）
- 允许的端口列表（默认 8000, 18000）
- 允许的 Origin 列表（默认 localhost, 127.0.0.1）

## 浏览器集成

在业务页面中，只需要引入：

```html
<script src="http://localhost:8000/CLodopfuncs.js"></script>
```

然后使用标准的 C-Lodop API：

```javascript
window.On_CLodop_Opened = function () {
	const LODOP = getCLodop()
	LODOP.PRINT_INIT('打印任务')
	LODOP.ADD_PRINT_TEXT(10, 10, 200, 30, '打印内容')
	LODOP.PREVIEW()
}
```

## 技术栈

### macOS 客户端

- **Electron**: 主框架
- **React**: UI 框架
- **Playwright**: Headless 浏览器桥接
- **Express**: HTTP 服务器
- **ws**: WebSocket 服务器
- **electron-builder**: 打包工具

> Windows Discovery Agent 技术栈相关说明已移除。

## 注意事项

1. 本项目使用 **pnpm** 作为包管理器，请确保已安装 pnpm
2. 首次使用 macOS 客户端时，Playwright 会自动下载浏览器（约 250MB）
3. 确保 Windows 主机上的 C-Lodop 服务正在运行
4. 确保 Mac 和 Windows 主机在同一局域网内

## 许可证

MIT
