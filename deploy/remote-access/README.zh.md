# 远程访问

[English](README.md) | 中文

怎样从另一台设备 —— 手机、笔记本、VPS —— 访问 DSH 的 Web UI，而前面挡着的是一道 Host/Origin 信任栅栏，不是登录。

DSH 已经自带这道栅栏。它**没有**自带的是一个受支持的网络部署形态：CLI 拒绝 `--host 0.0.0.0`，默认绑定是 `127.0.0.1`，也没有 TLS 终结。这个目录用配置、以及在必要处用一个小补丁把这段缺口补上 —— 见[已知缺口以及谁来补上它们](#known-gaps-and-what-closes-them)。

**选配方之前先读[威胁模型](#threat-model)。** 简短版：栅栏决定的是*可达性*，**不建立任何身份**。任何能到达某个已声明 authority 的客户端都会被服务，用的是跑这个进程的账号的全部权限，所以访问控制是 TLS —— 或者 tailnet 的 ACL，或者你自己拥有的网络边界 —— 而不是 DSH。

---

## 选一个配方

| | **A — TLS 反向代理** | **B — 信任局域网** | **C — Tailscale** |
|---|---|---|---|
| 能从哪访问 | 互联网，经由你自己跑的反代 | 只有你的局域网 / VPN | 只有你的 tailnet |
| 入站端口 | 443（用 DNS-01 的话可以不开） | 无 | 无 |
| 第三方依赖 | 一个域名 + 一个反代 | 无 | Tailscale 账号，每台设备都要装客户端 |
| 传输 | HTTPS | 明文 | WireGuard（Tailscale） |
| 传输是否加密 | ✅ 由 TLS | ❌ 局域网上是明文 | ✅ 由 WireGuard |
| 需要的核心改动 | 无 | 无 | 无 |
| 什么时候用 | 你想让它从任何地方都能用，而且用对 | 网络完全可信，你接受上面的一切都会被服务 | 你已经在跑 Tailscale，而且每台客户端都在上面 |

**推荐 A。** 它是唯一对任意用户都让传输受到保护的配方，如果你要把这个发布给别人，这一点很重要。B 是有意的降级 —— 栅栏会接纳任何能到达那个局域网地址的人，所以只在你掌控网络上每一台设备时才用它。如果你生活里本来就有 Tailscale，C 非常好。

---

## 配方 A —— TLS 反向代理

同一台机器上的反代终结 TLS，转发到 loopback 上的 DSH 后端。后端端口从不暴露。

```sh
dsh web --no-open --trusted-host dsh.example.com
```

整个机制就是这样。`--trusted-host` 命名你的浏览器将要使用的 authority，而它是唯一决定可达性的东西：`/api` 和 index 走的是同一道 Host 栅栏。`--no-open` 很重要，因为控制台前没有别人能点浏览器窗口。

然后起一个反代：

- **Caddy** —— 对公网可达的主机用 [`caddy/Caddyfile`](caddy/Caddyfile)；对一个仍然想拿到公网可信证书的私有主机用 [`caddy/Caddyfile.dns01-cloudflare`](caddy/Caddyfile.dns01-cloudflare)。
- **nginx** —— [`nginx/dsh.conf`](nginx/dsh.conf)。

如果你更愿意把 authority 列表放进版本控制而不是留在 shell 历史里，用文件形态：[`overlays/behind-proxy.yml`](overlays/behind-proxy.yml)。标志和文件是叠加的 —— 文件保留那个组合表达式并拼接自己的字面量，所以两个都传不会悄悄丢掉任何一个。

**同时应用 [`overlays/remote-browser.yml`](overlays/remote-browser.yml)。** 配方 A 让后端留在 loopback 上，这也就意味着宿主被当成控制台前坐着人 —— 于是有两个能力会作用在*宿主的*桌面上，而不是浏览器里。见[主机桌面侧的能力](#host-desktop-affordances)。

```sh
dsh web --no-open --trusted-host dsh.example.com \
        --patch /abs/path/behind-proxy.yml \
        --patch /abs/path/remote-browser.yml
```

<a id="host-desktop-affordances"></a>

### 主机桌面侧的能力

有两个能力是针对跑服务的那台机器解析的。浏览器就在那台机器上时这是对的，不在时就是错的：

| 能力 | 不加 overlay 会怎样 |
|---|---|
| **目录选择器** | 只要绑定是 loopback、进程不是经 SSH 启动、平台是 macOS 或 Windows，自适应选择器就会挑 `native` 后端 —— 最后一个条件是*假设*的，不是探测出来的。一个 OS 对话框会**在宿主屏幕上**弹出来，远程浏览器永远答不上它。 |
| **「打开方式…」** | 这个按钮会**在宿主上**拉起文件管理器或编辑器。 |

`overlays/remote-browser.yml` 把选择器钉到 `browse` 后端 —— 后者通过 Remote API 提供列目录和创建，所以选择器渲染在浏览器里 —— 并砍掉「打开方式…」的两半。

这是配置改动，不是核心改动。bundle 自己的头注释就邀请你这么做：

> 在启动时把绑定宿主、SSH 启动和显示环境各解析一次，然后挂载匹配的双面目录选择器。**在 overlay 里直接挂 `-native` 或 `-browse` 来把交互钉死。**

**配方 B 不需要这个 overlay** —— 非 loopback 的绑定自己就会把选择器解析成 `browse`。那是*管制更松*的配方反而更方便的唯一一处。

### 写 overlay 时的两个陷阱

这两个都静默或费解地失败，而且开发期间都咬过这个仓库自己的文件。

**1. 补丁替换整行的 `config`，不做合并。** 那一行拥有的每个键都要重述一遍。最常见的受害者是 `webserver.port`：漏掉它，那一行就冻在 schema 默认值上，悄悄废掉 `--port`。

**2. 绝不要用一个裸字面量替换组合出来的 `trustedHosts`。** 写成

```yaml
trustedHosts: ['dsh.example.com']      # WRONG
```

会丢掉 bundle 放在那里的表达式，于是每一个 `--trusted-host` 值都消失了，部署会以 403 拒绝那个 authority。保留表达式并做拼接。

**3. `!!js` 吃的是标量，不是流式序列。** `!!js [a, b]` 会让这个标签作用在一个序列节点上，overlay 解析失败：

```
YAMLException: unknown tag !<tag:yaml.org,2002:js>
```

改成把整个表达式引起来：

```yaml
trustedHosts: !!js "[...ctx.webStartup.trustedHosts, 'dsh.example.com']"
```

### 唯一一件会把它弄坏的事

**反代必须转发浏览器原始的 `Host`。** Caddy 和 Traefik 默认就这么做；nginx 需要 `proxy_set_header Host $host;`。

一个把 `Host` 改写成上游的反代，会让每个请求都以 **403** 挂在栅栏上 —— 响亮地失败，这是好结果。真正要留意的故障形态是 GUI 加载出来、然后永远重连：那是反代丢掉了 `/api/remote.mux` 的 WebSocket 升级。

---

## 配方 B —— 绑定局域网，信任局域网

```sh
dsh web --patch overlays/lan-all-interfaces.yml --no-open
```

它会绑定所有网卡，并为每个非内部 IPv4 地址派生一个受信 authority，所以局域网客户端不用再配置什么就能用。

> ⚠️ **明文，而且没有身份。** 这条路上什么都不加密，也没有任何东西在核验来者是谁：只要请求的 `Host` 是派生出来的某个局域网 authority，栅栏就放行，不再多看。任何能到达那个地址的人都能发出这样的请求，而这个进程会以当前用户的身份执行命令。只在你端到端掌控的网络上用它。

两个值得知道的行为：

- 应用这个 overlay 期间 **`--host` 变成惰性的**。补丁移除了读它的那个表达式。`--port` 仍然有效。
- **在多宿主机的机器上，派生出来的信任集合包含每一张网卡** —— 一台 VPS 会拿到它的公网地址。想收窄就显式重述 `connection.trustedHosts`；overlay 文件里给了形态。

---

## 配方 C —— Tailscale Serve

如果每台客户端都已经在你的 tailnet 上，Tailscale 给你一张真证书和一条加密传输，不用跑反代：

```sh
tailscale serve --bg https / http://127.0.0.1:3080
dsh web --no-open --trusted-host <machine>.<tailnet>.ts.net
```

要求和坑：

- tailnet 必须启用 HTTPS 证书（管理控制台 → DNS）。在那之前，靠 `tailscale cert` 的 serve 会失败；`tailscale status --json` 报 `CertDomains: null`。
- Tailscale Serve 转发到 loopback，所以 DSH 保持默认绑定 —— 不用 `--host`，不用 overlay。
- 证书是给 `*.ts.net` 那个名字的，所以那个名字就是你传给 `--trusted-host` 的 authority；而且这个名字在 Certificate Transparency 日志里是公开的（它不是什么秘密）。
- Tailscale Serve 也是转发到 loopback，所以**要应用 `remote-browser.yml`**，理由和配方 A 需要它一样。

---

## 配方 C2 —— 经由 mihomo/Clash 出站的 Tailscale

有些环境根本不跑 Tailscale 客户端：mihomo（Clash.Meta，比如 Clash Verge 后面那个）有 `tailscale` 出站类型，机器经由代理加入 tailnet。其余一切不变 —— Caddy 照旧终结 TLS，DSH 照旧绑定 loopback —— 但有两个对普通代理来说不可见的 mihomo 设置必须处理，而两者失败起来都像是 happy-dsh 坏了。

把它当清单用，别当配方：每一步都对着你自己的配置验证。

**1. 一条域名规则，因为嗅探器会按名字重新路由。** 开了 `sniffer.enable: true` 和 `override-destination: true` 之后，443 上的 TLS ClientHello 会被读出 SNI，规则会**按域名再匹配一次**。那条本来把连接正确路由进来的 `IP-CIDR` 规则不再被参考。于是一个没有域名规则的私有名字会落到兜底规则上、被送到最后一个代理节点 —— 而 22 端口上的 SSH 因为没有被嗅探的明文，一直好好的。这种不对称（ssh 通、https 死）就是它的签名。

```yaml
rules:            # or your rules profile's `prepend:`
  - DOMAIN-SUFFIX,dsh.dev,<tailscale-group>   # your tailscale outbound's group
```

**2. 一条 hosts 记录，因为 fake-ip 不是一个地址。** tailscale 出站必须连到一个真实 IP。在 `enhanced-mode: fake-ip` 下，mihomo 自己的 DNS 会拿 `198.18.x.x` 回答这个名字，而出站拨不通它 —— 所以按域名路由仍然失败，只是更晚。因为浏览器是以 `CONNECT dsh.dev:443` 到达代理的（一个**主机名**，不是 IP），这个解析必须发生在 mihomo 那一侧；客户端上的 hosts 文件帮不上忙。

```yaml
hosts:
  dsh.dev: <tailnet-ip>       # the tailnet IP, not the LAN IP: no subnet
                              # route advertisement required
dns:
  use-hosts: true             # do not rely on the default
```

**3. 确认这个出站没被指望会回退。** 一个被交予 tailnet 之外目的地的 tailscale 出站会直接失败，而不是走直连，所以上面两条规则必须是匹配上的那两条。

最后从客户端验证，除了系统代理什么都不用：

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://dsh.dev/    # expect 200
curl -s -o /dev/null -w '%{http_code}\n' http://dsh.dev/     # expect 308 -> https
```

这里 200 就是成功：栅栏接受了这个 authority 并把 index 服务出去了，全程没有任何凭证参与。`000` 意味着连接根本没到。

### 同一套设置在 iOS 上，客户端是 Shadowrocket

Shadowrocket 自带 Tailscale 出站，所以手机或平板以同样的方式加入 tailnet，也会撞上同样那三个问题。它有一条桌面客户端没有的约束：iOS 只允许一条隧道处于活动状态，代理客户端与 Tailscale App 无法同时连接 —— 这正是 tailnet 必须由代理客户端承载的原因。

C2 把 `rules:` 和 `hosts:` 写进配置文件，iOS 则写进**模块**（配置 → 模块），后者优先级高于当前配置文件，且不会被订阅更新覆盖：

```
[Host]
dsh.dev = <tailnet-ip>

[General]
use-local-host-item-for-proxy = true

[Rule]
DOMAIN-SUFFIX,dsh.dev,DIRECT
```

- `dsh.dev = <tailnet-ip>` 把这个名字映射到该地址并跳过 DNS。它与 `dsh.dev = server:<tailnet-ip>` **不是**同一条语句，后者是请那个地址去解析这个名字。两者只差一个 `server:` 前缀，而带前缀的那种写法在这里什么也不做。
- `use-local-host-item-for-proxy = true` 是必需的。少了它，代理类目的地会在远端节点上解析，映射被忽略。
- `DOMAIN-SUFFIX,…,DIRECT` 同样必需，而且是最容易漏掉的那一半。只有 host 映射时，一个 tailnet 目的地仍然会落到兜底规则上、被交给一个到不了它的代理节点：页面一直加载，而隧道上**一个包都没有**。`DIRECT` 让连接从设备本身发出，那里通往 tailnet 的路由本来就是通的。

然后全局路由要设为配置，并切换客户端的主开关让隧道重建：模块贡献的是规则，而全局的代理与直连模式根本不跑规则，所以在那两种模式下它无法生效。这些齐了之后，在隧道上抓包会看到 ClientHello 到达，且**零 DNS 查询** —— 因为映射是本地的，什么也没有被解析。

还有一步是每台设备各自的事，不属于模块。

**分两步信任 CA。** iOS 会把 `.crt` 作为描述文件导入（设置 → 通用 → VPN与设备管理），并且**不会**顺手信任它，必须另行开启信任（设置 → 通用 → 关于本机 → 证书信任设置）。只导入不开启，恰好就是让 Safari 报出「不是私密链接」的那个状态，看起来像证书不对。iCloud 云盘只负责分发文件，不负责授予信任。

**除此之外没有什么是每台设备各自的。** 栅栏不建立任何身份，所以没有秘密需要拷到手机上：能到达那个已声明 authority 的设备，只要信任了 CA 就会被服务。被拒绝就是 `Host` 上的一记 **403**，它自己说得清楚，不会被误会成凭证错误 —— 这里根本没有凭证。如果请求压根没到，就抓 loopback 那一段，那里的请求行和状态行是明文：

```sh
sudo tcpdump -i lo0 -n -A 'tcp port 3080'
```

上面的映射写的是 tailnet 地址，所以只在隧道在线时成立。同一个设备在客户端断开时会经由网关解析，根本不需要模块 —— 只需要 CA。一个从不离开局域网的设备应该索性跳过模块，因为映射到一个 tailnet 地址会让这个名字在那里失败，而不是照旧通行。

上面那条 `http://dsh.dev/` 检查成立，是因为 `curl` 不理会 HSTS 预加载列表。浏览器会理会，而 `.dev` 就在那张表上，所以浏览器永远无法验证明文这一跳：请求还没离开设备就被升级了。

---

<a id="threat-model"></a>

## 威胁模型

**栅栏是什么。** 每一个请求 —— `/api` 这一面和 `GET /` 上的 index 一样 —— 都必须带一个 loopback 或显式受信的 `Host`，不带 `Sec-Fetch-Site: cross-site` 标记，且 `Origin` 要么缺失、要么恰好等于请求自己的 authority。其余一律以 **403** 拒绝。index 走的是同一道栅栏，因为它带着启动时注入的数据：插件清单与版本、偏好设置、settings-account 配置。

**栅栏决定可达性，不建立任何身份。** 它是针对 DNS rebinding 和跨站请求的混淆代理防御，不是认证。这里没有会话、没有 cookie、也没有登录：通过栅栏的请求就会被服务，用的是跑这个进程的账号的全部权限。往 `trustedHosts` 里加一个 authority 本身不授予任何权限；它只是让栅栏不再拒绝那个 `Host`，而正是这一点让部署在那个地址上可达。

**所以访问控制是传输，不是 DSH。** 在你掌控的地方终结的 TLS、tailnet 的 ACL，或者一个你真的拥有的局域网边界。这就是诚实的后果，而且它是无条件的 —— 不是部署自己选择开启的东西：任何能到达某个已声明 authority 的客户端都会以当前用户的身份执行命令。不信任你证书的客户端可以无视它，所以证书本身决定不了什么。

**明文在这里是更糟，不是更好。** 配方 B 既不加密也不认身份，所以暴露的是整条通道，而不是通道里的某一个秘密：路径上的任何人都能读到被服务出去的内容，也能发出会被同样接纳的请求。去掉登录让这个面变大，不是变小。

**其它真实性质：**

- `trustedHosts` 的条目在加载时会被校验。每一条都必须是规范形式的裸 `host` 或 `host:port` authority，不满足的会在启动时大声失败，而不是悄悄放宽或收窄授权。
- 不带端口的条目匹配该主机名的任意端口；带显式端口的条目只匹配那一个 authority。
- 没有身份，也就没有登出、没有按客户端的吊销。撤回可达性的方式是把这个 authority 从 `trustedHosts` 里删掉并重启。

**启动那一行只是一个 URL。** 启动时 DSH 打印

```
dsh web: http://127.0.0.1:3080/
dsh web: http://127.0.0.1:3080/ (LAN: http://192.168.1.20:3080)
```

机器上存在局域网地址时就会出现第二种形态。两行都不带秘密：决定谁能用那些 URL 的是栅栏，不是 URL 本身。配方 B 通过公布局域网形态扩大了*可达*面，除此之外什么也没扩大。

**这个目录不防的是：**被攻陷的客户端设备、被攻陷的宿主，或者能读宿主凭证库的人。它也不加限流或锁定 —— 需要的话把这些放在反代上。

---

## 验证

不要把「服务器起来了」当作证据。走一遍阶梯 —— [`verify-ladder.sh`](verify-ladder.sh) 会把下面每一步都对着一个在跑的服务跑一遍，第一处不符就以非零退出。后端在 loopback 上时，你可以用 `curl` 把整道栅栏驱动一遍，因为它读的就是你在这里能控制的那几个头：

```sh
B=http://127.0.0.1:3080
AUTH=dsh.example.com

# 1. an untrusted Host — the DNS-rebinding fence
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'Host: evil.example' -H 'Origin: http://evil.example' \
  -H 'Content-Type: application/json' -d '{}' "$B/api/probe"
#   expect 403

# 2. a cross-site marker — refused whatever the Host and Origin say
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Host: $AUTH" -H "Origin: http://$AUTH" -H 'Sec-Fetch-Site: cross-site' \
  -H 'Content-Type: application/json' -d '{}' "$B/api/probe"
#   expect 403

# 3. an Origin that is not this authority
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Host: $AUTH" -H 'Origin: http://evil.example' \
  -H 'Content-Type: application/json' -d '{}' "$B/api/probe"
#   expect 403

# 4. the declared authority — admitted with no session of any kind
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H "Host: $AUTH" -H "Origin: http://$AUTH" \
  -H 'Content-Type: application/json' -d '{}' "$B/api/probe"
#   expect 404: /api/probe is not a real RPC method, and an admitted request is
#   exactly what answers "no such method". A 401 or 403 here would mean refused.

# 5. the index passes the same fence
curl -s -o /dev/null -w '%{http_code}\n' -H "Host: $AUTH" "$B/"
#   expect 200
curl -s -o /dev/null -w '%{http_code}\n' -H 'Host: evil.example' "$B/"
#   expect 403
```

WebSocket 承载同一个判定。被拒绝的升级会在 socket 关闭之前回一行原始 HTTP 状态行：

```sh
# expect 403 with no trust, 101 with the declared authority
node -e '
const http=require("node:http");
const host=process.argv[1];
const req=http.request({host:"127.0.0.1",port:Number(process.argv[2]||3080),path:"/api/remote.mux",
  headers:{Host:host,Connection:"Upgrade",Upgrade:"websocket",
    "Sec-WebSocket-Version":"13","Sec-WebSocket-Key":"dGhlIHNhbXBsZSBub25jZQ==",
    Origin:"http://"+host}});
req.on("upgrade",()=>{console.log(101);req.destroy()});
req.on("response",r=>{console.log(r.statusCode);req.destroy()});
req.on("error",e=>{console.log("ERR:"+e.code);});
req.end();' dsh.example.com 3080
```

最后，用真实浏览器经过真实反代走一遍：加载应用、发一条消息、打开设置。**在 curl 里读到 200 不等于 UI 能用。**

---

<a id="known-gaps-and-what-closes-them"></a>

## 已知缺口以及谁来补上它们

这些是当前状态诚实的局限。修掉它们就是这个 fork 的意义；每一条都被追踪着，而不是被藏着。

| 缺口 | 影响 | 状态 |
|---|---|---|
| **栅栏就是全部策略** | 任何能到达某个已声明 authority 的客户端都会以当前用户的身份执行命令；访问控制是传输 | 设计如此 —— 见[威胁模型](#threat-model) |
| **`DSH_WEB_URL` 写的是 loopback** | 在反代部署下，模型和每个 shell 工具都被告知 GUI 在 `http://127.0.0.1:<port>` —— 对你的浏览器是假的，对 agent 没用 | 计划：`web-runtime.config.externalUrl` |
| **不能绑定特定 IP** | listen-host 的 schema 只接受 `127.0.0.1` 和 `0.0.0.0`，所以你没法只绑一张网卡 —— 配方 C 的绑定会需要它 | 计划：放宽 schema |
| **字面量绑定会让一切 403** | 相关 bug：信任快照只在绑定恰好是 `0.0.0.0` 时才派生 authority，所以绑一个 IP 等于什么都不信任 | 计划：同一个改动 |
| **配方 B 下 `--host` 是惰性的** | 这个标志静默地什么都不做 | 已在上文记录 |
| **没有按客户端的吊销** | 撤回可达性意味着改 `trustedHosts` 再重启；没有身份可供吊销 | 设计如此 |
| **转发头被忽略** | 改写 `Host` 的反代会 403；修法是反代里的一行，但一个感知转发头的模式没有实现 | 刻意推迟 —— 正确的实现必须以声明过的可信对端为条件，绝不盲目信任 `X-Forwarded-*` |

### 关于 `--host 0.0.0.0` 的说明

上游刻意拒绝它，并在消息里点明理由：全网卡绑定会把远程代码执行暴露到网络上。栅栏不是这件事的答案，因为它决定可达性、不建立任何身份 —— 在一个全网卡绑定上，它拒绝的只是攻击者可以随意设置的 `Host` 值。配方 B 仍然带着这份暴露，这就是为什么那条拒绝没有被干脆删掉 —— 摩擦属于最钝的那个选项，而不是每个选项。

---

## 速查

| 任务 | 命令 |
|---|---|
| 为反代提供服务 | `dsh web --no-open --trusted-host <authority>` |
| 在局域网上提供服务 | `dsh web --patch overlays/lan-all-interfaces.yml --no-open` |
| 再加一个 authority | 重复 `--trusted-host`，或者在 overlay 里列出来 |
| 看组合后的配置 | `dsh --profile web --dump-config` |
| 诊断什么都 403 | 反代改写了 `Host`，或者这个 authority 没有被声明 |
| 诊断桌面端正常、iOS 却永远加载不出来 | 模块里的 host 映射或 `DIRECT` 规则缺失 —— 隧道里一个包都没走（配方 C2） |
| 诊断 GUI 卡在重连 | 反代没有转发 WebSocket 升级 |
