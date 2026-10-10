# dsh-reclaim

> Audit and safely reclaim the disk space DeepSeek Harness keeps forever.
> 审计并安全回收 DeepSeek Harness 永久占用的磁盘空间。

**DSH 插件。功能已完成，尚未发布到 npm——安装方式见下方「安装」。**

---

## 为什么有这个项目

DSH 官方明确**不回收**附件。`@deepseek-ai/dsh-attachment-local` 的 README 原文：

> **Images are kept forever** — stored images are never deleted automatically, and nothing collects unreferenced objects.

官方也说明了推迟的原因：

> Retention and garbage collection are deferred because **resumed and forked sessions may share immutable objects** …

也就是说，这不是漏做，而是一个需要先解决正确性问题的功能。`dsh-reclaim` 把它做出来，并且尊重官方指出的那条约束。

## 它做什么

- 审计 **会话**、**附件**、**可重建缓存**各自占了多少、还有谁在用
- 按分档规则给风险分级：**安全**（可批量清理）/ **需确认**（逐个查看）/ **危险**（不可清理）/ **未分类**（只报告）
- 清理**不是删除**：数据搬进插件自带的隔离区，可随时恢复。唯一不可恢复的动作，是你在界面上对某一批明确选择**彻底清空**——它只销毁隔离区里**已经搬进去的**批次，不碰活数据
- 只读的 Agent 审计工具（模型能查、不能删）

## 安装

装进一个**带 web 层**的 profile（也就是平时用来开界面的那个）：

```sh
# 从 GitHub 安装（尚未发布到 npm）
dsh plugin --profile web add "git+https://github.com/was35/dsh-reclaim.git#main"
dsh web
```

本仓库**尚未提供 Release 包**，所以上面那条 `git+` 是目前唯一可用的安装路径。将来附上预构建包后，也可以下载后用 `file:<路径>` 安装——省去 clone 与依赖安装。

装完打开 **设置 → 空间回收**。

> ⚠️ **不要装进一个全新的空 profile。** `dsh plugin --profile <新名字> add <包>` 建出来的 profile 只带 `@deepseek-ai/dsh-base`，里面**没有任何东西提供 web 连接层**，插件会一直停在
> `pending (waiting for service: connection)`，宿主启动失败。要用自己的 profile 时，让它包含
> `@deepseek-ai/dsh-web-app`（例如以自带的 `web` 模板为底），再装本插件。

装好后想确认它在服务，可以直接问它：

```sh
curl -b <会话 cookie> http://127.0.0.1:<端口>/api/dsh-reclaim/health
```

> 已发布到 npm 时会多一条更短的路径：`dsh plugin --profile web add @was35/dsh-reclaim`。**尚未发布**，
> 所以上面那条 `git+https://` 才是当前可用的方式。
>
> 注意：上游占用的是**无 scope** 的包名 `dsh-reclaim`，本仓库改用 `@was35/dsh-reclaim`，两者互不冲突。
> 所以 `add dsh-reclaim` 装到的是上游版本，不是本仓库的改动。

## 支持的 DSH 版本

> **DSH 处于 developer preview，官方 README 明确写着「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」。**
> 而且它**不强制检查**插件声明的兼容范围（`engines.dsh` / `dsh.manifestVersion` 官方原话是"仅作声明"，
> 安装器与加载器都不校验）。所以：**装得上不等于跑得对**，声明范围只能当文档读。

| 支持的 DSH | 状态 | 说明 |
|---|---|---|
| `0.1.5-rc.1` … `0.1.5-rc.3` | **已验证** | DSH `0.1.5-rc.1` 宿主 + `0.1.5-rc.2` 依赖包，真实数据 + 真实浏览器 |
| `0.1.7-rc.1` | **已验证** | 独立 home + `0.1.7-rc.1` 的完整依赖树（277 个包）。能力探测 7/7 通过；该版本导出 `dshCachePath`，插件据此**自动改选**了新布局 `cache/attachments/request-images`；真实浏览器面板正常 |
| `0.1.6-*` | **推断，未实测** | 位于两个已验证版本之间，故一并纳入范围；真要依赖它之前建议先验一遍 |

> 版本范围的实现方式值得说明：**必须逐 minor 串 OR 子句**，
> `>=0.1.5-rc.1 <0.2.0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.1.8-0`。
> 每条带**止于下一个 minor**，因此它只声明这三个已验证的 minor——未发布的 `0.1.8` 不在其中。
> `engines.dsh` 与 `peerDependencies` 里这段文本**逐字相同**，避免两者漂移。

装好之后，**一条请求就能看出当前宿主对不对得上**——`/health` 的 `capabilities` 字段逐项列出本插件依赖的
宿主接口在不在（`ctx.effect`、`ctx.connection.fetch.register`、`ctx.get`，以及 `sessions` / `attachments` /
`sessionQuery` / `tools` 四个服务），每项都写明**缺了会坏什么**。版本对不上时，这是最快的诊断入口。

### 为什么不写成"看起来更合理"的范围

顺手记在这里，免得后人（包括我自己）把它"简化"回去：

- `>=0.1.5-rc.1 <0.2.0-0` **不是**"任意 0.1.x"。semver 规定：预发布版本只能被**同一 `major.minor.patch`
  且自身带预发布标识**的比较器放行——所以这条范围**只覆盖 `0.1.5-rc.1/2/3`**，`0.1.6-*` 与 `0.1.7-*` 全被排除
  （已用 `semver` 库实测：`maxSatisfying = 0.1.5-rc.3`）。
- 同理 `>=0.1.0-rc.8 <0.2.0` 会**只剩 `0.1.0-rc.8` 一个版本**——这正是 `dsh-lsp-actions` 记录过的
  "broke fresh tarball installs"。
- 想表达多个 minor 的宿主，只能逐 minor 串 OR 子句，且**每出一个新 minor 要手加一句**：
  `>=0.1.5-rc.1 <0.2.0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.1.8-0`。
  注意**每条带止于下一个 minor**：写成 `<0.2.0` 会让它悄悄囊括还未验证的 `0.1.8+`。
- `@deepseek-ai/dsh-home-paths` 的 `latest` dist-tag **是过期的旧版本**（`0.0.1-rc.3`），无范围的安装会解析到化石版本。

**验证方法**（要加新版本时照做）：换 CLI **不够**——插件从自己的安装位置解析依赖，所以必须**同时**让插件拿到那个版本的依赖树（例如在一个独立的 home 里，用该版本的 CLI 启动，并把依赖树一并指向该版本）。判据不能只看"能不能起来"，要看**依赖层是否真的换了**：要读的判据是 **`families[<请求图片族>].layout.dshCachePathExported`**——顶层并没有 `layout` 对象，照旧写法取值只会拿到 `undefined` 并误判成「版本不符」（见 [docs/safety.md](docs/safety.md) §8.1）。它在 `0.1.5` 上应为 `false`、在 `0.1.6+` 上应为 `true`——如果与目标版本不符，说明插件拿到的仍是旧依赖，**这次验证不算数**。

## 它凭什么判断

**引用关系只认结构化字段，不在日志文本里搜哈希。** 判定相对于"这一批保留下来的东西"，并遵循一条硬规则：

> **只要有任何一个会话的引用关系读不出来，「孤儿附件」这一档就整体暂停。**

宁可少删，不可删错。完整的分档判定规则、安全保证与已知边界见 **[docs/safety.md](docs/safety.md)**；该文档第八节逐条记录了**代码与本文档已知的出入**（含一处尚未生效的纵深防御守卫、以及分级与实际可执行清理能力的错位），改动前先读那一节。

## 不做的事

不清理日志 / 备份目录 / 附件存储之外的临时文件（附件存储自己的原子写暂存区 `attachments/v1/tmp` 属于可重建残留，会清）；不管理 `profiles/` 下的插件依赖；不做定时自动清理；不允许模型替用户删数据；不支持远端 / 共享存储后端。

上面这些**不是设计目标，而是已经实现的行为**：所有破坏性操作都要人在界面上明确确认，Agent 侧只有只读工具。

## 许可

[MIT](LICENSE)
