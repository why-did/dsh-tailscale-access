# dsh-tailscale-access

> [!IMPORTANT]
> **早期版本 —— 打开开关前，值得先花两分钟读这一段。**
>
> 本插件目前是 `0.1.x`，仍在持续测试中：有自动化测试覆盖，也在作者自己的机器上日常使用，但接口、默认值和行为仍可能在版本之间调整，也没有针对恶意网络或多用户共享主机做加固。
>
> 它做的事正如其名：为"能在本机执行命令的 GUI"开一个入口。请把这个入口当作 SSH 端口来对待 —— 只在自己的 tailnet 内使用，先读下面的安全模型，确认这个取舍是你愿意承担的。如果今天还不想承担，把开关留着不动就好，没有任何代价。
>
> 欢迎提问、报 bug，也欢迎告诉我"这里的行为出乎意料"。

一个 DeepSeek Harness（dsh）插件：在插件页打开一个开关，就能用手机或任何电脑通过浏览器访问这台机器上跑的 harness —— **不需要公网 IP、不需要端口映射、不改 dsh 的监听地址**。dsh 自始至终只监听 `127.0.0.1`。

```
手机 / 任何电脑
   │  tailscale serve（tailnet 内，端到端加密）
   │  或 cloudflared quick tunnel（公网 HTTPS）
   ▼
本地重写代理  127.0.0.1:8787
   │  Host → 127.0.0.1:3080；丢弃 Origin/Referer/Sec-Fetch-Site；
   │  注入 harness 自己的浏览器 cookie
   ▼
dsh web  127.0.0.1:3080（不知道外面有人）
```

npm 包名是 `dsh-tailscale-access`；插件的 settings section、HTTP 路由与状态文件名仍沿用 `remote-access`。

## 环境要求

- **DSH 0.1.5-rc.2（`next`）或 0.1.6-alpha.2+（`alpha`）**。卡片**同时注册进两个 slot**：0.1.6 的侧边栏「插件」页用 `plugins.item`，0.1.5-rc.2 的「设置 → 插件」页用按 namespace 作 key 的 `settings.plugin.item`；两个页面都不会渲染对方的 slot，所以只会出现一张卡。更老的版本（如 npm 上仍标 `latest` 的 `0.0.1-rc.1`）没有本插件能用的卡片 slot：此时打开开关会**明确报 `DSH_VERSION_UNSUPPORTED`**，而不是跑一个没人看得见的面板。包内已用 `engines.dsh` 声明。
- **Node >= 20**（`engines.node`）。插件自身只用 Node 内置模块。
- **`tailscale` 模式**：装好并登录 tailscale，tailnet 打开 HTTPS 证书，且有配置 `tailscale serve` 的权限（Linux 上即 tailscale operator）。
- **`quick` 模式（实验性，面板暂不提供）**：`cloudflared`。`allowDownload` 为 true 时首次使用会自动下载到 `$DSH_HOME/cache/cloudflared`，也可以用 `cloudflaredPath` 指向已有二进制。
- **`none` 模式**：不需要额外组件。

## 安装

### 用「插件」页安装（推荐）

在 DSH 0.1.6-alpha.2+ 里打开侧边栏的 **插件（Plugins）** 页，点 **添加插件**，填入包名并安装（0.1.5-rc.2 走「设置 → 插件」）：

```
dsh-tailscale-access
```

装完点 **立即启用** 即可。这一步会同时写好 profile 依赖和 `dsh.profile.bundles` 条目。

### 手动安装

把包装进 web profile（profile 位于 `~/.dsh/profiles/web`）：

```bash
cd ~/.dsh/profiles/web
pnpm add dsh-tailscale-access
```

再把包名加进 profile manifest 的 bundle 列表：

```jsonc
// ~/.dsh/profiles/web/package.json
{
  "dependencies": {
    "dsh-tailscale-access": "^0.1.0"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-tailscale-access"
      ]
    }
  }
}
```

profile 里 `"patchReload": "live"` 时改 manifest 会自动重载；否则重启 `dsh web`。在 profile 目录外也可以用 `dsh plugin --profile web add dsh-tailscale-access`，它做的是同一个 pnpm 步骤。

### 打开面板

侧边栏 → **插件** → **Remote Access**（官方分组）。它是配置页，不在「设置 → 插件」里 —— 后者是只读的插件清单。

## 三种模式

| 模式 | 入口 | 认证 | 说明 |
|---|---|---|---|
| `tailscale`（默认） | `tailscale serve --https=443` + 本地代理 | **tailnet 身份**（`Tailscale-User-Login` + 允许名单） | 域名固定 `https://<machine>.<tailnet>.ts.net`、端到端加密、第三方看不到明文；不需要口令 |
| `quick`（实验性） | cloudflared quick tunnel | **口令**（+ 可选来源白名单） | **仍在测试中，面板暂不提供** —— 想试就在设置段里写 `mode: quick`。公网 HTTPS、零安装、域名每次变；必须显式确认风险 |
| `none` | 只开 loopback 本地代理，不开隧道 | **口令** | 调试用：验证代理链路与登录流程；本身不对外发布任何东西 |

同时只允许一个模式生效；切换模式会先拆掉旧入口再建新入口。tailscale 模式的入口地址来自节点的 MagicDNS 名（`https://<machine>.<tailnet>.ts.net`）；本地代理默认端口 `8787`，dsh 默认 `3080`。

Funnel 与 tagged node 不带身份头，一律拒绝。

## 安全模型

这个插件**是故意提供 dsh 自己拒绝提供的外网入口**：上游不允许绑定网络接口，harness 始终只监听 loopback。入口默认关闭，请按需开启 —— 入口对面是一个能执行任意命令的 GUI。

- **身份优先。** `tailscale` 模式下唯一凭据是 `Tailscale-User-Login`，且只在请求来自 loopback（tailscaled 代理）且启用代理头时才被采信。客户端伪造的 `Tailscale-User-*` 一律忽略；缺身份头的请求返回 `403` 并计入 `denied`。
- **允许名单 fail-closed。** `allowedUsers` 为空时**默认只允许你自己**（启用时从 `tailscale status --json` 的 `Self.UserID` + `User` 映射解析 login）；解析不出来就**拒绝启用**。不允许"空 = 放行所有人"。
- **口令模式。** `quick` 与 `none` 都要求口令（至少 8 位），`quick` 还要求 `acknowledgeRisk: true`。会话是 HMAC 签名的 cookie（`HttpOnly`、`SameSite=Lax`、HTTPS 时 `Secure`），有效期由 `sessionHours` 控制（默认 72 小时）。登录失败按 IP 限速：5 分钟内 8 次失败封禁 15 分钟。`quick` 还可以用 `allowedCidrs` 按隧道传来的 `CF-Connecting-IP` 限制来源。
- **只绑 loopback。** 本地代理只监听 `127.0.0.1`，dsh 始终只监听 `127.0.0.1:3080`；不需要 `--trusted-host`，浏览器全程不接触 harness token。
- **代理层做什么。** 把 `Host` 改写为 `127.0.0.1:<dsh 端口>`，丢弃 `Origin`/`Referer`/`Sec-Fetch-Site`，用服务端换来的 harness 浏览器 cookie 替换 `Cookie`（上游 401 时自动重换一次），响应方向剥掉 `Set-Cookie` 与逐跳头，HTTP 与 WebSocket 升级都转发，客户端地址由代理自己解析。`tailscale` 模式下通过白名单校验的身份头会转发给上游；`none`/`quick` 模式下一律剥离。
- **代理层不信什么。** 客户端自带的 `CF-Connecting-IP`、`X-Forwarded-*`、`Forwarded`、`True-Client-IP` 一律丢弃后重建（只在隧道模式且请求来自 loopback 时才采信）；伪造的 `Tailscale-User-*` 一律忽略；`tailscale` 模式下本地会话 cookie 永远不作为身份。
- **关闭即收口：** `tailscale serve reset`、关代理、清会话，不留监听。
- **能进这个 GUI 的人 = 能批准 = 能授权命令执行。** 所以 `allowedUsers` 白名单 / 口令就是"谁有权批准"的边界。

## 配置

Remote Access 卡片是本插件唯一的 UI，没有单独的设置表单，也没有 CLI。卡片每 1.5 秒轮询 `GET /remote-access/status.json`，状态、入口 URL 与客户端列表无需刷新页面即可更新。

| 字段 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `enabled` | boolean | `false` | 总开关。为 true 时**每次 harness 启动自动恢复**这个入口（不是操作系统开机自启）。 |
| `mode` | `tailscale` \| `quick` \| `none` | `tailscale` | 入口方式。 |
| `port` | number | `8787` | 本地代理端口。 |
| `sessionHours` | number | `72` | 口令模式的会话有效期。 |
| `allowedUsers` | string[] | `[]` | `tailscale` 身份白名单；空 = 只允许本节点自己的 login。 |
| `allowedCidrs` | string[] | `[]` | `quick` / `none` 的来源地址白名单。 |
| `cloudflaredPath` | string | `""` | 指定 cloudflared 二进制；空则先搜 `PATH`，再搜缓存目录。 |
| `allowDownload` | boolean | `true` | 允许 `quick` 模式首次使用时自动下载 cloudflared。仅 settings section。 |
| `acknowledgeRisk` | boolean | `false` | `quick` 模式必须为 true 才允许启用。 |
| `audit` | boolean | `true` | 写审计日志（登录成功/失败、被拒、被踢）。 |
| `statusPage` | boolean | `true` | 提供只读状态页。 |
| `password` | string（secret） | — | `quick` / `none` 必需，至少 8 位。仅 settings section。 |
| `bind` | string | `""` | 高级项：覆盖本地代理监听地址。留空即 loopback；其它取值会扩大监听面、失去 loopback 保证。仅 settings section。 |

`password`、`allowDownload`、`bind` 在卡片里没有控件，需要直接改 settings section。

总开关与模式下拉**立即写入**；文本、数字、列表字段**暂存 + Save**（空值 = 回默认值）。卡片会标注用户层是否覆盖了默认值，并显示运行阶段（已停止 / 启动中 / 运行中 / 失败）；前置检查失败时直接显示可复制的修复命令。

口令要写进插件的 settings section。卡片里没有口令输入框，也不会读回口令；状态接口只报告是否已设置（`passwordSet`）：

```yaml
# ~/.dsh/settings.yaml
remote-access:
  mode: quick
  password: "<至少 8 位，建议 20+ 随机>"
  acknowledgeRisk: true
```

卡片还会显示机器名、tailnet 名、tailscale 版本与 `BackendState`，已连接客户端列表（身份或 IP、首次连接、最后活跃、WebSocket 数、请求数）以及每行的**踢掉**，并保留一份有界的最近事件。**重启隧道** 不重启 harness 即可重建入口。关闭开关立即生效，不留监听。

## 远端页面：DSH 的设置限制

DSH 把"页面是否拥有 Host"绑定在页面 authority 上（`isLoopback` = `localhost` / `[::1]` / `127.0.0.0/8`）。在**非 loopback 页面**上设置镜像跑在 `memory` 模式：不读设置文档，写入被丢弃且静默成功。所以手机经 tailscale / cloudflared 访问时，DSH 自身的语言、主题、各设置页都会显示默认值、改动不生效（这是 DSH 的既有设计，不是本插件的转发问题 —— 转发层已逐项验证：主页注入逐字节相同、SSE/WS/POST 均正常、零失败请求）。

本插件因此**自带配置读写接口**，这些 host 路由由代理从 loopback 转发，所以在远端页面上同样可用：

- **读**：`GET /remote-access/status.json` 的 `config`（host 的有效配置，**永不含口令**，只有 `passwordSet` 布尔；另给 `configOverridden` 表示是否偏离默认）。
- **写**：`POST /remote-access/action` 的 `{action:"set",patch}` / `{action:"unset",fields}` / `{action:"reset"}`。校验失败返回 **400 + code**，不是 500。

settings section 仍是唯一真源，接口只是另一个写入口。结果：**Remote Access 卡片在手机上和在本机一样可用**（显示真实状态、能真正改配置、刷新不丢）。DSH 其它设置页仍受上面的限制。

### 远端页面的「读取宿主设置」按钮

非 loopback 页面上，卡片会显示 **远端页面：读取宿主设置** 一节（本机页面上隐藏 —— 本机页面本来就有设置文档）。点 **读取宿主设置并应用** 会请求 `GET /remote-access/host-settings.json`（宿主设置文档，敏感值已脱敏），把宿主的语言、外观与字号应用到当前页面。文档里的其它设置只报告、不应用 —— 那些偏好属于各自的插件。读取失败会显示原因。

## 远端审批（重要）

需要审批的操作（例如写工作区外的文件）**可以在手机上批准**：审批走的是同一条被代理的通道（host 侧 `approval/request` waterfall → 浏览器侧 `ui-approval` 的 remote event），待审批状态是会话状态，任何跟随该会话的客户端都能看到面板。三条必须知道的规则：

- **至少要有客户端在线**：没有任何 answerer 时请求 **fail-closed（直接拒绝）**，不会排队等你回来。本机浏览器开着也算。
- **谁先答谁生效**：本机与手机会同时看到同一个请求，晚答被丢弃；请求被 turn 取消后晚答同样作废。
- **手机被挂起/断连就不会等你**：要保活（页面留在前台）。`tailscale` 模式是 HTTPS（secure context），浏览器能力完整；本版本没有明文回退。

推论：**能进这个 GUI 的人 = 能批准 = 能授权命令执行**。所以 `allowedUsers` 白名单 / 口令就是"谁有权批准"的边界。

## 排错

### 卡片提示 "not operator"

Linux 上默认只有 root 能改 `tailscale serve` 配置。把当前用户设为 tailscale operator 即可（一次即可，之后无需 sudo）。卡片会显示确切命令：

```bash
sudo tailscale set --operator=$USER
```

### tailnet 没开 HTTPS 证书

`tailscale` 模式始终发布 HTTPS 443，**没有明文 `tailscale serve --tcp` 回退**：明文 HTTP 页面不是 secure browser context，DSH 客户端插件里调用 `crypto.randomUUID()` 的地方会直接坏掉。去 Tailscale admin console → **DNS → HTTPS Certificates** 打开，等证书签发后重新打开开关。实在开不了就用 `quick` 模式（cloudflared 自带 HTTPS）。卡片会显示失败原因，提示里指明 admin console 的设置项，并给出可复制的 `tailscale serve --bg --https=443 http://127.0.0.1:<port>` 命令。

### tailscale 未安装 / 未运行 / 未登录

```bash
curl -fsSL https://tailscale.com/install.sh | sh   # Linux
brew install tailscale                             # macOS
winget install --exact --id Tailscale.Tailscale    # Windows

sudo systemctl enable --now tailscaled             # 守护进程没跑（Linux）
brew services start tailscale                      # 守护进程没跑（macOS，Homebrew）
open -a Tailscale                                  # 守护进程没跑（macOS，应用包）
Start-Service Tailscale                            # 守护进程没跑（Windows）
sudo tailscale up                                  # 没登录
tailscale status                                   # 确认节点状态
tailscale ip -4                                    # 节点的 tailnet 地址
```

tailscale 给出登录链接时，卡片显示的提示里会带上该 URL。卡片能区分"未安装 / 未运行 / 未登录 / 不是 operator"，前置条件不满足时拒绝启用。每种失败都会带上一句人话结论和一条可复制命令。

### cloudflared 找不到或下载失败

`allowDownload` 为 true 时，`quick` 模式会把 cloudflared 下载到 `$DSH_HOME/cache/cloudflared`。下载失败（无网络、没有对应平台的构建、代理问题）时，自己装一个 cloudflared，并把 `cloudflaredPath` 指向它。

### 本地端口被占用

配置的 `port` 报 `EADDRINUSE`。在卡片里换一个 `port`，或停掉占用者：

```bash
ss -ltn | grep 8787
```

### 有残留规则 / 启用后没有发布

上一次运行可能留下 serve 规则。清掉再启用：

```bash
tailscale serve status
tailscale serve reset
```

### 收集诊断信息

```bash
curl -s http://127.0.0.1:8787/remote-access/status.json | head -c 2000
tailscale serve status
cat ~/.dsh/remote-access.json
tail -40 ~/.dsh/remote-access-audit.log
ss -ltn | grep -E '3080|8787'
```

dsh 控制台里 `remote-access:` 开头的日志行有完整错误。只读状态页 `/remote-access/status` 在手机上经隧道也能打开。

## 文件与接口

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/remote-access.json` | 运行状态快照（`enabled`、`mode`、`url`、`port`、客户端数、`denied`、`lastError`、`updatedAt`）。 |
| `$DSH_HOME/remote-access-audit.log` | 审计日志（JSON 行，权限 `0600`，超过 5 MB 轮转为 `.1`），`audit` 为 true 时写入。 |
| `$DSH_HOME/cache/cloudflared/` | `quick` 模式自动下载的 cloudflared 二进制。 |
| `$DSH_HOME/settings.yaml` 里的 settings section `remote-access` | 配置，唯一真源。 |

所有 host 路由都要求 loopback 来源，所以即使 dsh 将来绑得更宽也不会泄漏到网络；代理从 loopback 转发，因此远端页面能用到它们。

| 路由 | 用途 |
|---|---|
| `GET /remote-access/status.json` | 状态 + 不含口令的有效 `config`。 |
| `POST /remote-access/action` | `kick`、`restart`、`set`、`unset`、`reset`。需要 `content-type: application/json` 与 `x-remote-access-action: 1` 头，随机网页无法驱动它（CSRF）。 |
| `GET /remote-access/status` | 只读状态页（`statusPage: true`）。 |
| `GET /remote-access/host-settings.json` | 宿主设置文档（已脱敏），供远端页面按钮使用。 |

动作请求体：

```json
{"action": "kick", "id": "<clients[].id>"}
{"action": "restart"}
{"action": "set", "patch": {"port": 9000}}
{"action": "unset", "fields": ["port"]}
{"action": "reset"}
```

## 已知限制

- 本插件提供的是 dsh 自己拒绝提供的外网入口，默认关闭，请有意开启。
- `quick` 模式的 URL 公网可解析、每次启动都变，扫描器会发现它；唯一防线是口令（外加可选 CIDR），**不建议长期开着 quick**。固定域名的 named tunnel + Cloudflare Access 未实现。
- 口令在 settings 文档里是明文存储，对外只报告 `passwordSet` 布尔值；只存 salt + scrypt 哈希未实现。
- `none` / `quick` 模式下口令在 loopback 这一段是明文 HTTP；对外一段是 HTTPS（tailscale / cloudflared）。
- 远端页面上 DSH 自身的设置页仍显示默认值；只有语言、外观与字号能通过上面的按钮应用。
- Tailscale Funnel 与 tagged node 不带身份头，一律拒绝。
- 没有账号体系或权限分级：白名单/口令是单一闸门，过了闸门的人就能通过 GUI 执行命令。
- 远端审批要求至少有一个客户端在线，且先答先得；手机被挂起就不会再回答。
- dsh 自身的安全说明依然适用：harness 未做安全审计，沙箱/审批不保证隔离。

## 开发与测试

```bash
npm install            # 只依赖 @deepseek-ai/schemastery
npm test               # node --test tests/
node --test tests/routes.test.mjs
```

167 个自动化测试，全部用 `node:test`，使用假上游/假二进制；需要网络的用例用 `DSH_TEST_NETWORK` 守卫。

| 测试文件 | 覆盖 |
|---|---|
| `tests/config.test.mjs` | 配置归一化、绑定解析、口令要求、错误结构 |
| `tests/routes.test.mjs` | host 路由：loopback 守卫、CSRF 头、动作、状态页、host-settings 路由 |
| `tests/proxy.test.mjs` | 转发层：头改写、cookie 注入、WS、限速、身份规则 |
| `tests/tailscale.test.mjs` | tailscale 状态机与 serve 编排 |
| `tests/cloudflared.test.mjs`、`tests/supervisor.test.mjs` | 隧道进程、退避、原子写状态 |
| `tests/orchestration.test.mjs`、`tests/integration.test.mjs` | 生命周期、模式切换、对假上游的端到端接线 |
| `tests/client-bundle.test.mjs` | 客户端卡片 bundle 形状与行为 |

仓库里另有 `ACCEPTANCE.zh.md`（人工验收清单）。

### 验证状态

- 卡片已在真实 DSH 0.1.6-alpha.2 上用无头浏览器验证：能注册进 `plugins.item`、能打开完整页面、轮询状态接口且无控制台报错。
- 尚未在真实 GUI 中跑过：写入路径（开关/下拉 + Save 往返）、踢人、切换语言、窄屏/手机布局。
- `tailscale serve` 实机链路尚未在装好 tailscale 的机器上端到端跑过；状态机由假二进制的单元测试覆盖。
- 经隧道的远端审批目前是文档所述行为，尚未端到端验证。

## 许可证

MIT，见 [LICENSE](LICENSE)。
