# magpie-claudeweb2api

<img src="assets/icon-small.png" alt="magpie-claudeweb2api 图标" width="96" height="96" align="right">

> **使用前请了解封号风险。** 本插件通过 Claude 网页会话发起自动请求，可能导致限流、账号限制、暂停或永久封禁，以及订阅权益或数据损失。插件的请求节流不保证账号安全，请自行评估并承担使用风险。
>
> **免责声明：** 本项目为非官方第三方工具，按 [MIT 许可证](LICENSE)“按原样”提供，不保证账号安全、服务稳定性或持续可用性。在适用法律允许的范围内，作者及维护者不对使用本插件导致的封号、权益损失、数据丢失或其他损失承担责任。

将 Claude 网页会话接入 Magpie，作为独立的 `claude-web` provider 使用。登录后按账号发现网页可用模型，支持文本对话、流式回复和由客户端执行的工具调用。

**无需修改 Magpie 源码或应用补丁。** Go 后端随插件启动，由私有管道通信，不监听端口、不安装常驻服务；宿主退出后自动结束。插件图标随包提供，无需联网下载。

## 当前状态

源码和本地发行包可构建、可测试，**尚未发布到 npm**。原版 Magpie 的实际安装、请求和普通卸载已通过本地模拟服务验证；真实 Claude 账号、Cloudflare 和网页上游访问尚未实测。

## 安装与登录

### 从 GitHub 直接安装

在 Magpie 的 Plugins 中输入下面的安装 spec，或使用 CLI：

```sh
magpie plugin add github:mu-zi-lee/magpie-claudeweb2api#main
magpie plugin login claude-web
magpie provider test claude-web
```

仓库附带 macOS / Linux / Windows 的 arm64、x64 预编译后端和校验清单，安装时无需 Go 或 Node。Magpie 提供 Bun，插件不会在加载时下载或编译后端。

登录时粘贴 Claude 的 `sessionKey` 或完整 Cookie。凭据保存在 Magpie 的账号存储中，插件通过私有管道传给后端；请勿将 Cookie 写进插件 Options、README 或公开日志。

**旧版加载失败时：** 0.1.0 的 GitHub 源码未包含后端，可能报 `No packaged backend` 并显示默认图标。0.1.1 已将后端纳入仓库。Git 安装可能保留锁定的旧提交；更新时可使用 `github:mu-zi-lee/magpie-claudeweb2api#<新提交 SHA>` 明确安装新版，而不是反复添加相同的旧 spec。

### 本地开发安装

完整克隆仓库后也可以添加本地目录：

```sh
magpie plugin add /absolute/path/to/magpie-claudeweb2api
```

将路径替换为项目实际绝对路径。仅在修改 Go 后端后需要重新构建：`npm run build` 构建本机后端，`npm run build:all` 构建全部平台。开发构建需要 Node 22+ 和 Go 1.26.4+。

目前尚未发布到 npm。发布后可在 Plugins 中输入包名安装；当前 `.tgz` 是待发布的产物，不能直接把本地 `.tgz` 路径当作 Magpie 插件源码加载。

## 代理与选项

在 Magpie 的插件 Options 中设置：

```json
{
  "effort": "medium",
  "locale": "zh-CN",
  "timezone": "Asia/Shanghai",
  "contextLimit": 200000,
  "outputLimit": 8192
}
```

| 选项 | 说明 |
| --- | --- |
| `proxy` | 默认直连；需要代理时填写代理 URL，`direct` 表示直连 |
| `effort` | 网页请求的思考强度选项，默认 `medium` |
| `locale` / `timezone` | 网页请求使用的语言和时区 |
| `contextLimit` / `outputLimit` | 向 Magpie 声明的规划上限，不代表账号的真实套餐限制 |
| `origin` | 默认 `https://claude.ai`；修改后会把 Cookie 发送到该地址，仅用于受信任的目标或本地测试 |

代理是访问 Claude 时使用的网络中转。比如代理软件的 HTTP 监听地址为 `127.0.0.1:7890`，可添加：

```json
{
  "proxy": "http://127.0.0.1:7890"
}
```

端口以你的代理软件设置为准。**Go 后端不会自动继承 Magpie 的全局或账号代理。** 能直接访问 Claude 时，`proxy` 留空即可。

## 功能与限制

| 功能 | 支持情况 |
| --- | --- |
| 网页模型发现、多个账号 | 支持；账号调度由 Magpie 负责 |
| 文本聊天 | 支持流式和非流式 Anthropic Messages 响应 |
| 连续对话 | 支持按宿主对话标识或 `conversation_id` 复用网页会话 |
| 客户端工具 | 支持 `tool_use`、`tool_result`、工具选择和禁止并行；工具由客户端执行 |
| 停止词与取消 | 支持 `stop_sequences`、输出预算、取消和超时 |
| 上游错误 | 保留 401/403/429、Retry-After 和流中错误，不伪造成功结束 |
| 图片、附件、网页内置工具 | 暂不支持 |
| 签名的 extended thinking、自动登录/续期、额度查询 | 暂不支持 |
| 精确 token、prompt cache 计费 | 不支持；usage 按 Unicode 字符数 / 4 估算 |

这是网页接口适配器，采样参数、system 优先级和工具协议不能等价于官方 API。工具调用通过提示词协议模拟，返回标准 `tool_use` 后交给客户端执行；后端不会执行客户端的 Bash、Read 或 Write。

使用多个账号时，同一对话应固定原账号。账号或插件代理变化会返回 409；插件不会替 Magpie 调度器自动固定账号，也不会通过轮换账号绕过限制。直接调用时可指定 `conversation_id`，后续请求保持相同 ID 并携带完整历史。

同一 sessionKey 的请求串行执行，完成后至少间隔 1 秒；模型列表缓存 60 秒；429 触发冷却，401/403 暂停该凭据在当前后端进程中的后续请求。这些措施用于控制请求量，不能承诺不会封号。

参数上限、Schema 支持范围、会话复用和远端清理边界见 [协议与会话说明](docs/protocol.md)。

## 删除插件

使用 Magpie 的删除按钮，或执行：

```sh
magpie plugin remove <安装时的 spec>
```

GitHub 安装时，`spec` 是添加时的完整 Git spec；本地目录安装时是路径；npm 安装时是对应包名或版本 spec。卸载按 Magpie 原有流程移除注册和 npm 安装包，本地源码目录保留。正在运行的请求可能延迟旧宿主退出；宿主退出后后端检测管道关闭，取消请求并结束。

Magpie 保存的登录凭据、账号显示记录、模型缓存和 Bun 下载缓存由宿主处理，不保证一次删除全部清空。如需移除保存的 Cookie，可在删除插件前先从 Magpie 移除相应账号。宿主也可能缓存插件图标；这些文件按 Magpie 自身规则管理。

插件不写独立的凭据、配置、日志、缓存或 PID 文件，不修改 PATH 或 shell 配置。Magpie 的共享账号存储、历史记录、路由、备份和导出由宿主或用户管理。远端会话清理为有界尝试，上游不可达或账号受限时无法保证成功。

## 开发与验证

```sh
npm run build          # 构建本机后端
npm test               # 插件、协议和真实后端进程测试
npm run test:go        # Go race tests
npm run build:all      # 构建 macOS / Linux / Windows 的 arm64 / x64 后端
npm run check          # 检查发行二进制和 SHA-256 清单
npm pack               # 生成发行包
npm run test:magpie -- /absolute/path/to/magpie-source
```

仓库已包含六个平台后端；修改后端源码后，完整发行包需要重新构建六个平台并同步校验清单。运行宿主集成测试还需要 Bun 和处于验收提交的 Magpie 源码；测试仅修改临时源码副本，不改动你安装的 Magpie。跨平台编译成功不等于已在对应系统运行验证。

- [原版 Magpie 集成验证](integrations/README.md)
- [设计与隔离边界](docs/design.md)
- [协议与会话说明](docs/protocol.md)
- [验证记录](docs/verification.md)
- [MIT 许可证](LICENSE)

本项目参考 Claude2api 的网页协议行为重新实现，未复制原来的 HTTP 服务、账号文件或服务端工具执行器。
