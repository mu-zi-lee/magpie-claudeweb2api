# 验证记录

日期：2026-10-09。执行机器：macOS arm64；Go 1.27.1、Bun 1.4.2、Node 24.21.0。

Magpie 补丁基于 `c1c887798bde5a11fa33c1b53a67465a8ce19990`。测试使用临时 HOME/XDG 目录、测试 Cookie 和本地 HTTP 服务；未读取真实 Claude 凭据，未修改已安装的 Magpie 或原 Claude2api 仓库。

| 验证 | 结果 |
| --- | --- |
| `npm test` | 25 项通过：协议与生命周期、慢消费者隔离、停止词、schema，以及实际插件会话复用、账号/代理绑定和清理 |
| `npm run test:go` | `go test -race ./...` 通过，包括账号隔离、稳定浏览器身份、SSE 完整性和 EOF 清理 |
| 后端 `go vet ./...` | 通过 |
| `npm run build:all` | macOS / Linux / Windows 的 arm64、x64 六个后端编译通过 |
| `npm run check` 和 `npm pack` | 六个二进制及 SHA-256 校验通过；无 npm 安装脚本、运行依赖；生成发行包 |
| `npm run test:magpie -- <基准源码>` | 未修改宿主实际失败；应用补丁后 race tests 和真实安装/请求/卸载链路通过 |
| Magpie 完整 plugin package race suite | 最终补丁通过；包含卸载中模型请求的并发回归，并修复了全套运行中暴露的测试缓存隔离问题 |
| Magpie `go test -tags nogui ./...` | 最终补丁通过全套 Go 回归；包含 gateway、GUI、provider、plugin 等模块 |
| Magpie 三平台 vet | `go vet ./...`、`GOOS=linux go vet -tags nogui ./...`、`GOOS=windows go vet ./...` 全部通过 |
| Magpie 三平台 build | 本机 GUI 构建、Linux nogui 构建、Windows 构建全部通过；构建产物放在验收临时目录，结束后移除 |

未修改宿主的回归失败是 `TestCleanRemoveOwnedState: cleanup callback did not run`，不是编译失败或跳过。脚本检查这个具体失败后才应用补丁。

完整插件集成测试先执行 `npm pack`，经本地 npm 注册表让 Bun 真正下载并安装此包，再加载真实插件和 Go 二进制。它验证模型发现、中文流式文本、客户端 `tool_use`、后端不执行 Write；随后检查包目录、Cookie、账号显示记录、模型目录、插件注册、Bun 下载目录、哈希索引和 package.json / lockfile 依赖记录均已清除。宿主另有 scoped npm 包、其他插件缓存保留、共享 provider 拒绝清理、损坏账号存储拒绝覆盖等回归测试。

本轮优化新增了活动组织、跨片段停止词和拒绝原因的真实 Bun/Go 集成验收。Go 回归验证 `lastActiveOrg` 必须属于当前账号，无归属或过期提示回退；同账号的组织查询等待支持取消，模型发现不会被另一个查询的锁无限拖住。慢消费者测试向真实后端发送超过队列上限的输出，确认该请求报错后另一账号仍可发现模型，并检查没有重启后端。

停止词、结束原因、schema 校验和组织选择的新增测试先在修改前运行并实际失败，再修复。停止词覆盖流式/非流式、Unicode 边界、重复长前缀、EOF 尾部补发、工具 JSON 排除、预算优先级，以及停止后的无效工具标记不影响已完成响应。schema 覆盖枚举对象的键顺序、本地引用、组合约束、数值和长度限制、布尔 schema、递归限制及外部引用的提前拒绝。

另一个独立回归 `TestCleanRemoveInFlightListingCannotRestoreCatalog` 在没有发布保护时实际失败，错误是 `a late response restored the removed model catalog`。测试让真实 Bun 模型列表请求暂停，执行卸载后再释放响应；修复后迟到结果不再写回已删除的缓存。

会话复用验收覆盖同 ID 的两轮请求只创建一个远端会话，并检查第二轮 parent 等于第一轮 assistant UUID。真实 npm 发行包/Bun 宿主测试通过 `FetchRequest.Session` → `chat.headers` → 插件 → Go 的链路自动传递 ID，卸载时删除保留的会话。Node 的真实插件测试覆盖重复请求、换账号、换代理返回 409，新账号独立会话及卸载清理。

实际插件回归还用快速完成的上游复现本地输出预算先截断、上游可能已提交的情况：等待 discard 删除会话，再用同 ID 继续，确认创建新会话，不续接隐藏回复。Go 回归另验证旧轮次迟到的 discard 不能删除新轮次。

Go race tests 另外覆盖历史编辑/模型切换重建、会话数量/空闲淘汰、请求串行/间隔等待可取消、401/403/429 后不再请求上游、Retry-After 的日期和溢出处理、附属 Cookie/代理变化仍共享账号保护、模型列表缓存与流中限流。上述“账号保护”是可测的请求行为，不是“不会封号”的验收；未测真实账号风控，也未在真实 GUI 中测试账号固定或多账号路由。

这里没有把本地服务器的成功当作真实 Claude 上游验证。真实账号登录、Cloudflare 和网页接口实际访问尚未实测；Linux / Windows 只做构建与静态检查，没有在对应系统运行后端或 GUI。未发布 npm，也没有部署到用户的正式 Magpie。

Magpie 原有 macOS GUI C 编译和链接输出包含 warning，但上述检查和构建均成功。未修改 GUI 页面资源，未运行浏览器 Playwright 套件，也未验证正式 GUI 应用中的点击操作。
