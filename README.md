# magpie-claudeweb2api

把 Claude 网页会话接入 Magpie 的 provider 插件。使用 Bun 加载的 JavaScript 插件和自动管理的 Go 后端，按账号发现网页可用模型，输出 Anthropic Messages 响应。Magpie 网关负责其他客户端协议的转换。

这是阅读 Claude2api 的 `claude/`、`tlsclient/`、`models/` 和 `handlers/` 后重新实现的适配器。没有复制原来的 HTTP 服务、账号文件或服务端工具执行器。

## 当前状态

**本插件需要附带的 Magpie `cleanRemove v1` 补丁。原版 Magpie 尚未提供这个接口。** 未检测到该能力时，插件加载失败，后端不会启动。`magpie.cleanRemove`、`magpie.uninstall`、`magpie.dispose` 和 `input.magpie.proxyFor` 是本项目补丁定义的扩展，不能当作现有官方接口使用。

补丁和基准版本见 [integrations/README.md](integrations/README.md)。当前交付是本地可构建、可测试的源码及发行包，尚未发布到 npm，也没有使用真实 Claude 账号验证上游可用性。

## 安装与删除

正式分发需要把发行包发布到 npm 注册表，随后在支持上述补丁的 Magpie 中通过 Plugins 输入包名安装。当前 `.tgz` 是待发布的产物；Magpie 不能把本地 `.tgz` 路径直接当作插件源码加载。自动集成测试用临时本地 npm 注册表验证实际发行包安装。

插件加载时自动选择并校验本机对应的 Go 程序，启动后端。登录时粘贴 `sessionKey` 或完整 Cookie；Cookie 由 Magpie 的账号存储保存，传给 Go 时仅经过私有管道。

开发阶段可以先构建，再添加本地目录：

```sh
npm run build:all
magpie plugin add /absolute/path/to/magpie-claudeweb2api
magpie plugin login claude-web
magpie provider test claude-web
```

删除使用 Magpie 的删除按钮或 `magpie plugin remove <安装时的 spec>`。配套补丁会停止本进程内各代宿主的后端，移除专属登录凭据、账号显示记录、provider 配置、模型目录、插件选项和安装记录；npm 安装还会移除包目录和按包名归属的 Bun 下载缓存。清理失败会报告错误，并保留注册信息供重试。

本地目录安装属于开发模式：删除只清理注册和运行数据，**保留你自己的源码目录**。完整的已安装文件清理需要 npm 发行包。Magpie 共用的 Bun、其他插件以及用户另行保存的项目和导出文件保留。Git 安装的下载缓存无法可靠按包名归属，暂不承诺完整清理，发行安装使用 npm 包。

## 隔离方式

- Go 可执行文件随包分发；用户无需安装 Go、Node、Docker。Magpie 提供 Bun。
- 不在运行时下载文件，不安装系统服务，不修改 PATH 或 shell 配置。
- Go 使用 stdin/stdout 管道，不监听端口。父宿主正常退出或被强制结束时，管道关闭，后端取消请求并退出。
- Cookie、TLS Cookie Jar、浏览器身份和临时会话状态仅存在后端内存。不同凭据和代理使用独立客户端。
- 不写独立配置、Cookie、日志、缓存或 PID 文件；不记录请求内容和上游响应正文。
- 包内提供 SHA-256 清单，启动前检查后端完整性；此校验不代替发行包来源验证。

Magpie 自身的历史请求记录、用户设置的代理路由/模型选择、备份和导出属于宿主或用户的数据，不是插件生成的文件；本补丁不会递归擦除这些共享数据。卸载验收覆盖本插件的安装与运行状态，不能追溯删除用户保存的外部副本。

## 支持范围

| 能力 | 状态 |
| --- | --- |
| 网页模型发现、多个账号 | 支持；账号调度由 Magpie 负责 |
| 文本聊天、流式和非流式 | 支持；文本增量立即转发 |
| 网页会话复用 | 支持；按 Magpie 对话标识或 `conversation_id` 复用，并衔接上一轮父消息 UUID |
| 自定义 `stop_sequences` | 支持；跨片段匹配，返回命中的停止词并取消上游，工具 JSON 不参与匹配 |
| 客户端工具调用 | 支持；提示词协议模拟，转换为 `tool_use`，工具由客户端执行 |
| `tool_result`、工具选择、禁止并行 | 支持 |
| 取消、超时、401、429、Retry-After | 支持；流中失败输出 error，不伪造成功结束 |
| 图片、附件、网页内置工具 | 暂不支持，明确拒绝图片和附件 |
| 签名的 extended thinking、自动登录/续期、额度查询 | 暂不支持 |
| 精确 token 和上游 prompt cache 计费 | 不支持；usage 按 Unicode 字符数 / 4 估算 |

`max_tokens` 同样采用每个估算 token 约 4 个 Unicode 字符的输出上限，最多 4 Mi 字符；达到上限返回 `max_tokens` 并取消上游。工具参数不会被截成无效 JSON，超出预算则报错。上游的 `max_tokens` 和 `refusal` 结束原因会保留。`stop_sequences` 最多 64 个，每个不超过 8192 个 UTF-16 单元；流式输出仅暂存可能匹配停止词的尾部。

网页接口不能等价实现官方 API 的采样参数或 system 优先级；角色和工具定义序列化进 prompt。工具 JSON Schema 校验覆盖类型、required、properties、additionalProperties、items、enum、const、本地 `$ref`、allOf / anyOf / oneOf / not、数值上下界、字符串长度、数组长度和唯一性、对象属性数量。字符串长度按 Unicode 字符计，枚举中的对象不受键顺序影响。外部引用在请求准备阶段拒绝；递归和校验操作量受限。未列出的约束（如 pattern、format、multipleOf 和条件 schema）由客户端工具验证，不宣称实现完整 JSON Schema。

多组织账号优先使用 Cookie 的 `lastActiveOrg`，但必须在账号组织列表中验证归属；过期或无归属的提示回退到第一个可用组织。模型发现最多等待 20 秒。一个流的消费者过慢时，只取消该请求，保留其他账号的请求和后端浏览器身份。

有对话标识时，会复用网页会话；没有标识时，每次请求创建临时会话并尝试删除。模型、system/工具设置变化或历史分支变化会清理旧会话并重建；失败、取消、本地停止词或输出预算截断的会话不再续用，避免下一轮带入未交付给客户端的内容。所有映射、历史摘要和父消息 UUID 只存在内存中，不存完整历史。每个账号最多保留 16 个会话；下次建立/查找会话时清理空闲超过 30 分钟的条目，超过容量时淘汰最旧条目。后端重启后映射消失，下一次用客户端完整历史重建。

插件停止或卸载时，会在总计 1.5 秒期限内尝试删除所有保留会话；当前请求取消后的清理最多 3 秒。上游不可达、账号已经被拒绝/限流或进程被强制杀死时，远端会话清理无法保证。账号受限制时不会为了清理而继续发送请求；本地进程和文件隔离仍由卸载契约保证。

## 对话标识与请求保护

Magpie 的 `chat.headers` 钩子会自动传递宿主的对话标识。直接调用插件时，也接受请求体的扩展字段 `conversation_id`（优先，最多 256 字符）或 `X-Magpie-Session` / `X-Session-Id` 等会话头。标识必须对每段独立对话保持唯一；宿主未获得客户端 ID 时可能根据第一条消息推导标识，两个相同开场的独立对话应由客户端明确提供不同 ID。

```json
{
  "model": "你的网页模型 ID",
  "conversation_id": "my-dialogue-001",
  "max_tokens": 1024,
  "messages": [{ "role": "user", "content": "你好" }]
}
```

后续请求继续使用同一 ID，并携带完整历史。当前 prompt 序列化仍与原项目一样包含完整历史，尚未改为只发送新增用户文本，因此不宣称具有原生对话的 token 优势。历史摘要检查用于避免把编辑后的对话接到旧分支。已成功完成的相同请求会返回 409，防止重试造成重复提交。

对话在插件内绑定原来的 sessionKey 和有效代理；宿主选择了不同账号或代理时返回 409，不会把会话静默接给另一个账号。**这不是自动把 Magpie 调度器固定到原账号**。多账号使用时，应固定原账号；网关支持的 `X-Magpie-Account` 可用于明确指定账号。账号不可用时开始新对话，不会自动轮换账号来绕过限制。

后端独立执行以下保护，宿主重复请求也必须经过它们：

- 同一 sessionKey 的请求串行执行，上一个请求结束后至少间隔 1 秒；换模型、附属 Cookie 或代理仍共享保护。
- 模型列表缓存 60 秒，减少重复发现请求。
- HTTP 或 SSE 的 429 触发冷却；支持秒数/HTTP 日期的 `Retry-After`，缺失或无效时默认 60 秒，范围 1 秒至 7 天。
- HTTP 或 SSE 的 401/403 暂停该 sessionKey 在当前后端进程中的后续请求；更新有效凭据或在网页解决限制后再重新加载。插件没有自动重试、验证码处理或绕过限制的逻辑。

这些是限制请求量和正确处理拒绝的措施，不能承诺账号不会被限制，也没有用真实账号验证其对封号概率的影响。不要把支持网页调用等同于获得官方 API 的使用保障。

## 选项

通过 Magpie 的插件 Options 设置：

```json
{
  "effort": "medium",
  "locale": "zh-CN",
  "timezone": "Asia/Shanghai",
  "contextLimit": 200000,
  "outputLimit": 8192
}
```

`contextLimit`、`outputLimit` 是向网关声明的规划上限，不代表账号真实套餐限制。`proxy` 留空时跟随宿主当前账号的有效代理，也可以显式指定 URL 或 `direct`。`origin` 默认 `https://claude.ai`，只接受 HTTPS origin；本地测试允许 loopback HTTP。改用其他 origin 会将账号 Cookie 发送到该地址。

## 构建与验证

开发需要 Go 1.26.4+、Node 22+，宿主集成测试还需要 Bun 和 Magpie 源码。

```sh
npm run build          # 本机后端
npm test               # 协议和真实后端进程测试，连接本地模拟服务器
npm run test:go        # Go race tests
npm run build:all      # macOS / Linux / Windows，arm64 / x64
npm run check          # 检查六个二进制、校验和及无安装脚本/运行依赖
npm pack               # 生成发行包，prepack 自动检查
```

宿主补丁的可复现测试见 [integrations/README.md](integrations/README.md)。设计、协议和卸载边界见 [docs/design.md](docs/design.md)，实际执行结果见 [docs/verification.md](docs/verification.md)。构建了六个平台不等于在六个平台运行验证。
