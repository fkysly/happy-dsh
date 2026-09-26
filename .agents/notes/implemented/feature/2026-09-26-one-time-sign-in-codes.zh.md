# Agent Note：为无法打开启动 URL 的浏览器提供一次性登录码

Status: implemented

[English](2026-09-26-one-time-sign-in-codes.md) | 中文

## 问题

[浏览器启动令牌鉴权](../architecture/2026-08-24-browser-token-authentication.zh.md) 只允许通过 `dsh web` 打印的 `?token=` URL 登录浏览器。添加到 iPhone 主屏幕的 Web App 与 Safari 分开保存 cookie，因此在 Safari 中登录并不会让这个 App 登录；它没有地址栏，无法打开启动 URL；从其他 App 打开的链接会进入默认浏览器，而不是这个 Web App。未通过鉴权的请求只会收到一段纯文本 401，要求用户重新打开那个 URL。于是，只能用手机访问的部署根本无法使用它的主屏幕 App。

## 决定

已登录的浏览器生成一次性登录码，未登录的浏览器在取代 401 的登录页中输入它。

- `BrowserAuth.createSignInCode()` 返回 32 字节随机数的 base64url 编码 —— 与启动令牌强度相同，因此猜测无需限流 —— 10 分钟内有效、只能兑换一次。最多保留五个未使用的登录码；再生成一个会丢弃最早的那个。登录码与启动令牌一起按进程 owner 存放在内存中：Connection 重载后仍然有效，进程重启后全部失效。
- `authorizeIndex` 兑换 `GET /?code=...` 的方式与交换令牌完全相同：同样绑定 authority 的 cookie，再以 303 重定向到干净的 `./`，并带 `referrer-policy: no-referrer`。携带多个凭据的请求，或因其他原因无法登录的请求，都不会消耗有效的登录码。
- 被拒绝且 `Accept` 包含 `text/html` 的 `GET` 会收到一个自包含的登录页 —— 不含脚本与外部资源，按 `Accept-Language` 显示英文或中文 —— 其表单提交登录码。其他被拒绝的请求仍然得到纯文本 401。
- `POST /api/connection.signInCode` 生成登录码。只有要求会话时才注册该路由，它位于现有的 Host/Origin 栅栏与 cookie 校验之后。浏览器通过 `ctx.connection.createSignInCode()` 调用它，「通用设置」在「在其他设备上登录」行中展示登录码。

## 考虑过的方案

**向已登录用户展示启动令牌。** 不需要新增状态，但令牌在整个进程生命周期内有效，且可以无限次交换；展示它会把一次性的转交变成屏幕上的长期秘密。

**供人工输入的短登录码（例如六位数字）。** 在第二台设备上更容易输入，但在公开主机上需要尝试次数限制与锁定状态才能抵御猜测。主要流程是在同一台手机上的 Safari 与主屏幕 App 之间复制粘贴，长度不会带来成本。

**由新浏览器发起的设备配对**（新浏览器显示一个码，由已登录的浏览器批准）。这样不必复制秘密，但需要待处理请求的登记表、对等待页面的轮询或推送通道，以及批准界面；一次性登录码用一个端点就能达到同样的效果。

**Passkeys。** Apple 推荐 Web App 使用它，但它需要账户模型、凭据存储以及 loopback 部署所不具备的安全来源；以后仍可在同一个 cookie 之上实现。

## 后果

- 主屏幕 Web App 登录一次后，30 天的 cookie 在服务重启与部署之后仍然有效。
- `requireBrowserAuth: false` 的部署不受影响：没有路由、没有登录页，`createSignInCode()` 返回 undefined。
- 单元测试固定了登录码强度、一次性使用、过期、五个上限、不消耗登录码的拒绝、重载与重启行为，以及登录页的内容协商；`frontend-static` 中的真实 Loader 组装测试通过 HTTP 覆盖生成、登录页、兑换与重复使用。
