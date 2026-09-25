# 版本与发布

[English](README.md) | 中文

happy-dsh 怎么给自己编版本号、改动怎么进 `master`、以及一个版本被发布时会发生什么。
这是 fork 自己的流程 —— dsh 那套发布机制还在树里，也还在 `master` 上跑，但它命名的是
dsh 的版本，不是我们的。

---

## 这里的「版本」指什么

happy-dsh 身上有**两个版本号**，它们回答的是不同的问题。

| | **dsh 基座** | **happy-dsh 版本** |
|---|---|---|
| 存放位置 | 根 `package.json`，并被复制进每个包的 manifest | [`happy-dsh.version`](../../happy-dsh.version) 里的一行 |
| 对外体现 | `dsh --version` | 界面：侧边栏、设置 → 通用、设置 → 账户 |
| 含义 | 这棵树是基于哪个 dsh 构建的 | 这是 fork 的哪个发行版 |
| 谁来 bump | 上游，用 `pnpm run release:dsh` | 你，用 `pnpm run happy-dsh:version` |

这个拆分不是为了好看。**插件声明的 peer 范围是对着 dsh 基座的** —— 一个要求
`^0.1.7` 的插件要的是 API，不是我们的发行版号。所以 `dsh --version` 继续报基座版本，
而用来标识「这次构建」的那个版本，是嵌在客户端里的这一个。

只有两种形态，其余一律拒绝：

```sh
0.1.0-dev.3   # a development version; `dev` increments the counter
0.1.0         # a release version; only this shape may be tagged
```

```sh
pnpm run happy-dsh:version show      # version, base, and the tag it would publish
pnpm run happy-dsh:version check     # validate the file; the gates run this too
pnpm run happy-dsh:version dev       # 0.1.0-dev.3 -> 0.1.0-dev.4
pnpm run happy-dsh:version release   # 0.1.0-dev.3 -> 0.1.0
pnpm run happy-dsh:version set 0.2.0-dev.1
```

**不要跑 `pnpm run release:dsh`。** 它会把根 manifest 和全部 312 个包的 manifest
一次改写成同一个上游版本，整个家族一个提交。把 fork 的版本写在那里，就等于在此后
这个仓库的一生里，每次上游发版都要冲突一次 —— 这正是 fork 版本单独放一个文件的原因。
`release:dsh` 留着，是为了将来这棵树真要跟一次上游版本号的那一天。

---

## 日常：PR 车道

`master` 开了保护：改动必须走 PR，而且要过九个必需检查才能合并。你可以自己批准自己的
PR —— 批准数故意设成 0，因为这里只有一个人 —— 所以这九个检查就是评审。

```sh
git checkout -b fix/whatever master
# ... work ...
pnpm run check:ci:static     # the fast gate, before you pay for a push
git commit -am '...'
git push -u origin fix/whatever
gh pr create --fill          # then watch the checks
gh pr merge --squash --delete-branch
```

九个检查在 PR 上和 push 上完全一样，全跑在 GitHub 托管 runner 上：

| 检查 | 证明什么 |
|---|---|
| `static gates` | 约束、文档、lint，以及版本文件 |
| `unit tests with coverage` | 全量单测，且满足覆盖率阈值 |
| `snapshot gates` | 录下的工具调用快照能原样重放 |
| `build, artifact, typecheck and lint gates` | 真实构建、产物、以及契约类型检查 |
| `windows gates under wine` | 真实的 win-x64 Node，跑在 Wine 上 |
| `web browser snapshots` | 构建后的客户端，跑在真实浏览器里 |
| `node 22.19 compatibility` | 支持的 Node 下限 |
| `node 24.9 compatibility` | 被钉住的 24 线 |
| `node 26 compatibility` | 下一个大版本 |

**一个 PR 要按「将近一小时」预期。** 时长几乎全在覆盖率那条车道上，而这就是「闸是真的、
不是抽样子集」的代价。合并**不要求**分支已跟上 `master`：多跑一轮要再花一小时，而且
捡不到第一次检查本就能捡到的东西。

上游还有八个 workflow 也会在 `pull_request` 上触发。它们在这个 fork 上**已关闭**，
因为在这里没有一个能成功：[`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
会永远排队在 DeepSeek 私有的 runner 标签上，预览构建找不到它那四个 Cloudflare 密钥，
两个 issue 机器人和那对评审权重机器人管的是一种这里并不存在的协作方式。文件原样留在树里，
只是开关关掉了：

```sh
gh workflow list --all                                   # disabled ones are marked
gh api -X PUT "repos/fkysly/happy-dsh/actions/workflows/<id>/enable"    # turn one back on
```

`Release (dsh)` 和 `Release (vendor)` 是**故意留着**的：它们每次 push 到 `master` 都跑，
是绿的，而且它们合起来是这棵树「还能不能打包」的唯一证据 —— 这正是你刚合完一次上游同步
最想知道的事。`Sandbox` 也留着，它是唯一在三平台都验沙箱的车道。

---

## 发一个版本

四步，按顺序。

```sh
pnpm run happy-dsh:version release          # 0.1.0-dev.4 -> 0.1.0
git commit -am 'release: happy-dsh 0.1.0'
git push origin master                      # via a pull request, like anything else
git tag happy-dsh-v0.1.0 && git push origin happy-dsh-v0.1.0
```

推 tag 就是发布动作。tag 一落地，发布 workflow 就构建那个提交并创建 GitHub Release。

然后把下一条开发线打开，免得你下一件构建出来的东西还悄悄叫 `0.1.0`：

```sh
pnpm run happy-dsh:version dev              # 0.1.0 -> 0.1.1-dev.1
```

想先看不发布的完整彩排 —— 它会校验、构建、把 notes 写出来，然后停下：

```sh
gh workflow run happy-dsh-release.yml -f dry-run=true
```

---

## tag 落地时 CI 做什么

[`happy-dsh-release.yml`](../../.github/workflows/happy-dsh-release.yml) 在
`happy-dsh-v*` tag 上运行。它有四种拒绝方式，每一种都对应一条真能把错东西发出去的路：

1. **tag 与版本文件不一致。** 在 `happy-dsh.version` 写着 `0.1.0` 的提交上打
   `happy-dsh-v0.2.0`，直接失败。文件是源，tag 只能给它命名。
2. **tag 指着一个开发版。** `-dev.N` 永远不会被当成发行版发出去。先跑 `release`，
   然后给那个提交打 tag。
3. **提交不在 `master` 上。** 一次祖先判定，所以边分支上的、或根本没推上去的提交打不了 tag。
4. **那个提交在 `master` 上的九个闸没有全绿。** 这条是真正管用的那条。workflow 要的是
   **push 到 `master`** 的那次闸运行（直接按分支去查运行记录，而不是读该提交的 check runs ——
   后者根本说不出某次运行属于哪个分支），并要求其中一次把九个名字（与分支保护要求的同一批）
   全都报成成功。只在特性分支上绿过的提交，会被拒绝。

运行记录只保留 90 天，所以对更老的提交重新发版没法用这个办法证明。`allow-ungated` 是
那种情况下的可审计的越权开关；它从不是默认值，用的时候日志里会很显眼。

Release 本身带三样东西：构建好的 Web 客户端（`apps/web/dist`）打成的 tarball、说明
这个产物出自哪个提交与哪些公开取值的构建记录，以及由上一枚 `happy-dsh-v*` tag 以来的
已合并 PR 生成的 notes。

---

## Release 不是什么

**它不是可直接运行的发行包。** 部署仍然是从一个 checkout 出发：`git pull`、
`pnpm run build`、重启服务 —— 见 [`deploy/serve/`](../serve/)。Release 给你的是
「某个版本的一份可识别、可复现的产物」，不是「一个拿来装的东西」。

这是一个刻意的断点，不是疏忽。单文件可执行这条路上游已经解决了 ——
`build-exe-for-python-sdk.yml` 就在构建它 —— 复用它就是下一步。在那之前，这里的一个
Release 是一个带了证据的标记。

---

## 已知边界

- **没有任何东西会在 tag 上重跑那些闸。** 发布信任的是那个提交在 `master` 上的那轮运行，
  而那是同一个提交，所以这是省了一次而不是漏了一块 —— 但它确实意味着「只在 tag 上失败」
  的闸不会被发现。
- **必需检查的名字写了两遍**：一遍在分支保护里（那是仓库设置，不是一个文件），一遍在发布
  workflow 里。改一个 job 的名字要同时改两处，否则发布会在一个全绿的提交上拒绝工作。
- **版本文件只有一行，所以两个同时打开的、都 bump 了它的 PR 必然冲突。** 一个人干活时这不是
  问题；多一个贡献者就需要一条「谁负责 bump」的规矩。
- **`pnpm run happy-dsh:version` 没有做成 `dsh` 的子命令。** 它是一个仓库脚本，只存在于
  checkout 里。
- **什么都不发布到包仓库。** npm 和 PyPI 的 scope 属于上游；这个 fork 两边都不推。

---

改任一种语言就要同时改另一种：`README.i18n.yaml` 记录着两侧的 blob 哈希，两侧一漂移，
配对闸就会失败。重新记录：

```sh
pnpm run verify-translation-pairing --write deploy/release/README.md
```
