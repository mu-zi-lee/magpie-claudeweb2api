# Magpie 宿主配套

`magpie-clean-remove.patch` 针对 `magpie-base.json` 指定的提交。补丁仅在 manifest 声明 `magpie.cleanRemove.providers` 的插件上改变卸载行为。现有插件保留原语义。

本插件要求这个补丁提供的 `input.magpie.cleanRemove === 1`。这是未提交上游的项目扩展，当前官方版本不会自动识别它。我们不会通过修改真实 Magpie 配置、注入后台常驻清理服务或假设 npm uninstall 脚本会执行来绕过这个限制。

## 应用补丁

在用于构建的 Magpie 源码目录中：

```sh
git checkout c1c887798bde5a11fa33c1b53a67465a8ce19990
git apply --check /absolute/path/to/magpie-claudeweb2api/integrations/magpie-clean-remove.patch
git apply /absolute/path/to/magpie-claudeweb2api/integrations/magpie-clean-remove.patch
go build -tags nogui -o /your/output/magpie .
```

这是源码构建说明；没有自动改动用户安装的 Magpie，也没有向上游发布补丁。GUI 删除和 CLI 删除都经过相同的 `provider.RemovePlugin` → `plugin.Remove` 路径，补丁落在该公共路径上。GUI 版本的签名、打包和发布仍由 Magpie 的构建流程负责。

## 新增契约

- `input.magpie.cleanRemove: 1`：声明支持以下卸载契约。
- `input.magpie.proxyFor(origin)`：获得当前账号作用域的有效代理，供非 Bun 传输使用。
- `magpie.uninstall` hook：宿主删除包前等待插件停止后端；也通知当前进程内正在退出的旧宿主。
- `magpie.dispose` hook：宿主正常结束时释放后端，不删除账号。
- `package.json` 的 `magpie.cleanRemove.providers`：专属 provider id。宿主持久化到插件注册，保证部分删除失败后仍可重试。

卸载会验证 provider 没有被其他已加载插件共享；清理 Cookie、账号显示记录、provider overrides、插件 config/provider、模型缓存和安装记录。npm 模式通过 Bun 删除包，再删除 cache 中该包名的版本目录、哈希命名的下载索引和 npm 元数据。索引按文件内的实际包名判断归属，避免误删包含该包名的其他依赖索引。近似前缀、其他账号/插件和共享 Bun 保留。不会按插件提供的任意路径递归删除。

下载索引解析已验证 Bun 1.4.2 使用的 `bun-npm-manifest-cache-v0.0.7` 格式。遇到不认识或损坏的格式会报告清理失败，保留注册信息；Bun 将来变更这个格式时，需要更新补丁并重新验证，不能直接宣称兼容。

本地开发路径保留源码，Git 下载缓存和历史使用记录不在这个 npm 清理契约中。参见主 README 的完整范围。

## 可复现验证

从本项目运行，传入处于基准提交的 Magpie 源码目录：

```sh
npm run build:all
npm run test:magpie -- /absolute/path/to/magpie-source
```

脚本创建一次性源码副本和隔离的 HOME/XDG 目录；保留 Go 原缓存路径，避免在临时 HOME 中重新下载整个模块缓存。所有账号均为测试凭据，上游均为本地服务器，退出后删除临时副本。

脚本先执行 `npm pack`，在未修改宿主中运行新增卸载回归测试，必须实际失败；随后应用补丁，运行 race tests 和 `magpie-cleanremove-e2e_test.go`。后者从本地 npm 注册表下载这个发行包，经真实 Bun 安装和宿主加载，验证模型发现、流式回复、工具交还客户端、会话标识传递及两轮复用，以及保留会话、npm 包、凭据、账号显示记录、模型缓存、注册、下载目录和哈希索引的清理。

针对所有平台的运行验证仍需要对应机器；cross build / vet 只证明编译兼容。真实 Claude Cookie 没有用于这些自动测试。
