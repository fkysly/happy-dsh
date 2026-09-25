# 把 Web UI 跑成常驻服务

[English](README.md) | 中文

关掉终端之后让 happy-dsh 继续跑、重启之后还能自己回来 —— 同时不让它启动时打印的那张凭证泄漏出去。

这个目录讲的是*进程生命周期*。想从别的设备访问 Web UI（TLS、反向代理、局域网、Tailscale），见 [`../remote-access/`](../remote-access/)。

---

## 快速开始

```sh
cd deploy/serve

./install.sh --trusted-host dsh.dev

# Or, with the recommended overlay for a browser that is not on this machine:
./install.sh --trusted-host dsh.dev --port 3080 \
             --patch "$PWD/../remote-access/overlays/remote-browser.yml"
```

脚本会装好服务、启动它、等它起来，然后把那个一次性 URL 打出来：

```
==> Waiting for the Web UI to come up

  Ready. Open this once to mint a session cookie:

      http://127.0.0.1:3080/?token=…

  Treat this URL as a password — it stays valid until the process restarts.
```

它还会以 0600 权限创建 `~/.dsh/serve.stdout` 和 `~/.dsh/serve.stderr`，并在结束前确认这个权限真的生效了。

---

## 它会往你的 profile 里装什么

`install.sh` 会在**加载服务之前**把两个插件装进 profile，所以第一次启动就已经带着它们：

| 插件 | 是什么 |
|---|---|
| `dshmarket@1.65.3` | 社区插件市场 —— 设置 → **插件市场**：浏览、搜索、一键安装、主题、更新 |
| `dsh-find-plugin@0.4.0` | 同一个目录，但入口在会话里，于是 agent 可以替你搜、替你装 |

版本是**钉死的，不是范围**：`install.sh` 写的是一个确切的组合，所以同一个 release 在两台机器上装的是同一份代码。
`pnpm run happy-dsh:preinstall bump` 把它们推到 registry 上的最新版（install.sh 和两个 README 一起改），
`deploy/release/preinstall-smoke.sh` 则把这个组合装进一个全新的 profile、换个端口真的把服务起起来。
发布流程既拒绝过期的 pin，也拒绝在 smoke 没过的情况下发布 —— 一个加载不了的插件会把整个启动带下去。

**两个都是第三方包** —— 接受这个默认值之前值得知道：它们来自 npm
（`github.com/dsh-market/dsh-market`、`github.com/awesome-dsh-plugin/dsh-find-plugin`，都是 MIT），
不来自这个仓库。它们不是构建的依赖，按自己的节奏发版，而且那个市场还能替你从
[受审核的目录](https://awesome-dsh-plugin.com)继续装别的插件。不想要这些的部署：

```sh
./install.sh --trusted-host dsh.dev --no-default-plugins

# or keep the defaults and add your own
./install.sh --trusted-host dsh.dev --plugin github:you/your-plugin
```

顺序就是「不需要第二次重启」的原因：`dsh plugin` 会把还不存在的 profile 按它自带的模板初始化，
于是一个全新的 `web` profile 在一次启动里就同时有了 `dsh-base`、`dsh-web-app` 和这两个插件。
profile 里其它东西一律不动 —— `add` 只是往它的 `package.json` 里追加。

它们是普通的 profile 依赖，所以 `./install.sh --uninstall` 会把它们原样留下，连同 `$DSH_HOME`
的其余部分。想看它们怎么参与组合 —— 它们排在 bundle 之后的最后两层：

```sh
dsh --profile web --dump-config | tail -6
```

## 两种用法

| | **`install.sh`** | **`launchd/` · `systemd/`** |
|---|---|---|
| 是什么 | 一个生成器 | 手写的参考 unit |
| 什么时候用 | 想让它跑起来 | 想自己拥有那个文件 |
| 你改的是 | 命令行参数 | unit 本身 |

两者产出的 unit 主体是一样的。`launchd/` 和 `systemd/` 里放参考文件，是因为生成出来的文件在你没去读它之前是不透明的 —— 也因为 `systemctl cat` / `launchctl print` 显示的东西跟文档对不上，是很糟的体验。

### 为什么 unit 是生成出来的，而不是发一个文件了事

因为这个服务需要*你的*绝对路径：`dsh` 可执行文件、跑它的那个 `node`、`DSH_HOME`、工作目录。任何签进仓库的文件都不可能知道这些。

这也正是它参考的那些项目之间的分界线：

| 形态 | 例子 | unit 从哪来 |
|---|---|---|
| 发行版打包、root 跑、路径固定 | gitea、syncthing、code-server 的 `.deb`/`.rpm` | **仓库里的静态文件**，`systemctl enable` 即可 |
| 用户自己装、跑在自己家目录、路径因人而异 | hermes-agent、OpenClaw、ollama 的 installer、Open WebUI 的 quadlet | **装的时候生成** |

happy-dsh 是后一种。所以它生成一份 —— 同时在旁边发一份参考 unit，这也是 OpenClaw 的做法。

---

## 自己写 `dsh` 调用：顺序很重要

如果你改参考 unit 或者自己手敲 `dsh`，参数顺序不是装饰性的。写错了你会得到一个启动后立刻死掉的服务，报 `error: unknown option '--patch'`。

`--patch` 是**启动器**标志（它在 `apps/cli/src/args.ts` 里，和 `--profile` 并列），而 `--no-open`、`--port`、`--trusted-host` 是 **app** 标志，归属于 `web` bundle。启动器先解析自己的标志，遇到第一个不认识的 token 就停下：

> 启动器的标志在前，到它不认识的第一个 token 为止；从那之后的一切都属于被启动起来的 app。

所以 `dsh web --no-open … --patch …` 会失败 —— 等 `--patch` 出现的时候，启动器早就把所有东西交给了 app，而 app 从没听说过它。

```sh
# WRONG — the launcher stopped at --no-open
dsh web --no-open --trusted-host dsh.dev --patch remote-browser.yml

# RIGHT — launcher flags first, variadic --trusted-host last
dsh web --patch remote-browser.yml --no-open --port 3080 --trusted-host dsh.dev
```

`--trusted-host` 放最后，因为它声明成了可变参数（`<authority...>`）：它会吞掉后面每一个不以短横线开头的 token。`install.sh` 会替你按这个顺序生成。

---

## 这套设计围绕的那张凭证

启动时 DSH 会打印：

```
dsh web: http://127.0.0.1:3080/?token=<opaque>
```

那个 token 能为**任意受信 authority** 铸一个会话 cookie。它不是一次性的，不会过期，也没有按 token 撤销的机制 —— 它在进程退出前一直有效。读到它的人就能驱动你的 agent。

服务 stdout 的默认归宿是 journal，那里 `systemd-journal` / `adm` 组里的人都能读。**设计这套东西的时候调研了七个服务 unit —— gitea、syncthing ×2、code-server ×2、ollama、OpenClaw —— 没有一份设了 `StandardOutput`。** 所以这是整个类别共同的缺口，不是哪个项目独有的错误。

修法是三个设置，第三个是大家会漏的那个：

```ini
StandardOutput=append:%h/.dsh/serve.stdout     # not the journal
StandardError=append:%h/.dsh/serve.stderr
UMask=0077                                      # systemd: files born 0600
```

```xml
<key>Umask</key><integer>63</integer>           <!-- launchd: 63 decimal = 0o077 -->
```

**不设 umask 的话，在干净的机器上第一次启动会把那两个文件创建成 `0644`** —— 机器上任何账号都能读，启动 token 跟着一起。手工预创建它们一直有效，直到有人删了日志再重启 —— 而那正是你最不容易注意到的时刻。

`install.sh` 既设 umask，也按 0600 预创建那两个文件。故意两个都做：umask 是让这件事成真的那个，预创建是让所在目录先变成 0700、属主先摆正，赶在 supervisor 碰它们之前。

实测过，不是假设：把两个文件都删掉再重启服务，出来的是 `0600`，不是 `0644`。

### 之后再想拿到那个 URL

```sh
grep -Eo 'https?://[^ ]*token=[^ ]*' ~/.dsh/serve.stdout | tail -1
```

**你需要它的频率会比你想象的更低。** cookie 的*签名密钥*持久化在 `$DSH_HOME/.credentials.yaml` 里，所以会话 cookie 能活过服务重启 —— 重启不会把你登出。只有在你加一台设备、或者删掉签名密钥之后，才需要一个新的 token。

这个文件每次重启只多一行 URL，所以一直很小；任何时候都可以用 `: > ~/.dsh/serve.stdout` 截断它。

因为读文件是个糟糕的接口，计划里有个 `dsh web token --show` 命令 —— 照 `openclaw gateway auth-token --show` 做的，后者刻意**拒绝被重定向或走管道**，好让凭证不会悄悄落进命令日志。还没实现，需要动核心。

---

## `PATH` 是被烤进去的，这很重要

服务跑的时候用的是你执行 `install.sh` 时生效的那个 `PATH`（或者你传的 `--path`）。这不是细枝末节 —— **agent 的每一轮都会去起真实的 shell 命令**，所以一个跑在 launchd 或 systemd 那种最小默认 `PATH` 下的服务，会找不到 homebrew 的 `git`，或者 `node`，或者 `rg`。

所以如果你把某个工具装到了新地方，重跑 `install.sh`。这是 ollama 的 installer 也有的同一个尖角，它会把跑它的那个 shell 的 `PATH` 烤成 `Environment="PATH=$PATH"`。另一条路 —— 精心维护一个列表 —— 会老得更安静，那更糟。

---

## 日常

**macOS**

```sh
launchctl print  gui/$UID/ai.happy-dsh.web     # status
launchctl kickstart -k gui/$UID/ai.happy-dsh.web   # restart
launchctl bootout gui/$UID/ai.happy-dsh.web    # stop
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.happy-dsh.web.plist   # start
```

**Linux**

```sh
systemctl --user status  happy-dsh-web
systemctl --user restart happy-dsh-web
systemctl --user stop    happy-dsh-web
journalctl --user -u happy-dsh-web -f          # unit messages, not the token
```

从 Web UI 里改的设置**不需要**重启 —— `hmr` 会自己重载 profile 配置。需要重启的插件会主动要求，然后服务把它带回来。

### 重启，包括从服务内部重启

```sh
./restart.sh              # restart
./restart.sh --park       # stop, and keep it stopped
./restart.sh --dry-run    # say what it would do
```

**常见的重启根本不需要脚本。** unit 设了 `Restart=always` / `KeepAlive=true`，所以*任何*退出之后都会重新拉起。需要重启的插件直接让进程退出即可。就是这一个设置让插件驱动的重启成为可能，也是为什么没有重启 API 要设计。

`restart.sh` 是为更难的场景存在的：**跑在服务里面的进程重启它自己的宿主。** 在这里这不是假想 —— 一个在 happy-dsh 上干活的 agent 就跑在 happy-dsh 里面，而朴素的重启会把调用者杀在半路。所以脚本一旦发现自己是在服务内部，就不直接动手：它把自己 detach 出去重新启动，等原来的调用者消失，然后才去碰服务管理器。在 Linux 上，detach 出来的子进程仍然继承 unit 的 cgroup，而 `KillMode=mixed` 够得到它，所以那里改走一个瞬时的 `systemd-run --user` unit。

在 macOS 上用一次性任务替身端到端验证过：那个 job 重启了自己，在交接后大约两秒拿到新的 pid。

### 停止，并且保持停止

因为任何退出都会回来，停止指的是让服务管理器停，而不是杀进程：

```sh
./restart.sh --park                                  # both platforms
systemctl --user stop happy-dsh-web                  # Linux, keeps running at next login
launchctl bootout gui/$UID/ai.happy-dsh.web          # macOS, same caveat
```

`--park` 是能持久的那一个：它还会*禁用*这个 job，所以下次登录或开机不会再把它带回来。单纯的停止只撑到那时候。OpenClaw 用 `gateway stop --disable` 划的是同一条线。

---

## 卸载

```sh
./install.sh --uninstall
```

停止服务并移除 unit。它不碰 `$DSH_HOME` —— 那个目录里放着你的凭证、会话，和 cookie 的签名密钥。想要干净重来的话，自己删掉：

```sh
rm -rf ~/.dsh
```

---

## 这些选择的出处

这里几乎没有什么是凭空发明的。这些形态取自已先解决同样问题的两个项目，如果你要改这个目录，两个都值得读：

- **OpenClaw** —— 它的 `src/daemon/launchd-*.ts` 是在 macOS 上监管 Node 服务的参考实现。`Umask`/`ExitTimeOut`/`ProcessType` 那套策略、`0644` 的 plist 配 `0600` 的密钥文件这个拆分、detach 式的重启交接、bootout 之后再 bootstrap 的等待，还有 `stop --disable`，都来自那里。
- **hermes-agent** —— 它的生成式 systemd unit 是退出码契约的出处：`75` 表示「重启我」，`78` 表示「配置坏了，别重启我」，接到 `RestartForceExitStatus` / `RestartPreventExitStatus` 上。我们这边还缺什么，见[已知边界](#known-limits)。

改 `install.sh` 时容易丢掉的两条规则：

1. **启动器标志在 app 标志之前。** `--patch` 属于启动器，所以它必须在 `--no-open` 前面。写错了，服务会启动后立刻死掉。
2. **unit 模板里不能有反引号。** 它们是未加引号的 heredoc，所以注释里的反引号就是命令替换 —— 这份文件更早的一个版本，因为一句注释里写了「a deliberate ``kill`` no longer…」，在每次安装时真的执行了 `kill`。渲染时把 stderr 抓下来并断言它是空的；抓到这个的就是它。

<a id="known-limits"></a>

## 已知边界

说清楚，而不是抹平。

- **macOS 是登录时启动，不是开机启动。** LaunchAgent 是每用户、每会话的作业。要在你登录之前就以你的身份启动进程，需要一个以 root 跑的 LaunchDaemon —— 对一个必须以你的身份、用你的凭证行事的 agent 来说，那是错的形态。登录一次，之后它就一直开着。
- **launchd 只限流，不会放弃。** systemd 在 `StartLimitIntervalSec` 内启动 `StartLimitBurst` 次之后就停下，把 unit 标成 `failed`。launchd 没有对应设置。实测：用一个立刻退 1 的 job，60 秒之后它仍在被重新拉起，`runs` 从 2 → 3 → 5 → 6 往上爬，`state` 还是 `spawn scheduled`。所以在 macOS 上，一个永久坏掉的配置会每分钟重试大约六次，永远如此 —— 不是洪流，但无界。`KeepAlive=true` 让这件事更重要而不是更轻，这也是为什么下面那个退出码契约才是真正的修法。
- **Linux 这条路没测过。** 真正跑过的是 macOS/launchd。systemd unit 是按同一形态写的、也照了 hermes-agent 和 OpenClaw，但没有任何 Linux 机器跑过它 —— 包括 `restart.sh` 里那个 `systemd-run` 的 detach。在有人跑之前，把它当作未验证。
- **Windows 没有覆盖。** hermes-agent 和 OpenClaw 在创建计划任务被拒时，都会退化成一个计划任务加启动文件夹登录项；如果哪天要加，那就是要照抄的形态。
- **没有 `dsh service install`。** 一个真正的顶层子命令，大约就是在 `apps/cli/src/args.ts` 里 `if (first === 'plugin')` 旁边加十五行 —— 但那是核心改动，而 `install.sh` 不靠它拿到同样的结果。CLI 会把开头不以短横线开头的 token 重写成 `--profile`，所以 `dsh service …` 否则会被读成「启动一个名叫 service 的 profile」。
- **退出码契约只实现了三分之二。** DSH 干净停止时退 `0`、失败时退 `1`，所以对 systemd 的用途来说 `Restart=always` 已经正确区分了它们。缺的是 `78` —— 「我的配置坏了，别再重启我」。没有它，再加上上面那条 launchd 的行为，macOS 上一个配置错字就变成一个缓慢的永久循环，而不是一个停下来的服务。
- **没有重启原因的汇报。** hermes-agent 会写一个 `gateway_state.json` 记录它*为什么*退出（`exit_reason: loop_liveness_watchdog`），所以被监管的重启不是匿名的。这里还没有对等物。
