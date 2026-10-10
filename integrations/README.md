# 原版 Magpie 集成验证

插件无需修改 Magpie 源码或应用补丁。日常使用只需在 Magpie 安装插件；下面的源码测试用于开发验收，不是安装步骤。

`magpie-base.json` 记录验收使用的 Magpie 提交。准备处于该提交的源码目录后，从本项目运行：

```sh
npm run build:all
npm run test:magpie -- /absolute/path/to/magpie-source
```

脚本用 Git 跟踪的文件创建本地 Git 安装仓库（包括已暂存的新文件），再执行 `npm pack`，创建一次性 Magpie 源码副本和隔离的 HOME/XDG 目录。未被 Git 跟踪的本地构建产物不会进入 Git 安装测试。仅在副本中添加测试文件，不改动宿主实现或用户安装的 Magpie；保留 Go 原缓存路径，退出后删除临时副本。

测试分别通过临时本地 npm 注册表和 `git+file://` 仓库，让真实 Bun 按 `--ignore-scripts` 下载并安装插件，使用原版插件宿主和包内 Go 后端，验证本地图标传递与宿主保存、登录、网页模型发现、文本流、客户端工具调用、停止词、拒绝原因、对话标识传递及两轮复用。上游全部是本地模拟服务，Cookie 为测试值。

另有网关推理档位回归，使用原版 Magpie 的 `buildAnthropic` 生成 Haiku 5.5 的低、中、高档位 adaptive 请求，以及 Haiku 4.5 的 enabled 请求，再经过真实 Bun 宿主和发行后端。检查配置映射、正常文本流结束，以及上游未签名思考内容不会泄漏进 API 响应。`magpie-thinking-e2e_test.go` 还提供显式选择的真实上游测试，只有传入授权的 Cookie 文件路径 `CLAUDEWEB_LIVE_COOKIE_FILE` 并单独运行 live 测试时才会读取凭据；默认验收不会使用真实账号。

删除验收覆盖原版宿主的包与注册移除，并等待旧宿主退出后检查管道 EOF 触发保留会话清理。不要求普通删除清空共享账号、显示记录、模型缓存或下载缓存。两种安装均验证后端可执行权限和图标；包元数据中的 `magpie.icon` 与实际加载的 `auth.icon` 必须一致。

Go 后端通过插件 `proxy` 选项设置代理，默认直连，不自动继承宿主代理设置。测试使用 `direct`。

跨平台构建不等于对应系统的运行验证；真实 Claude 上游和正式 GUI 点击操作仍需另行验收。
