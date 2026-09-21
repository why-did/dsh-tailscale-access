# 验收清单（14 项）

> 这张表是给你（人类）在真机上跑的。每条的"期望"都来自 SPEC，跑完把"结果"列填上，失败的行把证据贴给我。

## 准备

```bash
# 1) 装进 web profile：在仓库根目录执行（或用已发布的包名）
dsh plugin --profile web add "$PWD"          # 本地源码
# dsh plugin --profile web add dsh-tailscale-access   # npm 上的版本

# 2) 把 dsh-tailscale-access 追加到 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles
#    （alpha.2 用「插件」页面安装会自动加）

# 3) 容器里装 tailscale（如果还没装）
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
tailscale ip -4
# 并在 admin console → DNS 里打开 HTTPS Certificates

# 4) 重启 dsh web，打开 设置 → 插件 → Remote Access
```

## 逐条验收

| # | 步骤 | 期望 | 结果 |
|---|---|---|---|
| 1 | 未装 tailscale 时打开开关 | 面板显示"未安装" + 可复制安装命令；开关**拒绝启用** | |
| 2 | 装了但 `tailscaled` 没跑 | 面板显示"未运行" + `systemctl` 命令 | |
| 3 | 未登录（`tailscale up` 之前） | 面板显示登录指引/URL | |
| 4 | tailnet 未开 HTTPS 证书时启用 | **明确报错**并提示去 admin console 开证书（或改用 quick）；**不**退回明文 `--tcp` | |
| 5 | 正常 tailscale 模式：手机打开 `https://<Self.DNSName>` | **直接进入 GUI**，不需要 token、不需要 `--trusted-host`；侧边栏、会话、流式输出正常 | |
| 6 | `allowedUsers` 填一个不存在的 login | 该身份被拒；面板 `denied` 计数增长，逐条来源可在 `~/.dsh/remote-access-audit.log` 查到 | |
| 7 | 面板打开时改配置/开关 | 1–2s 内反映状态变化（停止/启动中/运行中/失败） | |
| 8 | 手机连上后看客户端列表 | 显示身份（`Tailscale-User-Login`）、登录时间、最后活跃、WS 数；点"踢掉"后该客户端下次请求失败 | |
| 9 | 关闭开关 | `tailscale serve status` 为空、`ss -ltn` 无 8787 监听、无残留 cloudflared 进程 | |
| 10 | `enabled: true` 后重启 harness | 入口自动恢复，URL 播报正确 | |
| 11 | `mode: quick`（需先手写 `password` + `acknowledgeRisk: true`） | 手机经公网 URL 访问成功；未开 `acknowledgeRisk` 时**拒绝启用** | |
| 12 | 全程 `ss -ltn \| grep 3080` | dsh 自身**始终只监听 127.0.0.1** | |
| 13 | **手机端审批**：手机发起/触发一次需要审批的操作（例如写工作区外的文件） | 手机弹出审批面板 → 批准后操作成功；拒绝则被拒且会话有记录 | |
| 14 | **审批 fail-closed**：关掉手机页面后发起同类操作 | 被**拒绝**，且回合**不会挂住**不返回 | |

## 出问题时请给我这些

```bash
curl -s http://127.0.0.1:8787/remote-access/status.json | head -c 2000   # 状态快照
tailscale serve status                                                  # serve 规则
cat ~/.dsh/remote-access.json                                           # 状态文件
tail -40 ~/.dsh/remote-access-audit.log                                 # 审计（谁连过/被拒）
ss -ltn | grep -E '3080|8787'                                           # 监听面
```

以及 dsh 控制台里 `remote-access:` 开头的日志行。
