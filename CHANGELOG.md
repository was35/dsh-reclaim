# 更新说明

本文件自 `0.2.1` 起记录。格式是 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的子集——只使用 `Added` / `Changed` / `Fixed` / `Security` / `Deprecated` / `Removed` 这几个固定小节名（这些名字是给消费方解析用的，写成中文会让解析失败）；正文用中文。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

本仓库此前未记录变更历史，`0.2.1` 之前的版本不在本文件中补写。

## [Unreleased]

### Changed

- **兼容范围补上 `0.2.1` 线。** `engines.dsh` 与 `peerDependencies` 里那段文本仍逐字相同，两处都在末尾加了 `|| >=0.2.1-rc.1 <0.3.0-0`。理由是实测出来的：`0.2.1-rc.1` / `0.2.1-rc.3` 的 tuple 是 `0.2.1`，而 `>=0.2.0-rc.1 <0.3.0-0` 在**默认语义**（不传 `includePrerelease`）下对它们都是 `false`——宿主自己判定时带 `includePrerelease: true`，所以装是装得上的，但 npm/pnpm 工具链、市场与第三方检查读到的是「不兼容」。补完之后默认语义下 `0.1.5-rc.1` / `0.1.6-0` / `0.1.6-rc.1` / `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.0` / `0.2.1-rc.1` / `0.2.1-rc.3` / `0.2.1` / `0.2.2` 全为 `true`，`0.1.8-rc.1` / `0.3.0-0` / `0.3.0-rc.1` / `0.3.0` / `1.0.0` 全为 `false`（`0.1.8-rc.1` 与改前一致，不构成回归）。**每出一个新 minor 都得再补一句，这一条不会自动生效。**
- **README 与 `docs/safety.md` §7.4 更正了「宿主不校验兼容范围」这个说法。** 实测 `0.2.1-rc.3` 的 `dsh plugin add`：`engines.dsh` 不匹配时 `@deepseek-ai/dsh-plugin-manager` 的 preflight 直接 `rejected(preflight, "nothing was installed")`，报 `dsh: installation rejected: Plugin … is incompatible with dsh 0.2.1-rc.3: requirements {"engines.dsh":"…"} …`，逃生舱是逐版本豁免 `dsh plugin allow-version <pkg@version> --dsh-version <exact> --accept-risk`（配 `revoke-version` / `version-exemptions`）。**仍然纯声明的只有 `dsh.manifestVersion`**——整棵宿主树里没有任何代码读它（grep 零命中）。文档现在把两个字段分开写，并说明宿主判定带 `includePrerelease: true`、所以范围写错时不会被宿主拦住。

### Fixed

- **`scripts/verify-desktop.sh` 的第 1/4 步不再读 `cordis.yml`**（[#13](https://github.com/was35/dsh-reclaim/issues/13)）。`0.2.1` 起合成树不再落盘——`cordis.yml` 只剩四行注释加 `[]`，宿主在启动时用 `dsh.profile.bundles` 加各 bundle 自带的 patch 现算——所以旧断言拿到的永远是 `Composed entries were: []`，`npm run test:desktop` 在第 1 步就红。现在这一步只读活 profile 的 manifest：bundle 列表头两项必须是 `dsh-base` / `dsh-web-app`，`dsh-desktop-host` 不能是成员，用户层 `cordis.patch.yml` 不能出现 `insert:`（它只有按 id 的 config 覆写，动不了提供者），并如实打印 `cordis.yml` 是不是空 stub。「五个服务由谁提供」挪到第 3 步：在从 `web` 模板克隆的一次性 home 上跑 `--dump-config`，按 `# == <bundle>` 分段把五个提供者逐个归到 `dsh-base` / `dsh-web-app`，缺一个或归到别的 bundle 都 FAIL。`sh scripts/verify-desktop.sh` 在 `0.2.1-rc.3` 上重跑通过（`providers: 5 attributed to dsh-base / dsh-web-app`，活 profile 三个文件 sha256 不变）。
- **清掉一个缓存家族目录后，还原不再把它的子目录判成冲突**（[#12](https://github.com/was35/dsh-reclaim/issues/12)）。一次移动写下的清单本来就知道自己搬了什么——每条 `isDirectory: true` 就是一次整目录搬运——但清单缺失时走的重建分支会把「顶层只有目录」的条目在更深一层拆开，并集于是同时留下「目录」和「它的子目录」两条记录：还原时父目录先回位，子条目随后发现原路径被占（`lib/restore.js:219`），一批**没丢任何字节**的数据因此报 `ok: false`。现在合并重建时，落在本次要写的某条目录条目**内部**的推断条目不再重复写入（`lib/recover.js` 的 `coveredByMove`，走的是 `lib/paths.js` 那道词法包含判断 `isUnder`）——还原那条目录本来就会把内部的东西一并带回来。清单的 `reconstructed` 与那句 note 只在这份猜测确实有内容留下时才写，被覆盖的条数由 `mergeIntoManifest` 新增的 `coveredEntries` 报出。**已经落在盘上、把两份都记着的老清单不改写**：还原它们时「父目录先回位、子条目随后被拒」的判词照旧（字节本身都在，批次之后是空的、可清理）；读侧不替它们折叠，因为父路径被占（例如用户重建了一个空的 `request-images/`）而子路径仍空时，折叠会把本来还能还原的子条目留在隔离区里（`docs/safety.md` §4.5）。`npm run test:host` 第 5 步（`scripts/verify-clear.mjs`）随之从必红变为通过。
- **只清掉一个文件时，清单不再把留守的那个目录也记成条目**（同 [#12](https://github.com/was35/dsh-reclaim/issues/12) 的另一半）。文件被搬走、目录留在原地，重建会连目录一起列出来；用户顺手删掉这个被清空的目录再还原时，这条**幽灵条目**先还原，它自己的子条目随即报出同一句「原路径已出现」，一批字节齐全的数据报 `ok: false`。现在位于本次移动条目**上方**、只作为脚手架存在的推断目录同样不写入——但这一步是证明而非假设：该目录镜像子树下的**每个**文件都必须属于本次移动写下的某条条目，只要有一个不属，这份布局就是那些文件唯一的记录，条目照旧保留（读不出来时同样不丢）。新增 `test/manifest-entry-boundary.test.js`（7 条）钉住两个方向与它们的边界（前缀相同的兄弟、未被覆盖的条目、被证明为脚手架的目录），`npm test` 78 → 85 条全绿。

## [0.3.0] - 2026-10-12

这一版回答两个现场问题：**「这条会话归档了吗」要一眼看得见**，以及**打开审计面板太慢**（现场 124 项实测约 8 秒）。做法是让昂贵的事实只读一遍、让面板尽早把已经确定的东西画出来。诚实规则一条没让：缺服务 / 缺数字 / 缺读取仍然报「未知」，活态仍在使用的当下重读，仍然没有落盘缓存。

真实会话库上的实测（`scripts/bench-audit.sh`，117 个逻辑会话的只读副本）：首屏 **6172 ms → 1184 ms**，热缓存完整渲染 **1366 ms → 11 ms**。

### Added

- **归档状态是标题旁的徽章，不再是指标行里的一个词**（#7）。`facts.archived === true` 画「已归档」；`false` 什么都不画；`null` / `undefined` 画**显式的「归档状态未知」**——读不到归档集合时画成「没徽章」会被读成「未归档」，那是危险方向的错误答案。
- **面板顶部一行「数据截至 HH:MM:SS」**（#5）。`/classify` 现在回报 `scannedAt`（**扫描**时刻）与 `factsFromCache`；`generatedAt` 是**分档**时刻、永远是 now，不能冒充扫描时刻。没有读取时刻就什么都不显示，绝不用 now 兜底。
- **`GET /classify?preview=1`：先出表格，再出判词**（#8）。它只读便宜的一半（会话列举、附件遍历、缓存报告），**不打开任何会话日志**，并把结果整体改标为 `pending`：每行 `tier: 'pending'`、`selectable: false`、参考图派生的数字为 `null`（不是 0——0 会读成「没有」）。任何 `pending` 行都不可选，所以两段回答之间的空档不能被用来删任何东西。
- **标题优先取宿主 projection cache**（#3、#9）。新增 `titleFrom`（`projection-cache` / `live-projection` / `log-fold`）与 `titleAsOfSeq`；缓存供给的行 `titleSource` / `titleUpdatedAt` 保持 `null`——那份快照只带标题文本，没有来源、没有时间戳，`asOfSeq` 是会话日志序列号，不能当时间戳渲染。整日志折叠仍是回落路径（`list()` 会丢掉 `cwd` 缺失的冷会话）。
- **可复现的基准**：`scripts/bench-audit.sh` 在真实会话库的**只读副本**上跑一遍真实宿主，记录首屏 / 完整 / 热缓存 / 显式重扫四组耗时与徽章三态计数；`test/audit-scale.test.js` 用 124 项合成夹具钉住「不重读」（#4）。

### Changed

- **参考图只读一遍日志**（#10）：两次读取之间若有「同一读取器 + 同一 revision」的证据，第二次整日志读被省略，判词如实说明站在什么证据上（`revisionStable`）。真实库实测 111/117 条可跳过，第二次读取省约 78%。
- **隔离区复用审计的会话列举**（#6）：`/trash` 不再自己读第二遍；复用飞行中或 60 秒内的那一代，都没有才自己读。
- **首屏不再强制重扫**（#5）：`rescan=1` 只属于「重新扫描」按钮与删除路径。首屏拿到的是缓存时，后台补一次重扫并自动替换画面；首屏本来就是新扫描时不会连扫两遍。
- **风险刻度只重分档**（#11）：拨动 30 → 7 天不再触发约 3.9 秒的完整重扫，`lib/config.js` 的原始约定重新成立。

### Fixed

- **拨动风险刻度会重读整库**（`shouldRescanAfter`）：挂载 effect 键在阈值上，而「缓存首屏 → 后台重扫」只看答案是否来自缓存，于是每次拨刻度都付一次完整扫描。
- **面板「扫描代数」恒为 1**：`lib/classification-report.js` 读 `facts.scanCount`，而代数从没被写进 facts；现在在铸造处盖进 facts。
- **隔离区把「列举读不到」说成「没有活的会话」**：旧代码 `(sessions?.sessions ?? []).map(...)` 会让每个归档 id 都判成 dangling；现在列举不可读时 `archivedResidue` 报 `ok: false` + 原因，四类计数**全为 null**。

### Security

- 没有字节被销毁，也没有新增销毁路径。删除路径的前置检查照旧**强制重扫**（`lib/routes.js` 的 `factsFor(ctx, 'empty-refs', true, …)` 未动）；进程内缓存只服务读路径，且带 60 秒上界（`FACT_CACHE_TTL_MS`），落盘缓存仍被明确禁止。

**已知的既有问题**（先于本版存在，已在 `a846987` 上复现，不影响本版的两条需求）：`npm run test:host` 第 5 步与 `npm run test:desktop` 第 1/4 步在 `main` 上失败，分别记为 [#12](https://github.com/was35/dsh-reclaim/issues/12)（清单把目录与其子目录各记一条，还原时子目录被拒；文件本身都回得来，失败的是批次判词——**已在 Unreleased 修复**）与 [#13](https://github.com/was35/dsh-reclaim/issues/13)（`verify-desktop.sh` 读的 `cordis.yml` 已不再承载组合项——**已在 Unreleased 修复**）。

## [0.2.1] - 2026-10-11

这个插件对外承诺「清理是搬动，不是删除」。这一版修的是那条承诺所依赖的记录：**没有字节被销毁，被销毁的是来路**。完整推演、代码与文档的出入记在 [docs/safety.md](docs/safety.md) 的 §4.5–§4.9 与 §8.9。

### Fixed

- **同一秒内的多次移动不再共用一个批次目录**（issue #1 的根因）。批次目录名原先只有秒分辨率，而界面「清理」是逐会话各发一次 `POST /delete`，同一秒里的多次移动因此落进同一个目录；每次移动又整份覆写 `manifest.json`，后写覆盖先写，**先移入的条目就此失去 `originalPath`**——文件还在，但没有任何记录说它们从哪来。受影响的是同一秒内进入同一批次、且不是最后一批的那些条目，对插件而言不再可还原。现在由 `claimBatchDir`（`lib/trash.js`）按**操作**认领目录：非递归 `mkdirSync` + `EEXIST` 重试，依次尝试 `<stamp>`、`<stamp>-2`…，只复用**同一次操作**的目录（空目录，或清单的 `sessionIds` 认这个会话）。`dryRun` 不认领，认领失败则什么都不搬，零移动时只删本次创建的目录。
- **写清单改为并集，不再是整份覆写**（`mergeIntoManifest`，`lib/recover.js`）：读回-合并-写入，并在写入后回读校验。两个记录指向不同 `volumeRoot` 时**拒绝合并**——宁可不写，也不写出指向不明的记录。
- **没有清单的批次可以被读回、展示和还原**（`reconstructEntries`，`lib/recover.js`）。批次目录是原路径的镜像，于是「一个条目 = 直接含文件的目录，或空目录」这条边界规则足以把 `originalPath` / `relativePath` / `kind` / `sessionId` 推回来：`planRestore` / `restoreBatch` 据此给出待还原项并把重建的记录落盘（条目带 `inferred: true`），`describePurge` / `listBatches` 据此报出**真实项数**。界面因此不再对这类批次显示 `?`，也不再给出注定失败的按钮。**只对「完全没有清单」重建**：清单存在但校验失败属于 bug，应当报出来，不该被静默补齐。**已知局限**：镜像不记录条目边界，所以顶层只有目录的条目会被更深一层地拆开还原（§4.5）——**一次移动自己的记录优先于这份猜测**（#12，Unreleased）：记着目录又记着它子目录的清单不再被写出来，只搬走文件的清理也不再把它留守的目录记成条目。

### Changed

- `planRestore` 返回值里的 `reconstructed` 现在表示「**本次规划**读了布局」，而不是「这份记录当初是推断的」——重建记录落盘后再规划一次即为 `false`。
- 还原时删除空的 `manifest.json` 若遇到 `ENOENT`，记为 `alreadyAbsent` 而不是失败。
- `directoryBytes` / `directoryFileCount` 从 `lib/trash.js` 移到 `lib/measure.js`（由 `lib/trash.js` 转出，既有调用点不变），避免与 `lib/recover.js` 形成循环依赖。
- 批次目录名不再唯一标识一次操作：同一秒可以有 `<stamp>`、`<stamp>-2`…，把批次名当时间戳解析的调用方要容忍后缀。路由侧无需改动（批次的包含性校验不看名字形状），但隔离区列表按 `batchId` 字符串降序排，同一秒的多个批次之间先后不保证。

### Added

- `lib/recover.js`：清单并集写入与从批次布局读回条目。
- `lib/measure.js`：目录体积/文件数测量，只有一份实现。
- `test/batch-record.test.js`：6 条回归测试，钉住「同秒不同会话各得一个批次」「同 session 同秒复用且条目累加」「无清单旧批次不被复用」「无清单批次可规划、可还原且还原后记录落盘」「列表报出真实项数与推断出的 `sessionIds`」。`npm test` 由 35 条增至 **41 条**。
