# hermes-dsh-distributor

通过 Hermes 向 DSH 派发任务，明确指定 **供应商、精确模型 ID、思考级别，以及 standard / PTC 执行模式**。使用 DSH 原生 Agent/LLM/Tools 接口，不靠提示词模拟模型路由，不支持的配置直接报错，不静默降级。

插件包名、Cordis 插件 ID 和健康接口名称统一为 `hermes-dsh-distributor`。这是原 `dsh-task-router-v1` 的公开源码命名；为保留接口兼容性，MCP 路径、工具名和默认数据目录保持不变。

## 功能

- `router_capabilities {}`：查询当前 DSH 实际供应商、模型、思考级别、预设和授权目录。
- `router_start {...}`：校验并创建独立任务，返回持久化的 `task_id`。
- `router_get {task_id}`：查询终态、输出、DSH 会话及实际请求头证据。
- `router_cancel {task_id}`：请求取消；`canceling` 不表示已经停止。
- `standard` 使用原生工具呈现；`ptc` 使用 DSH 原生 `run_code` 呈现，与 Agent 预设相互独立。
- 相同 `request_id` 与相同输入只执行一次；同 ID 不同输入报冲突。重启时遗留任务标记中断，绝不自动重派。

## 要求

- Node.js >= 22.13，无第三方运行时依赖。
- DSH 提供 `webServer`、`agents.create`、`agentPresets`、原生 LLM 注册表和 `tools.presentAs`。
- PTC 任务还需要 DSH 的 PTC runtime。
- Hermes 支持带 Authorization header 的 HTTP MCP 服务。

这里不是独立 HTTP 服务。插件挂载于现有 DSH Web 端口，不额外启动公网监听。

## 构建与安装

```sh
npm test
npm run check
npm pack
```

通过当前 DSH 版本的官方插件安装命令或界面，安装生成的 `hermes-dsh-distributor-0.1.2.tgz`，然后启用插件。不同宿主的 profile 和 CLI 入口不同，请使用该宿主的官方入口。

插件启动读取 `~/.dsh/integrations/hermes-task-router/config.json`：

```json
{
  "allowedRoots": ["/absolute/path/to/workspace"],
  "maxConcurrent": 2
}
```

先创建上述配置并使用真实存在的目录；默认没有授权目录，因此拒绝任务。插件自动生成同目录下的 `token`（0600），任务回执存入 `state/`。不要提交这些运行数据或供应商凭据。

## Hermes MCP 配置

通过 Hermes 官方配置接口添加独立条目，保留其他服务：

```yaml
mcp_servers:
  hermes-dsh-distributor:
    url: http://127.0.0.1:LOCAL_FORWARD_PORT/mcp/task-router/v1
    headers:
      Authorization: Bearer <PLUGIN_TOKEN>
    timeout: 180
```

`LOCAL_FORWARD_PORT` 是 Hermes 所在机器上的本地反向转发端口。建议只经 Tailscale 等可信私网使用 SSH，将该端口绑定于 `127.0.0.1`，转发至 DSH 的回环 Web 端口。不要公开该端口，也不要复制模型登录凭据；这里只传递本插件专用 token。

保存配置后，使用宿主支持的官方增量 MCP 刷新，检查实际工具清单。常驻 gateway 不一定因修改同名服务 URL 而重建连接；必要时使用新的服务 key 并增量刷新，不擅自重启 gateway。工具清单和真实调用都应验证。

健康检查：`GET /mcp/task-router/v1/health`，应返回 `ok: true`、`name: hermes-dsh-distributor` 及实际版本。它不要求 token，但仅接受回环来源；真正的 MCP 调用需要 Bearer token。

## 派活示例

先调用 `router_capabilities`，不要猜测供应商、模型或级别。用实际返回值替换占位符：

```json
{
  "request_id": "design-review-001",
  "prompt": "分析这个项目的设计问题，只给建议，不修改文件。",
  "cwd": "/absolute/path/to/workspace",
  "provider": "EXACT_PROVIDER_ID",
  "model": "EXACT_MODEL_ID",
  "reasoning_effort": "high",
  "mode": "standard",
  "agent_preset": "standard",
  "deadline_ms": 600000
}
```

保存返回的 `task_id`，使用 `router_get` 查询至终态。结果不明确时重试原请求或查询原任务，不要自动换 ID。

`reasoning_effort` 必须显式传入支持的值。不支持思考控制的模型使用能力表的 `none`，不发送 reasoningEffort；若模型原生支持名为 `none` 的级别，则真正发送该级别，不能替代为默认值。

## 状态与限制

- `accepted → running → completed / failed / canceled / timed_out / interrupted`。
- 默认并发 2，可配置 1..8；默认超时 10 分钟，请求可指定 1 秒..1 小时。
- 最多 1000 条回执；达到上限拒绝新任务。不要随意删除回执，否则会失去防重复记录。
- 输出最多 262144 字符，超出设置 `output_truncated`；实际请求证据最多 32 条。
- `resolved` 是预校验配置；`observed` 来自 DSH 实际请求头，并非供应商独立计费证明。
- 取消尽力停止工作，不撤销已经发生的外部副作用。
- 状态目录有独占 `.owner.lock`；崩溃后不自动抢锁。先确认原进程及任务已停止、备份状态，再人工处理；不要在活动实例存在时清锁。

## 从旧名称迁移

本次公开源码改名不代表已升级任意现有安装。默认数据目录和 MCP 路径保持兼容，但不要同时运行两个共享同一状态目录的插件。

1. 等待活动任务结束，备份配置和回执，正常停用旧插件。
2. 安装并启用 `hermes-dsh-distributor`，检查 health 中的实际名称和版本。
3. 若私网中继按旧 health 名称校验身份，应同步改为 `hermes-dsh-distributor`；仅保持 URL 不变不足以通过身份校验。
4. 如更换 Hermes MCP 服务 key，通过官方增量刷新并验证新工具、原回执、鉴权和私网重连。
5. 卸载旧包后检查旧路由是否消失；某些宿主或旧插件需要正常重启才能释放驻留路由。重启前确认活动任务并取得操作者许可。

## 安全边界

- cwd 白名单只是派活目录准入，**不是文件系统沙箱**。Agent 权限仍由 DSH 和所选预设决定。
- 拒绝非回环来源、浏览器 Origin、URL 查询参数鉴权及不正确的 Bearer token。
- SSH 反向转发可能映射整个 DSH Web 端口，而非本插件单一路由。独立 token 不保护宿主其他路由，远端机器必须可信。
- 不共享历史会话、记忆、模型凭据或旧插件文件队列。
- 软件安装成功或显示在线不证明已加载新代码；升级后核对 health 的实际版本。

## 验证与授权

自动化检查与验收范围见 [ACCEPTANCE.md](ACCEPTANCE.md)。本仓库不包含私人部署配置、token、真实任务回执或旧 Git 历史。

当前 `license` 保持 `UNLICENSED`。公开可见不等于授予开源许可；本次发布未擅自选择许可证。
