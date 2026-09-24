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
- 清理**不是删除**：数据搬进插件自带的隔离区，可随时恢复
- 只读的 Agent 审计工具（模型能查、不能删）

## 安装

功能已经完成并通过验证，但**尚未发布到 npm**，所以 `dsh plugin add dsh-reclaim` 目前还装不到。
在发布之前，可以本地安装：`npm pack` 生成 tgz → `dsh plugin --profile web add file:<tgz>`。

发布之后，安装就是一条命令——装进一个**带 web 层**的 profile（也就是平时用来开界面的那个）：

```sh
dsh plugin --profile web add dsh-reclaim
dsh web
```

装完打开 **设置 → 空间回收**。

> ⚠️ **不要装进一个全新的空 profile。** `dsh plugin --profile <新名字> add <包>` 建出来的 profile 只带 `@deepseek-ai/dsh-base`，里面**没有任何东西提供 web 连接层**，插件会一直停在
> `pending (waiting for service: connection)`，宿主启动失败。要用自己的 profile 时，让它包含
> `@deepseek-ai/dsh-web-app`（例如以自带的 `web` 模板为底），再装本插件。

装好后想确认它在服务，可以直接问它：

```sh
curl -b <会话 cookie> http://127.0.0.1:<端口>/api/dsh-reclaim/health
```

## 支持的 DSH 版本

> **DSH 处于 developer preview，官方 README 明确写着「THERE WILL BE COMPATIBILITY-BREAKING CHANGES」。**
> 而且它**不强制检查**插件声明的兼容范围（`engines.dsh` / `dsh.manifestVersion` 官方原话是"仅作声明"，
> 安装器与加载器都不校验）。所以：**装得上不等于跑得对**，声明范围只能当文档读。

| dsh-reclaim | 支持的 DSH | 说明 |
|---|---|---|
| 0.1.0 | `0.1.5-rc.1` … `0.1.5-rc.3` | **实际验证过的基线**：在 DSH `0.1.5-rc.1` 宿主（依赖包 `0.1.5-rc.2`）上跑过真实数据 + 真实浏览器 |

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
- 想表达"任意 0.1.x 宿主"，只能逐 minor 串 OR 子句：
  `>=0.1.5-rc.1 <0.2.0 || >=0.1.6-0 <0.2.0 || >=0.1.7-0 <0.2.0`，且**每出一个新 minor 要手加一句**。
- `@deepseek-ai/dsh-home-paths` 的 `latest` dist-tag **是过期的旧版本**（`0.0.1-rc.3`），无范围的安装会解析到化石版本。

**当前状态**：范围暂时只声明 `0.1.5` 线（= 实际验证过的范围）。要不要放宽到 0.1.6/0.1.7，
是一个需要作者拍板的取舍——本插件对**磁盘布局**有依赖（`request-images` 的位置在宿主版本间变过，
代码里是特性探测的），所以"声明支持"之前应当先在那个真实宿主上验一遍。

## 它凭什么判断

**引用关系只认结构化字段，不在日志文本里搜哈希。**

判定相对于"这一批保留下来的东西"，并遵循一条硬规则：

> **只要有任何一个会话的引用关系读不出来，「孤儿附件」这一档就整体暂停。**

宁可少删，不可删错。

完整的**分档判定规则**、安全保证与已知边界见 **[docs/safety.md](docs/safety.md)**。

## 不做的事

不清理日志 / 临时文件 / 备份目录；不管理 `profiles/` 下的插件依赖；不做定时自动清理；不允许模型替用户删数据；不支持远端 / 共享存储后端。

> 上面这些规则**已经实现并在真实数据上验证过**：所有破坏性操作都要人在界面上明确确认，Agent 侧只有只读工具。判定规则、安全保证与已知边界见 **[docs/safety.md](docs/safety.md)**。

## 许可

[MIT](LICENSE)
