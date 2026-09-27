# Agent Note: Remove browser authentication

Status: implemented

[English](2026-09-27-remove-browser-authentication.md) | 中文

## 问题

这个 fork 只服务操作者自己的客户端。[浏览器启动令牌鉴权](2026-08-24-browser-token-authentication.zh.md) 引入签名会话 cookie，用来拦下一个本来就能到达 Host 的浏览器；[一次性登录码](../feature/2026-09-26-one-time-sign-in-codes.zh.md) 则是为了让主屏幕 Web App 也能进得来。随后[可选的浏览器鉴权](2026-09-25-optional-browser-authentication.zh.md) 通过 `requireBrowserAuth` 把这项要求变成可配置，但默认仍然开着，因此每个部署照旧支付同一笔代价：一个要在设备之间搬运、每次重启都重新签发的 43 字符令牌，以及每个新浏览器都要走一次的登录。实际部署自始至终都开着这项要求。

## 决策

浏览器鉴权在这个 fork 里被删除，而不是被默认关闭。被删除的内容包括：进程启动令牌、签名会话 cookie、登录页、一次性登录码及其 `POST /api/connection.signInCode` 路由、`requireBrowserAuth` 与 `cookieMaxAgeDays` 两个配置字段、`BrowserAuth`、`ctx.connection.authenticatedUrl(...)` 与 `ctx.connection.createSignInCode()`、`credentials` 服务注入，以及 `deploy/remote-access/overlays/no-browser-auth.yml`。

`packages/client/connection/src/api-request-trust.ts` 里的 Host/Origin 栅栏是唯一的关卡，它不建立任何身份。Loopback 加上被配置的 `trustedHosts` 就是完整的可达性策略：`ConnectionRequestRejection` 是 `403 | undefined`，通过栅栏的请求以操作者 Peer 的身份被接纳，调用方提供的任何凭据都改变不了这个结果。

索引（`GET /`）同样通过这道栅栏。索引携带启动时注入的数据 —— 插件名册与修订号、偏好设置、设置账户配置 —— 因此一个本部署未声明的 authority 现在会收到 403，而从前保护它的只有会话 cookie。`authorizeIndex` 是在栅栏上重新实现，而不是被删掉；对一个未被接纳的 Host 而言它还比 cookie 更严格：部署从未声明过的 Host 根本读不到索引。

`dsh web` 打印 `dsh web: http://127.0.0.1:<port>/`，不带令牌。`remoteWrites` 的推导保持不变（`config.remoteWrites ?? trustedHosts.length > 0`）。`$DSH_HOME/.credentials.yaml` 不再保存 `client-connection/browser-session` 记录，仍然保存 provider 的凭据引用。

## 栅栏仍然做什么

栅栏在三种情况下拒绝请求：`Host` 既不是回环地址也不是被配置的 `trustedHosts` authority；请求带有 `Sec-Fetch-Site: cross-site`；或者附带的 `Origin` 与该请求的 authority 不完全相同。另有一条媒体类型规则，在解析之前对未声明 `application/json` 的 `/api` POST 以 415 拒绝。两者合起来是 DNS rebinding 与跨站防御，而不是访问控制系统。

任何能到达某个已声明 authority 的客户端，都以本进程自身的权限驱动可执行工具的会话，因此 TLS 或 tailnet ACL 才是实际的访问控制。栅栏决定可达性；它从不决定调用者是谁。

## 考虑过的替代方案

**把默认值翻成 `false`，保留这道 seam。** 这正是[可选的浏览器鉴权](2026-09-25-optional-browser-authentication.zh.md) 所记录的做法。它保留配置字段、保留代码，也保留本 fork 与上游的差异，为的只是一项这里没有任何部署在用的能力，而实际部署从未走过这条路径。

**保留一份长期 bearer 凭据，例如 `Authorization` 头。** 它面对的是同一个「谁在调用」的问题，多出一份要维护、要携带的凭据，而且需要自己的一套轮换方案。

**为主屏幕场景保留一次性登录码。** 既然已经没有会话可签发，就没有浏览器需要登录，这些登录码也就没有事情可做了。

**连同其余部分一起删掉 `authorizeIndex`。** 在栅栏上重新实现它是更窄的选择：索引携带启动时注入的数据，删掉这项检查会相对它所取代的 cookie 扩大暴露面。

## 后果

删除带走了浏览器侧的全部凭据：没有令牌要在设备之间搬运，没有登录步骤，没有 cookie，凭据存储里没有签名密钥，Host 里也没有会话状态。`dsh web` 打印的是一个不带令牌的就绪 URL，因此安装脚本与冒烟检查只需读一种形式，而不必从 URL 里解析出令牌。

没有任何东西建立身份。通过栅栏的客户端就是操作者，而栅栏不是访问控制。本 fork 与上游的差异也随之扩大：上游仍然维护这道 seam，因此 `rpc.ts`、`rpc-host.ts`、Connection 的 README 以及部署配方在每次合并时都会冲突。

一个与它不控制的客户端共享 authority 的部署，需要重新引入鉴权。那是一个新决策，要由一篇新的 Agent Note 开始，而不是把这段代码恢复回来。

## 测试

- 代码树中不存在 `BrowserAuth` 模块，也不存在 `SIGN_IN_CODE_PATH`。
- `packages/client/connection/tests/node-half.host.spec.ts` 固定了这一点：通过栅栏的请求在无会话的情况下被接纳，而不可信的 authority 仍然以 403 拒绝。
- `packages/host/frontend-static/tests/frontend-static.spec.ts` 双向固定了索引的栅栏：通过栅栏的 `GET /` 返回 200，而本部署不服务的 Host 返回 403。
- `deploy/remote-access/verify-ladder.sh` 针对运行中的部署走完整道栅栏：三种拒绝、一个通过栅栏却在无会话下被接纳的请求，以及索引的两个方向。
- `deploy/release/preinstall-smoke.sh` 把光秃秃的 `dsh web:` URL 行当作就绪信号。
