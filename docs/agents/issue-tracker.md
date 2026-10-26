# Issue tracker: GitHub

本仓库的 issue 与 spec 都放在 GitHub Issues 里（`was35/dsh-reclaim`）。所有操作走 `gh` CLI。

## 约定

- **建 issue**：`gh issue create --title "..." --body "..."`；正文多行用 heredoc。
- **读 issue**：`gh issue view <number> --comments`，用 `jq` 筛评论，同时取回 labels。
- **列 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合 `--label` 与 `--state` 过滤。
- **评论**：`gh issue comment <number> --body "..."`
- **打标签 / 摘标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库从 `git remote -v` 推断；在克隆目录里执行 `gh` 会自动识别，无需重复指定。

## 本仓库已有的标签

技能要用的标签已全部建好，下表即当前实况（色值与描述以插件单源 `shared/labels.js` 为准）：

| 用途 | 标签 |
| --- | --- |
| 分类（triage 五角色，与 `docs/agents/triage-labels.md` 一致） | `needs-triage`、`needs-info`、`ready-for-agent`、`ready-for-human`、`wontfix` |
| wayfinder 地图与票型 | `wayfinder:map`、`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task` |
| BUG 单 | `bug` |

打标签严格照技能规则走；除技能规定之外，不额外强制任何标签。

## Pull requests as a request surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

置为 `yes` 时，PR 与 issue 共用同一套标签和状态，改用 `gh pr` 的等价命令：

- **读 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待分类的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的（丢掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一个编号空间，所以裸写的 `#42` 可能两者都是：先用 `gh pr view 42` 解析，失败再回退 `gh issue view 42`。

## 当技能说“publish to the issue tracker”

建一个 GitHub issue。

## 当技能说“fetch the relevant ticket”

执行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一张 issue，它的 **ticket** 是它的子 issue。

- **地图**：一张带 `wayfinder:map` 标签的 issue，正文承载 Destination / Notes / Decisions so far 三个区块。`gh issue create --label wayfinder:map`。
- **子票**：以 GitHub sub-issue 形式挂到地图下（走 `gh api` 的 sub-issues 端点）。若仓库没开 sub-issues，就把子票加进地图正文的任务清单，并在子票正文顶部写 `Part of #<地图编号>`。标签用 `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后把票指派给负责推进的人。
- **阻塞**：用 GitHub **原生 issue 依赖**，这是唯一在 UI 上可见的规范表示。建边用 `gh api --method POST repos/<owner>/<repo>/issues/<子票>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是阻塞票的**数据库 id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，**不是** `#number`，也不是 `node_id`）。GitHub 用 `issue_dependencies_summary.blocked_by` 报告尚未关闭的阻塞票数量（这才是实时闸门）。依赖功能不可用时，退化为在子票正文顶部写一行 `Blocked by: #<n>, #<n>`。当所有阻塞票都已关闭，这张票才解除阻塞。
- **frontier 查询**：列出地图下所有未关闭子票（`gh issue list --state open`，范围限定在该地图的 sub-issues / 任务清单内），丢掉任何带未关闭阻塞票的（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行里有未关闭 issue）以及已有 assignee 的；按地图里的顺序，第一个即为下一张可推进的票。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是本会话的第一次写操作。
- **结票**：先 `gh issue comment <n> --body "<答案>"`，再 `gh issue close <n>`，最后把一条上下文指针（要点 + 链接）追加到地图的 Decisions so far 区块。
