# Releases and version numbers

English | [中文](README.zh.md)

How happy-dsh versions itself, how a change reaches `master`, and what happens
when a version is published. This is the fork's own process — dsh's release
machinery is still in the tree and still runs on `master`, but it names dsh's
versions, not ours.

---

## What a version means here

happy-dsh carries **two version numbers**, and they answer different questions.

| | **dsh base** | **happy-dsh version** |
|---|---|---|
| Where it lives | root `package.json`, copied into every package manifest | one line in [`happy-dsh.version`](../../happy-dsh.version) |
| Reported by | `dsh --version` | the Web UI: sidebar, Settings → General, Settings → Account |
| Means | which dsh this tree is built from | which release of the fork this is |
| Who bumps it | upstream, with `pnpm run release:dsh` | you, with `pnpm run happy-dsh:version` |

The split is not decoration. **Plugins declare peer ranges against the dsh
base** — a plugin that requires `^0.1.7` is asking for an API, not for our
release. So `dsh --version` keeps reporting the base, and the version that
identifies *this* build is the one embedded in the client.

Only two shapes exist, and the tool refuses everything else:

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

**Do not run `pnpm run release:dsh`.** It rewrites the root manifest and all
312 package manifests to one upstream version — the whole family, in one
commit. A fork version written there would collide with every upstream release
bump for the rest of this repository's life, which is exactly why the fork
version lives in a file of its own. `release:dsh` remains for the day this
tree has to follow an upstream version bump.

---

## Day to day: the pull request lane

`master` is protected: changes arrive through a pull request, and nine required
checks have to pass before it can be merged. You can approve your own pull
request — the approval count is zero on purpose, because there is one person
here — so the checks are the review.

```sh
git checkout -b fix/whatever master
# ... work ...
pnpm run check:ci:static     # the fast gate, before you pay for a push
git commit -am '...'
git push -u origin fix/whatever
gh pr create --fill          # then watch the checks
gh pr merge --squash --delete-branch
```

Every one of the nine checks runs on a pull request exactly as it runs on a
push, on GitHub-hosted runners:

| check | what it proves |
|---|---|
| `static gates` | constraints, docs, lint, and the version file |
| `unit tests with coverage` | the whole unit suite under the coverage thresholds |
| `snapshot gates` | recorded tool-call snapshots replay unchanged |
| `build, artifact, typecheck and lint gates` | a real build, its artifacts, and the contract typecheck |
| `windows gates under wine` | a real win-x64 Node, under Wine |
| `web browser snapshots` | the built client, in a real browser |
| `node 22.19 compatibility` | the supported Node floor |
| `node 24.9 compatibility` | the pinned 24 line |
| `node 26 compatibility` | the next major |

**A pull request is expected to take the better part of an hour.** The
coverage lane dominates it, and that is the price of the gate being real
rather than a subset. Merging is not gated on the branch being up to date with
`master`: an unnecessary re-run costs another hour and catches nothing the
checks could not catch in the first place.

Eight upstream workflows also fire on `pull_request`. They are **disabled on
this fork**, because none of them can succeed here: [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
queues forever on DeepSeek's private runner labels, the preview build cannot
find its four Cloudflare secrets, and the two issue bots plus the
review-weighting pair police a repository that does not run that way. The files
stay in the tree, untouched — only the switch is off:

```sh
gh workflow list --all                                   # disabled ones are marked
gh api -X PUT "repos/fkysly/happy-dsh/actions/workflows/<id>/enable"    # turn one back on
```

`Release (dsh)` and `Release (vendor)` are **left enabled** on purpose: they run
on every push to `master`, they are green, and between them they are the only
proof that the tree still packages — which is what you want to know right after
merging an upstream sync. `Sandbox` stays enabled too; it is the only lane that
exercises the sandbox on all three platforms.

---

## Before you cut: refresh what a new deployment preinstalls

`install.sh` preinstalls two third-party plugins at exact versions, so those
pins are part of what a release promises — and they move on somebody else's
release schedule, where nothing in this repository notices. Refresh them first,
and prove the new pair rather than assuming it:

```sh
pnpm run happy-dsh:preinstall check          # what moved, if anything
pnpm run happy-dsh:preinstall bump           # take the registry's latest, in install.sh and both READMEs
bash deploy/release/preinstall-smoke.sh      # install the pair into a scratch profile, and boot it
```

```
  ✓ installed and booted: dshmarket@1.65.3 dsh-find-plugin@0.4.0
```

The smoke is the part that matters. `check` compares version numbers, and a
version number cannot tell a pin that installs from one that takes the service
down: DSH's boot is all-or-nothing, so one plugin that fails to load ends the
process. The smoke does what a fresh deployment does — a profile that does not
exist yet, the pins from the registry, a real boot on a scratch port — and the
release workflow refuses the tag until it passes. Commit the bump with the
smoke's output.

---

## Cutting a release

With the pins current, four steps, in this order.

```sh
pnpm run happy-dsh:version release          # 0.1.0-dev.4 -> 0.1.0
git commit -am 'release: happy-dsh 0.1.0'
git push origin master                      # via a pull request, like anything else
```

Once that commit is on `master` and its gates are green, rehearse the publish
without making one. This validates, builds, writes the notes, and stops before
creating anything — and it is refused while the version file still says
`-dev.N`, because it rehearses a release commit rather than a development line:

```sh
gh workflow run happy-dsh-release.yml -f dry-run=true
```

Then the tag is what publishes. The moment it lands, the release workflow
builds that commit and creates the GitHub Release:

```sh
git tag happy-dsh-v0.1.0 && git push origin happy-dsh-v0.1.0
```

And last, open the next development line, so the next thing you build is not
silently still called `0.1.0`:

```sh
pnpm run happy-dsh:version dev              # 0.1.0 -> 0.1.1-dev.1
```

---

## What CI does when the tag lands

[`happy-dsh-release.yml`](../../.github/workflows/happy-dsh-release.yml) runs on
`happy-dsh-v*` tags. It refuses to publish in six ways, each of which is a real
way to ship the wrong thing:

1. **The tag disagrees with the version file.** `happy-dsh-v0.2.0` on a commit
   whose `happy-dsh.version` says `0.1.0` fails. The file is the source; the tag
   has to name it.
2. **The tag names a development version.** `-dev.N` never gets published as a
   release. Run `release` first, and tag *that* commit.
3. **The commit is not on `master`.** An ancestor test, so a tag on a side
   branch or an unpushed commit cannot publish.
4. **The gates did not all pass on `master` for that commit.** This is the one
   that matters. The workflow asks for the gate workflow's *push* runs for that
   commit on `master` — not for the commit's check runs, which say nothing about
   which branch a run belonged to — and requires one of them to report all nine
   names branch protection requires. A tag on a commit that only ever passed on
   a feature branch is refused.
5. **A preinstalled plugin pin is stale.** `install.sh` ships exact versions of
   two third-party plugins, and the registry has moved past one of them. The
   check names the pin and prints the one command that fixes it:
   `pnpm run happy-dsh:preinstall bump`.
6. **The pinned pair does not install or boot.** The smoke runs the pins through
   a scratch profile and a real boot. Version numbers cannot see this one: DSH's
   boot is all-or-nothing, so a plugin that fails to load ends the process, and
   the release would be shipping a default that cannot start.

Workflow runs are kept for 90 days, so re-releasing an older commit cannot be
proven this way. `allow-ungated` is the audited override for that case; it is
never the default, and it is loud in the log when used.

The release itself carries the built Web client (`apps/web/dist`) as a tarball,
the build record that names the exact commit and public values that produced
it, and notes built from the merged pull requests since the previous
`happy-dsh-v*` tag.

---

## What a release is not

**It is not a runnable distribution.** Deployments run from a checkout:
`git pull`, `pnpm run build`, restart the service — see
[`deploy/serve/`](../serve/). What the release gives you is an identifiable,
reproducible artifact for a version, not a thing to install.

That is a deliberate stopping point rather than an oversight. A single-file
executable is already solved upstream — `build-exe-for-python-sdk.yml` builds
one — and reusing that route is the obvious next step. Until then, a release
here is a marker with evidence attached.

---

## Known limits

- **Nothing re-runs the gates on the tag.** The release trusts the `master` run
  for that commit, which is the same commit, so this is a saving rather than a
  gap — but it does mean a gate that only fails on tags would go unnoticed.
- **The required check names are written down twice**: in branch protection
  (a repository setting, not a file) and in the release workflow. Renaming a
  job means updating both, or the release refuses to publish a green commit.
- **The version file is a single line, so two open pull requests that both bump
  it will conflict.** With one person that is a non-issue; it would not survive
  a second contributor without a rule about who bumps it.
- **`pnpm run happy-dsh:version` is not installed as a `dsh` subcommand.** It is
  a repository script, so it only exists in a checkout.
- **Nothing publishes to a package registry.** npm and PyPI scopes belong to
  upstream; this fork does not push to either.

---

Editing either language means editing both: `README.i18n.yaml` records the
blob hash of each side, and the pairing gate fails when they drift. Re-record
with:

```sh
pnpm run verify-translation-pairing --write deploy/release/README.md
```
