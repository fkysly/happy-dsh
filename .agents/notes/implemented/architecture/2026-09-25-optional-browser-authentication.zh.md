# Agent Note: Optional browser authentication

Status: implemented

[English](2026-09-25-optional-browser-authentication.md) | 中文

## Problem

从第二台设备访问 Web UI 要先付出一个进程级启动 token：43 个字符、每个进程只打印一次、下一次重启即失效，要在另一台设备上复现只能靠复制 URL。token 兑换出的签名 cookie 能活过重启，所以这份代价落回在每一台还没有 cookie 的设备上 —— 手机浏览器、平板、新的浏览器配置 —— 而且恰好落在它的主人想看一眼正在跑的会话的那一刻。这个 token 是针对**完整的、可执行工具的 Host API** 的 bearer 凭据，因此也不能随便写到哪个顺手的地方。

促成这项工作的部署，从家里的局域网（自有 DNS）和一条 tailnet 两条路径到达 Web Host，而每一个能到达它的客户端都属于操作者本人。对这样一个可达集合而言，token 兑换并不构成身份认证：网络已经决定了谁可以到达，token 只决定操作者自己的哪一个浏览器可以先说话。

## Decision

`@deepseek-ai/dsh-client-connection` 新增配置字段 `requireBrowserAuth`，默认 `true`。把它设为 `false` 的部署，会直接提供 UI，并接纳每一个通过 Host/Origin 栅栏的请求：

- `BrowserAuth.admits(request)` 不读取 cookie 即返回 `true`，因此 `HostConnectionService.requestRejection` 只会再返回栅栏的 `403`。
- `authorizeIndex` 直接提供索引请求，于是 URL 上残留的 `?token=` 被忽略，而不是被拒绝。
- `authenticatedUrl` 原样返回 URL，于是启动输出和 `dsh web` 打印的那一行不再携带需要当作敏感信息对待的 token。

Host/Origin 栅栏刻意保持不变。`isTrustedApiRequest` 仍然对 `trustedHosts` 之外的 authority 或跨站标记返回 `403`，所以被配置的 authority 依旧**正是**那个可达集合；一个放弃会话要求的部署，就在它已经声明 `trustedHosts` 的地方声明这一点。

由于默认值仍是 `true`，这个 fork 与上游的差异只有一个经过校验的配置字段和 `BrowserAuth` 里的一个分支。省略该字段的部署行为与从前完全一致，包括 token 兑换、cookie 和 `401`。

## Alternatives considered

**彻底移除浏览器会话机制，让所有部署都无认证开放。** 需求是不要在一张可信网络上继续支付登录代价，而不是让这个包在任何使用场景下都变成无身份；编译期移除同时会堵死用户系统、删掉上游测试所固定的行为，并把未来每一次上游同步都变成安全 seam 里的冲突。

**保留 token，但持久化它或接受 `Authorization` 头。** 一个持久的启动 token 就是第二份长期凭据 —— 这正是[浏览器 token 认证这项记录](2026-08-24-browser-token-authentication.zh.md)否决它的理由 —— 而且它仍然得靠手工带到每台设备上，而那正是要消除的代价。

**只通过 `cookieMaxAgeDays` 延长 cookie 寿命。** 这能消除「已经登录过一次的设备」的复现代价，在可达集合不可信时也正是应当做的改动，但它让每台新设备的首次登录依旧别扭，而那才是被报告出来的摩擦。

**等一个未来的用户系统来解决。** 用户系统回答的是身份与归属，本项改动并不试图涉及；它也无法由一个配置字段交付。在它出现之前，一个部署必须在「手工携带 token」和「网络即身份」之间做选择，而这个字段就是那个选择。

**只服务 tailnet，让 Tailscale ACL 去决定。** 一个更窄的可达集合与本字段相容，且值得一并去做，但它无法服务那些客户端经由普通局域网到达主机的部署 —— 那里没有任何 ACL 层可以依赖。

## Consequences

把 `requireBrowserAuth` 设为 `false` 的部署，会把**完整的、可执行工具的 Host API** —— 也就是该进程自身所拥有的同一份权限 —— 交给栅栏接纳的每一个客户端；而一个能到达某个 authority 的客户端，可以忽略它不信任的证书，所以证书信任并不构成补偿性控制。栅栏把这个集合收窄到被声明的那些 authority；它不在这集合内部做认证。当流量由 tailnet 承载时，Tailscale ACL 成为实际的访问控制；否则由家庭局域网自身的隔离来承担。

这项取舍的代价留在出厂的默认值里而不是藏在暗处：省略该字段的操作者保留认证，包 README 的 Known Limitations 写明关掉它放弃了什么，`deploy/remote-access/README.md` 则说明每份配方各自造出多大的可达集合。测试把两个方向都固定住 —— 默认模式对可信 authority 上的未认证请求仍然回答 `401`，而放弃模式接纳它的同时，对不可信 authority 依旧以 `403` 拒绝。
