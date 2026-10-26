# 安全模型与已知边界

这份文档回答 README 里那句「完整的分档判定规则、安全保证与已知边界」到底指什么。

它**逐条对着源码写**：每个结论后面都跟着 `lib/xxx.js:行号`，你可以直接打开那一行核对。凡我无法从代码里确定的，我写在最后一节，不做推测。凡代码与 README 说法不一致的，单列在「代码与 README 的出入」一节，不在这里混着写。

一句话概括这个插件：**它先证明某样东西没人要，再把它搬走；它从不因为「读不到」就认为「没人在用」。** 真正销毁数据的操作只有一个，而且必须由人点名触发（见 §4.5）。

---

## 一、分档规则：什么把一项放进哪一档

### 1.1 档位

四个档位定义在 `lib/classify.js:60`：

```js
TIERS = ['danger', 'confirm', 'safe', 'unclassified']
```

排序权重在 `lib/classify.js:63`（家族取最差档时用）：`danger: 3, confirm: 2, safe: 1, unclassified: 0`。

| 档位 | 中文 | 界面呈现 | `selectable` | `batchClearable` |
|---|---|---|---|---|
| `safe` | 安全 | 复选框，可批量清 | ✅ | ✅ |
| `confirm` | 需确认 | 无复选框；「仍要清理…」入口，展开后按族确认 | ✅ | ❌ |
| `danger` | 危险 | 禁用复选框 + 理由 | ❌ | ❌ |
| `unclassified` | 未分类 | 只报告 | ❌ | ❌ |

`selectable` / `batchClearable` 的赋值在会话侧是 `lib/classify.js:250-253`，附件侧是 `lib/classify.js:333-334`，缓存侧是 `lib/classify.js:392-393`。界面层的三档控件渲染在 `lib/client.js:674-716`：**`safe` 给复选框，`confirm` 给「仍要清理…」按钮，`danger` 给禁用复选框**——即危险行不是「勾了再拒绝」，而是根本不提供勾选。

> **上面这一栏说的是会话档位卡片。缓存/附件有第二张卡片（`lib/client.js` 的 `renderClearables`），规则不同：`tier === 'safe' && batchClearable === true` 才给可用复选框，其余一律给禁用复选框加原因。** 差别在于「仍要清理…」是一个**替代动作**（按族确认后整族搬走），而没被枚举的缓存族没有替代动作可提供，所以诚实的形状是原因写在旁边、控件不动。见 §8.8。

> **关于 `file-objects` 与 `files` 附件族：** 在之前版本中因缺乏样本暂列为 `reportOnly`；现已确认二者为 content-addressed 内容文件与文件名别名硬链接对。两族已解除 `reportOnly` 限制，通过 `indexAttachmentsOnDisk` 聚合成同一附件对象并统计物理字节。在引用图谱完整且零引用（或引用会话已被彻底删除）时，被正确评级为 `safe` 并提供勾选清理，清理时双硬链接协同移入隔离区 `trash/attachments/`，并支持字节对齐完整还原。

### 1.2 会话

`safe` 的定义是**五条件全部成立**，原文注释在 `lib/classify.js:14-21`：

1. 已归档（用户亲手表达的「我不需要它了」）；
2. 超过阈值；
3. 没有入边（没有别的会话用 `@session` 指向它）；
4. 它不是「不在本批内」的会话的父；
5. 它的全部子会话都在本批内。

(4)(5) 分开实现、分开报告，因为对用户说的话不同（`lib/classify.js:195-203`）。

判定式本身很短，就在 `lib/classify.js:225-232`：

```js
let tier = 'safe'
if (livenessBlocks || referencing.length > 0) tier = 'danger'
else if (childrenOutside.length > 0) tier = 'confirm'
else if (failed.length > 0) tier = 'confirm'
```

逐项机制：

- **活态是一票否决的闸门。** `livenessBlocks = !context.sessionsServiceAvailable || DANGEROUS_LIVENESS.includes(liveness.state)`（`lib/classify.js:155`），而 `DANGEROUS_LIVENESS = ['running','idle-live','unknown']`（`lib/classify.js:66`）——注意 **`unknown` 也在内**：读不到活态既不算活着也不算死了，一律不许清。四个活态取值在 `lib/liveness.js:42`；`running` 是「Agent 正在跑一个回合」，不是存活测试（`lib/liveness.js:1-31`）；两个探针互相矛盾时返回 `unknown` 而不是二选一（`lib/liveness.js:170-186` 附近，reason `probes-disagree`）。
- **被引用即危险。** `referencing = (context.referencingSessionIds ?? []).filter(other => other !== id)`，非空即记一条失败（`lib/classify.js:176-182`），自环被过滤掉。**这条判据现在不只是界面语汇**：`POST /delete` 用同一条规则在服务端复核并拒绝（`buildReferencingIndex` / `referencingSessionIdsOf`，`lib/graph.js:53-68`），见 §4.4 与 §8.5。
- **是外面的父 → 需确认。** `childrenOutsideBatch` 非空即记 `parent-of-outside-session`（`lib/classify.js:186-193`）。
- **归档三态，不是布尔。** `session.archived === true` 通过；`null/undefined` 记 `archived-unknown`；否则记 `not-archived`（`lib/classify.js:205-210`）。语义在消息里写死：「归档状态未知（归档集合读不到），不能当成‘未归档’，也不能当成‘已归档’」（`lib/classify.js:79`）。**归档集合在注册表全局，不在 workspace 实体上**；从实体读会得到 `undefined`，当成 `[]` 就会给出「没有任何东西被归档」这种危险方向的错误答案（`lib/sessions.js:130-143`、`lib/sessions.js:403-404`）。
- **年龄未知 ≠ 很老 ≠ 0。** `activityMs = lastActivity ?? createdAt`，`activitySource` 记来源；`ageDays` 为 `null` 时记 `age-unknown`，只有 `activityMs <= cutoff` 才算 `older-than-threshold`（`lib/classify.js:212-221`）。`ageInDays` 对非有限时间戳返回 `null` 而非 0（`lib/config.js:162-165`），阈值算术是 `nowMs - thresholdDays * 86400000`（`lib/config.js:148-150`）。
- **阈值是用户的风险胃口，不是测量值。** 选项只有 7/14/30/90 天（`lib/config.js:27`），默认 30（`lib/config.js:30`）；**改阈值不重扫**（`lib/config.js:1-24`、`lib/classification-report.js:13`）。坏值一律钳回默认**并报告**，绝不静默读成 0——「把 `thresholdDays: 0` 静默读成‘全删’是唯一要紧的失败模式」（`lib/config.js:16-22`）。
- **`safe` 之外没有别的出口。** 归档、超阈值、子会话都在批内这三条任何一条不成立 → `confirm`（`failed.length > 0` 分支）；活态或引用问题 → `danger`。因此未归档的会话出现在「需确认」，而不是「危险」。

### 1.3 家族

父会话与它的（直接/间接）子会话**作为一个单元分档**，理由是用户的心智模型：删父留子会留下「父已消失的孤儿」（`lib/family.js:1-8`）。两条规则（`lib/family.js:9-17`）：

1. **家族档 = 成员中最差档**（`lib/classify.js:436-439`）；
2. **只有每个成员各自满足全部安全条件时，家族才可批量清**（`allIndependentlySafe`，`lib/classify.js:440`）。

第 2 条是防线所在：没有它，一个已归档、长期不活跃的父带一个从未归档的子会整族变成「安全」被一键扫走，删掉用户从未表态的子（`lib/family.js:12-17`）。家族视图算出来后，**仍标记为 `safe` 的成员会被降为 `confirm` 并加 `family-not-fully-safe`**（`lib/classification-report.js:234-245`）。

家族边界跟随两类关系：谱系（`SessionHeader.parentSession`）与结构化 `@session` 边；两个子索引取并集，因为「漏掉一条 lineage 边会缩小家族，而更小的家族是更不保守的答案」（`lib/family.js:104-114`）。指向清单外的父被报为 `unresolvedParents` 而不是静默当根，并且家族被标 `incomplete`（`lib/family.js:80-102`、`lib/family.js:186-203`）。

### 1.4 附件

`classifyAttachment` 只有两个出口：**`safe`（零引用已被证明）或 `danger`**（`lib/classify.js:322`）。三条阻塞，按顺序短路（`lib/classify.js:306-321`）：

| 条件 | reason code | 说明 |
|---|---|---|
| `entry.sessionIds` 非空 | `referenced-by-session` | 仍被保留的会话引用，删掉会损坏那些会话 |
| `context.referenceGraphAvailable === false` | `reference-graph-unavailable` | 引用图整表读不到，无法证明任何附件零引用 |
| `!context.orphanDeterminationAllowed` | `orphan-determination-paused` | 硬规则触发，整档暂停（见 §2） |

注意 `referenceGraphAvailable` 的取值是 `graph.ok !== false`（`lib/classification-report.js:262-264`）——**故意用 `!== false`**：不带这个标记的事实源不构成「图缺失」的证据，而永远填充的「有会话未证明」闸门会兜住底。

### 1.5 可重建缓存

三类：派生请求图片（`request-images` 族）、暂存残留（`tmp` 族）、孤儿会话投影缓存（`<home>/storages/session_projcache/sessions/<id>.json`，`lib/caches.js:31`）。

缓存判定**不依赖引用图**，但依赖「确实枚举过」（`lib/classify.js:355-369`）：

- `enumerable = item.available === true && item.enumerated !== false`；
- 不可枚举 → `unclassified`，理由「目录没能枚举（读不到或后端不可用），因此既不说它安全，也不说它有什么」；
- 可枚举 → `safe`。

族级缓存行（只处理 `request-images` 与 `tmp`，`lib/classification-report.js:280-314`）：`tier = family.enumerated === true ? 'safe' : 'unclassified'`，`freedByDeletingBytes` 可枚举才给数。

> **第二道闸门：核心会话清单读不到时，缓存整体退出安全档。** `coreListingAvailable = facts.sessions?.available !== false`，为假时所有缓存族行与孤儿缓存行降为 `unclassified`、`batchClearable = false`、`freedByDeletingBytes = null`，理由是中文原话：「核心会话清单读不到，无法确认这些可重建产物不被任何会话占用；缺失的清单不等于空清单，因此本项不进安全档」（`lib/classification-report.js:321-353`）。缓存本身不依赖引用图，但它依赖「有没有人会认领它」。

### 1.6 未知对象

不属于任何已定义族的对象（比如宿主升级后遗留的旧 `attachments/v1/request-images`）**恒为 `danger`**，reason code `not-in-any-defined-family`，`selectable`/`batchClearable` 都是 false（`lib/classify.js:403-421`，判定入口 `lib/attachments.js:392`）。理由：「不属于任何已定义族的对象，无法判断它是什么，因此不提供清理」。它的字节从不计入任何族总数，单独核算（`lib/attachments.js:332-400`）。

### 1.7 第二遍：行上那个数字是怎么来的

分档跑**两遍**。第一遍（`lib/classification-report.js:204-223`）产出候选；`lib/recompute.js` 把这些候选当成**已经不在**，重算「这一批没了之后，还有没有东西需要它」（`lib/recompute.js:6-7`）。所以模块头部就写明：**行上的数字永远是第二遍的结果，不是第一遍的**（`lib/classify.js:6-10`）。

第二遍做四件事：

1. **活态重读，掉队的候选被剔除。** 候选来自行自身 `row.batchClearable === true`（这样批次永远不会和界面上显示的内容漂移，`lib/recompute.js:59-62`）；逐个 `probe(id)`，**只有当下仍是 `not-live` 才留下**，否则剔除并记 `liveness-changed-before-decision`，理由原文：「the batch must never be built from a stale liveness read」（`lib/recompute.js:64-84`）。
2. **家族全有或全无。** 家族里任何一个成员掉了，整族在批内的成员全部移出，记 `family-not-fully-in-batch`（`lib/recompute.js:86-112`）。
3. **对象级归因，不重复计数。** `becomingOrphanIds` = 引用者全部都在保留集合里的对象；字节按**对象**归给持有它最后引用的那个候选（`lib/recompute.js:114-141`）。共享对象只贡献一次——「double-counting is the one way a『freed』number can lie upwards」。
4. **在批次之后才变成孤儿的附件被降为 `confirm`，绝不提升为已安全。** 加 `becomes-orphan-after-batch`、`cascade: true`、`batchClearable = false`、`selectable = true`（`lib/recompute.js:170-184`）。

仍被保留的会话引用的附件行，`freedByDeletingBytes = 0`（`lib/recompute.js:190-196`）——它一点都不释放。

**这是 README 那句「判定相对于这一批保留下来的东西」的落地机制。**

### 1.8 措辞纪律（这条有强制检查）

- 用「删掉可释放」（`freedByDeletingBytes`）与「去重张数」（`dedupCount`）；
- **禁用「占用 N MB」**，因为内容寻址去重后，一张共享图片在某个持有者消失时什么都不释放，这种写法在任何一个共享对象行上都是假话（`lib/classify.js:42-52`、`lib/classification-report.js:533-556`）。

这不是口头约定：禁用词以 UTF-16 码点声明（`forbiddenWordingCodePoints: [[0x5360, 0x7528]]`，即「占用」，`lib/classification-report.js:546`），而 `findForbiddenWording` **真的遍历序列化后的每一个字符串去找它**，结果写进 `report.limits.forbiddenWordingEmitted`（`lib/classification-report.js:570-594`）。注释解释了为什么用码点：规则是「报告里永远不出现这个短语」，把它写出来就自我违背了。

---

## 二、硬规则：任何一个会话读不出来，孤儿附件整档暂停

README 的硬规则原文：

> **只要有任何一个会话的引用关系读不出来，「孤儿附件」这一档就整体暂停。**

### 2.1 实现落点

`lib/graph.js:226-235`，一字不差：

```js
orphanDetermination: unknownSessions.length === 0
  ? { allowed: true, reason: null, unknownSessions: [] }
  : {
      allowed: false,
      reason:
        `attachment relations could not be proven complete for ${unknownSessions.length} of ` +
        `${sessions.length} session(s); orphan detection is PAUSED for the whole scan rather than ` +
        'silently under-counting',
      unknownSessions,
    },
```

`unknownSessions` 是**全部** `coverage === 'unknown'` 的会话 id（`lib/graph.js:185`）。暂停范围是**整个扫描**，不是那一个会话——模块头部把理由写清楚了：那个会话的附件可能只被读不到的那一部分引用，所以孤儿这一类整体停下（`lib/graph.js:1-13`）。

这个 `allowed` 一路传到附件判定（`lib/classification-report.js:160`、`lib/classification-report.js:249-272`），再变成每一行的 `orphan-determination-paused`。

### 2.2 「读不出来」的准确含义

不是「抛异常了」，而是四项覆盖率检查**任何一项不通过**（`lib/coverage.js:51`）：

```js
COVERAGE_CHECK_IDS = ['services', 'read-paths', 'extraction', 'atomicity']
```

`reconcile()`（`lib/coverage.js:76-263`）逐项判定，只要 `reasons` 非空就是 `unknown`：

| 检查 | 通过条件 | 不通过意味着 |
|---|---|---|
| `services` | `observeSession === true && sessionPersistence === true && open === true`（`lib/coverage.js:80-82`） | 缺一个读取服务 → 「读取成功却什么都没解析出来」这一失效模式无法排除 |
| `read-paths` | 两个独立读取器交叉校验：**方向敏感**地要求 `rawEventCount <= queryEventCount`（不是相等），`inheritedEventCount` 一致，且两边引用集合双向差集为空（`lib/coverage.js:88-151`） | 日志被截断 / 只解出第一个压缩帧 |
| `extraction` | 递归遍历得到的 id 集合与独立 key-literal 扫描双向差集为空，且 `parseErrors` 为空（`lib/coverage.js:155-185`） | 出现所谓 S1 形态（路径枚举漏项） |
| `atomicity` | `seqs[0] === 0 && gaps.length === 0 && cursor === seqs.at(-1)`（事件数为 0 时要求 `cursor === null \|\| cursor === -1`）；`inheritedEventCount <= eventCount`；读前后 revision 未变；且**观测租约已释放**（`lib/coverage.js:188-240`） | 日志被截断，或读取被中断 |

方向敏感这一点值得单说：**不要求两个读取器的事件数相等**。实测一个会话 query 层 2651 条、raw 层 2648 条而引用集合完全相同，因为 query 层会平衡被打断的回合而 raw 层不会；只有 raw **多于** query 才算失败（`lib/coverage.js:96`、`lib/coverage.js:140`）。把「相等」当规则会对健康会话误报。

`rawRead` 交叉校验**不是每个会话都做**，默认 `verifyRead = 'empty-refs'`（`lib/graph.js:61`）：只有在「零引用」这个恰恰授权删除的结论上才做双重读取（`lib/graph.js:42-48`）。验收时用 `'all'`。

### 2.3 更彻底的一种「读不出来」

会话清单本身读不到时，连图都不给，`orphanDetermination` 直接 `allowed: false`（`lib/graph.js:245-260`），附言：「the session listing could not be read, so no graph is reported; this is "unknown", not "no references"」。此时每一行附件都拿 `reference-graph-unavailable`。

### 2.4 同一个失败方向的另外两处闸门

- **附件层**：`orphan-determination-paused`（`lib/classify.js:308-321`）；
- **缓存层**：会话清单读不到 → 全部退出安全档（§1.5，`lib/classification-report.js:321-353`）。

三处共用一条原则：**缺服务、缺清单、缺读取，一律报为不可用，绝不报为空。** 同一条原则在 `lib/sessions.js:20-33`（缺服务不报零会话、缺数字保持 `null` 不用 0 填充）、`lib/caches.js:58-66`（`sessionIdsFrom` 与 `sessionIdsUnavailable` 是两种返回值）、`lib/workspace-sync.js:42-61`、`lib/liveness.js:1-31` 里各自再写了一遍。

### 2.5 这条硬规则**不**保证什么

它保证的是「不把没读到当成没人引用」，不是「引用关系一定完整」。完整性永远是**相对于可读的日志**证明的，而本机没有任何存储事件计数可用——见 §6.1 的实测数据。

---

## 三、引用关系怎么判定

README 的说法是：**引用关系只认结构化字段，不在日志文本里搜哈希。** 代码里是这样：

### 3.1 只读这些字段

**附件引用**：递归遍历事件的每一个值，收集**任意深度**的字符串 `attachmentId` 字段，并剥掉 `sha256:` 前缀（`lib/refs.js:64-77`）。`seen` WeakSet 只用来防环，注释解释了为什么这里防环是安全的：输入来自 `JSON.parse`，永远不会把同一个对象交出来两次，所以它只会压掉真正的环，不会压掉合法的重复出现。

**会话引用**：只认 `source.kind === 'session-reference'`，并读两种已发布的编码形式（`lib/refs.js:98-120`）：

1. `source.uri`，前缀 `dsh-session:<id>`；
2. `source.references[].sessionId`，即宿主真正写下的持久召回形式。

两种都要读，是**用真实样本试出来的**：第一版只认 URI 形式，结果产出了一条目标为 `null` 的边（`lib/refs.js:79-96`）。

### 3.2 为什么不枚举路径

`lib/refs.js:6-13` 记着实测账：结构化 `attachmentId` 共 **18** 处，早期按路径枚举的两条路径只覆盖 **6** 处，漏掉 12 处；识别出 3 张图，实际 13 张；**10 张正在使用的图片会被判成「零引用孤儿」**。漏掉的大多住在 `tool/result` 事件里。结论写在 `lib/refs.js:19`：完整性只能靠递归遍历，**走遍每个值，永不点名路径**。

### 3.3 文本扫描只作第二意见，永不参与判定

`independentKeyLiteralScan` 用正则 `/"attachmentId"\s*:\s*"sha256:([0-9a-f]{64})"/g` 纯文本扫一遍（`lib/refs.js:243-262`），只允许两种结果：与递归遍历一致，或者**暴露递归遍历的 bug**。它不决定任何引用。

序列化里出现、结构化集合里没有的裸 64 位十六进制串被单独计数为 `textOnlyHex`，注释明确它「永不参与引用判定」（`lib/refs.js:194-215`）。这是有实测支撑的：**118 个事件含字面量 `session-reference`，而结构化 `source.kind === 'session-reference'` 边为 0**（`lib/refs.js:27-30`）——文本搜索会凭空造出 118 条边。图报告里也会就这一点出 note（`lib/graph.js:198-208`）。

### 3.4 「相对于保留集合」怎么落地

见 §1.7。三个后果必须一起看：

- 只被本批候选引用的附件 → 变成 cascade，**降为 `confirm`**，不偷偷扫走；
- 候选与保留会话共享的对象 → `freedByDeletingBytes = 0`，一个字节都不算释放；
- 批次总量由**对象**算出，不是把逐行归因相加（`lib/recompute.js:203` 附近）——表头 `totalReclaimableBytes` 是互不相交来源桶之和（`lib/classification-report.js:434-436`、`lib/classification-report.js:518-525`），按行求和会把共享对象按持有者重复计数。

### 3.5 计数纪律

一个会话可以重复引用同一个对象（实测：2 个对象出现 6 次），所以每个展示出来的数字都是**去重后的对象数**，出现次数只作为证据单独报（`lib/graph.js:14-18`、`lib/classification-report.js:270-272`）。附件索引按内容 id 去重，`sessionIds` 去重且排序（`lib/graph.js:182-184`）。

---

## 四、隔离区模型：「删除」到底做了什么

### 4.1 位置与批次布局

隔离区根是 `<home>/.dsh-reclaim-trash`（`TRASH_DIR_NAME`，`lib/paths.js:37`；`home` 由官方 `resolveDshHome()` 解析，绝不硬编码，`lib/paths.js:259-293`）。

一个批次是一个目录 `<home>/.dsh-reclaim-trash/<batchId>/`，`batchId` 形如 `2025-10-10T18-40-00`（冒号在 Windows 上非法，故替换为 `-`，同时保持可排序，`lib/trash.js:99`）。批次内按种类分子目录（`lib/trash.js:65-71`）：

```js
BATCH_SUBDIRS = { session: 'sessions', 'session-cache': 'session-caches',
                  attachment: 'attachments', cache: 'caches', other: 'other' }
```

布局必须同时满足三个条件，全部来自实测（`lib/trash.js:13-25`）：

1. **在 `sessions/` 与 `attachments/` 之外**——宿主会遍历那两棵树，搬进去会变成幽灵条目并被双重计数；
2. **被插件自己的扫描排除**——否则插件会「清理自己的回收站」，用户一还原、下次扫描又删一遍；
3. **manifest 在批次内部**——还原信息随数据旅行：把批次目录拷到另一块盘，仍然可还原，没有会丢的旁表。

### 4.2 移动原语：测出来的，不是假设的

`lib/trash.js:27-45` 记着四条实测事实：

- 本工作区里 `rmSync(recursive)` 与 `cpSync(recursive)` **会正常返回却什么都不做**，所以这里从不相信递归调用已经完成了工作；
- `renameSync` 对文件与非空目录都有效，一次原子调用，不需要先递归删；
- **`renameSync` 会静默覆盖已存在的文件**——唯一无声丢数据的失败模式；因此每次移动都先查目的地，冲突即拒（`lib/trash.js:265-277`）；
- 撞上已存在目录时 `renameSync` 报 `EPERM`；跨卷 `EXDEV` 时退化为 copy → 校验字节 → unlink，这是唯一不会留下零份副本的顺序。

### 4.3 一个会话住在五个地方

`lib/delete-session.js:10-16`：

| # | 位置 | 处理 |
|---|---|---|
| ① | `sessions/<workspace-slug>/session-<id>/` | 移进批次 |
| ② | `storages/session_projcache/sessions/<id>.json` | 移进批次 |
| ③ | 工作区的 `sessionIds` | 移动后用官方 `detachSession()` 移除并**回读** |
| ④ | 持久索引 | 本机实测不存在，报为「已检查、为空」，不假定 |
| ⑤ | 后台任务归属 | 在**任何东西移动之前**检查 |

①② 先于 ③ 是刻意的：工作区实体每次写入都会修剪「会话目录不再解析」的成员，所以先移动意味着宿主已在自行修正记账；移动失败则会话完整且仍在账上（`lib/workspace-sync.js:17-25`）。反序会留下「记账说没有、文件还在」，若随后移动失败则会话活着却不在账上——比两端任何一端都糟。

`detachSessionAccounting` 的成败看的是**回读后的记账状态**，不是「我们调用过那个方法」；它仍被持有时报「detachSession() reported no error but the id is still there」而不是换个方法重试（`lib/workspace-sync.js:97-167`）。

会话目录的定位：`workspaceSlug` 是快路径（`lib/delete-session.js:75-88`，`--` 包裹、ASCII 字母数字与 `.` 保留、连续 `-` 折叠、非可打印 ASCII 变 `~` + 四位大写十六进制），**不中时会扫整棵树**（`lib/delete-session.js:115-197`），因为「找不到」会把删除静默变成空操作；候选目录只有在真的含 `session.v<N>.jsonl(.zstd)?` 工件时才被接受。

### 4.4 单条删除的前置检查——以及它**不**检查什么

`planSessionDelete`（`lib/delete-session.js:281-395`）产生四类 blocker：

1. 活态 **不是** `not-live`（`unknown` 的理由是「活态无法判定，故不得移动」）；
2. **引用关系读不出来**（`reference-graph-unavailable`）；
3. **有别的会话引用了它**（`referenced-by-other-session`，`detail.referencingSessionIds` 列出是谁）；
4. 会话目录找不到（`session-dir-not-found`）。

`deleteSession` 再额外拒绝「仍拥有后台任务」的会话，并把任务列出来而不是静默放弃。blocker 非空时**在任何东西移动之前**拒绝。

> **单条删除仍然不检查档位、不检查归档、不检查阈值——但「引用完整性」现在是 API 层的硬约束了。**
>
> 第 2、3 条 blocker 是后补的。此前档位计算会把「被别的会话引用」判成 `danger` 并禁用界面复选框（`lib/classify.js:250-253`、`lib/client.js:674-690`），而 `POST /delete` 收一个 `sessionId` 加一个 `confirm` 就搬东西：**一个手写的请求就能把一个仍被引用的会话搬进隔离区**。这不是数据丢失（隔离区可还原），但引用完整性当时只在界面层成立。
>
> 现在这条关系与活态一样，在决定的当下现读（`readReferences`，`lib/delete-session.js:234-273`），默认自己建图、调用方有现成的才覆盖。判档与拒绝共用同一条规则（`buildReferencingIndex` / `referencingSessionIdsOf`，`lib/graph.js`），因为两者必须永远一致：不一致时无人报警，而最坏方向的不一致正是「界面禁勾的会话被服务端放行」。
>
> **读不出来 ≠ 没人引用。** 图不可读时拒绝，而不是读成空图——这是 §2 那条硬规则在单条删除上的同一条纪律。
>
> 「档位」（`danger` / `confirm` / `safe`）本身仍然只是「界面不提供入口」的意思，不是 API 拒绝的理由。现在拒绝的理由是它背后那两条**事实**——活态与引用——而这两条服务端都自己复核了。`body.risk` 是调用方自述，不授权任何事，只作为证据记录（`lib/routes.js:639-701`）。

### 4.5 manifest

- 名字 `manifest.json`，版本 1；**版本不符的 manifest 被拒绝而不是猜**（`lib/manifest.js:43-46`、`lib/manifest.js:105-160`）。
- 字段：`originalPath`（绝对）、`relativePath`、`kind`、`sessionId`、`bytes`、`files`、`isDirectory`、`removedAt`、`risk`、`note`（`lib/trash.js:800-830` 附近；`lib/manifest.js:9-26`）。
- `risk` 是**移动之前**算出的档位与引用证据，故意随数据归档：本插件的全部承诺是「动手之前给你看了证据」，事后重算只会描述一个已不存在的状态（`lib/manifest.js:18-22`）。
- **读取时两条路径互相校验**：相对路径复现不出绝对路径的 manifest 是损坏的，损坏的 manifest 不得静默引导还原（`lib/manifest.js:9-17`）。批次没记 `volumeRoot` 时，比对结论写「the batch records no volume root, so the two path forms cannot be compared」——**说「一致」是它支持不了的断言**（`lib/manifest.js:105-160`、`lib/manifest.js:257-303`）。
- 校验还要求每条 `relativePath` 解析后**必须落在批次目录内**：「a manifest that points outside it would let a restore read an arbitrary path」（`lib/manifest.js:105-160`）。

> **崩溃规则：manifest 不在移动之前写。** 一个有内容没 manifest 的批次目录因此只意味着一件事：操作被中断。它被报为 `incomplete` 并列出给用户，**永不自动清理**——自动清理它就是插件自行删数据（`lib/manifest.js:28-34`、`lib/purge.js:165-222`）。

**没 manifest 的批次不再是一条死路（issue #1 修复之一）。** 批次目录本身是一份镜像：每个条目的原始路径就写在它的目录名里（`<batchDir>/<kind 子目录>/<volumeRoot 起的各段>`）。所以清单缺失时，记录可以**从布局读回来**：`reconstructEntries`（`lib/recover.js`）按「一个条目 = 一个直接含文件的目录，或一个空目录」的边界规则把 `originalPath` / `relativePath` / `kind` / `sessionId` 重新推出来，`planRestore` 据此规划、`restoreBatch` 据此还原，并在还原之后把这份重建出来的记录**落盘**（重建在 `lib/restore.js:85-110`，落盘在 `lib/restore.js:239-240`）。`listBatches` / `describePurge` 也用它把「条目数未知」换成真实项数（见 §4.8）。重建出的条目带 `inferred: true`，清单的 `notes` 里写明这是从布局推回来的，**不谎称它就是当初写下的那份记录**。

> 只有**完全没有**清单时才重建。清单存在但校验不通过是另一回事——那是「记录与批次不一致」的真 bug，把它偷偷换成一份新记录等于把问题藏起来（`lib/restore.js:85-88`）。
>
> **重建的已知局限**：镜像不记录条目边界。一个自身顶层只有目录的条目，会被在更深一层拆成多块、分别还原到（还原时才创建的）原目录里，效果等价于把一棵树分块重建；条目自身的文件都回得来，中间目录的归属只是重新推断的。

> **一次移动自己的记录优先于布局的猜测（issue #12 修复）。** 上面这条局限只属于「整批既没有清单、也没有任何一次移动的记录可依」的情形。移动本来就知道自己搬了什么：它写下的每一条 `isDirectory: true` 就是一次整目录搬运，所以合并重建时，落在这样一条目录**内部**的推断条目不再重复写进清单——还原那一条目录本来就会把内部的东西一并带回来，两条都留着会让一份没丢任何字节的批次报出「原路径已被占用」（`lib/recover.js` 的 `coveredByMove`，走的是 `lib/paths.js` 那道词法包含判断 `isUnder`；「request-images-old」这种只是前缀相同的兄弟不算「内部」）。反方向同样成立，而且是单文件清理里暴露出来的：只把一个文件搬出某个目录时，那个目录留在原地，重建会连它一起列成条目——用户顺手删掉这个被清空的目录再还原，这条幽灵条目就先还原，它自己的子条目随即报出同一句「原路径已出现」。所以作为本次移动**脚手架**而存在、位于移动条目上方的推断目录也不写入；但这一步是**证明而非假设**：该目录镜像子树下的每个文件都必须属于本次移动写下的某一条条目，只要有一个不属，这份布局就是那些文件唯一的记录，条目照旧保留（`listFilesUnder` 读不出来时同样不丢）。清单的 `reconstructed` 与那条 note 只在这份猜测**确实有内容留下**时才写：猜出来的条目全被移动记录覆盖时，清单就是这次移动的真实记录，不谎称自己推过布局（被覆盖的条数由 `mergeIntoManifest` 的 `coveredEntries` 报出）。
> 已经落在盘上的、把「目录 + 它的子目录」各记一条的老清单**不改写**：还原它们时父目录先回位，子条目随后发现原路径被占，于是照旧报失败（字节本身都在，批次随后是空的、可清理）。读侧不替它们折叠：当父路径被占（例如用户重建了一个空的 `request-images/`）而子路径仍空时，折叠会把本来还能还原的子条目一起挡掉——那是把数据真的留在隔离区里。

写入用**临时文件 + rename**，这样写到一半崩溃不会留下能解析成有效 manifest 的半成品（`lib/manifest.js:176-195`）。这是整个插件里唯一允许 rename 存在活目标的地方，因为 `renameSync` 的静默覆盖在这里正是需要的语义。

**写清单是并集，不是覆盖（issue #1 修复之二）。** 一次移动不再 `writeManifest(batchDir, 新清单)` 整份盖掉旧记录，而是 `mergeIntoManifest(batchDir, candidate, { volumeRoot })`（`lib/recover.js`）：读回现有清单、按 `relativePath` 合并、再写，并在写后**回读校验**「本次要写的每一条都在里面」。理由是 §8.9 讲的那次事故：同一秒里的第二次移动把第一次的记录盖掉了，而那条记录是那些条目唯一的来路。并集的另一半是**优先**：布局猜出来的条目若落在本次要写的某条目录条目内部（或反过来——本次移动的条目全在它内部、证明它只是脚手架，见上），就不再重复写入（issue #12 修复，见上；一次搬运一条记录）。另有一条硬规则：**两个批次若记着不同的 `volumeRoot`，合并被拒绝**（返回 `ok: false` + 理由）——把两个根的路径混进一份清单，等于写出一份自己都不知道指向哪里的记录。

### 4.6 「删除」执行时的失败规则

`deleteSessionItems`（`lib/trash.js:787-1011`），顺序是**先认领目录、再规划、再动手**：

- **先认领一个批次目录**：`claimBatchDir`（`lib/trash.js:626-699`）按同一秒的第一个候选名（`<stamp>`、`<stamp>-2`、…）用 `mkdirSync`（非 recursive，`EEXIST` 即别人先到）认领一个目录。**它只复用属于同一次操作的目录**：空目录可复用；已有清单且 `sessionIds` 含本次的 `sessionId`（无 `sessionId` 时要求该批次也没有 session 归属）才复用；属于别的会话、或持有说不清内容（无清单 / 清单读不出来）的目录一律跳过——**往一个不可恢复的批次里继续堆数据只会把损失做大**（`lib/trash.js:599-624` 的设计注释）。设计里 100 个候选名都用满则拒绝并说明（`lib/trash.js:691-698`）。
- 认领失败时 `ok: false`，且**什么都没搬**（`lib/trash.js:825-840`）。认领必须发生在规划之前，因为规划里的目的地路径就在那个目录里（`lib/trash.js:813-824`）。
- **先规划再动手**；`dryRun` 只回 `wouldMove` / `skipped`，不碰任何东西，且**不认领**（走纯函数 `batchDirFor`，所以预览能报出「会进哪个目录」而不占位）（`lib/trash.js:821-823`、`lib/trash.js:862-882`）；
- 一件都搬不动时**不写 manifest**，返回 `ok: false` 并逐条给出理由：「none of the N item(s) could be moved, so no batch was created and no manifest was written; each item is listed with its reason and every one of them is still in place」（`lib/trash.js:884-907`）。此时如果目录是本次调用创建的，`releaseEmptyBatch` 把它删回去；复用来的目录一律不动（`lib/trash.js:708-715`）；
- 只有真搬成功的条目进 manifest（`lib/trash.js:936-947`），写入走**并集合并**而不是覆盖（`lib/trash.js:961-965`，见 §4.5）；
- 任何一项搬不动都**留在原地**并在报告里列明。会话条目全部搬完才做 ③ 的记账；记账是对刚写好的清单做**无 await 间隙**的读-改-写，所以并集不会在这里被丢掉（`lib/trash.js:967-984`）。

跨卷时 `copyTreeVerified` 会先数一遍、拷贝后再校验文件数与字节总量；**符号链接永不跟随**（跟随会复制到树外），有 links 则 `verified: false` 且**原文件不得删除**（`lib/trash.js:371-427`）。`removeTreeVerified` 用显式遍历（因为 `rmSync` 无效），目录按深度降序删——注释说反转发现顺序**不够**，实测曾留下空批次树（`lib/trash.js:437-491`）。

### 4.7 还原

还原是移动的镜像，多一条规则——**还原永不覆盖**（`lib/restore.js:1-13`）：移动时目的地是插件自己的批次，冲突只意味着「这个批次已经有它」；还原时目的地是用户的活树，那时用户可能已经建了同 id 的新会话、手工放回了文件、或用别的批次还原过同一路径。覆盖会毁掉用户现有的东西，所以正确行为是**停下并说明**。

逐条状态（`lib/restore.js:72-188`）：`batch-item-missing`（批次声称有而实际没有）、`target-inside-trash`、`target-occupied`（「something already exists at the original path; a restore never overwrites it」）、`target-unusable`（父路径存在但不是目录），否则 `pending`。执行时再**检查一次**目标是否出现（规划与还原之间可能有人创建），然后 `moveBack`（`lib/restore.js:196-334`）。

**没有清单的批次可以被还原（issue #1 修复之三）。** `planRestore` 读不到清单时不再直接返回失败，而是从布局推回条目（见 §4.5），并把这个事实报为 `reconstructed: true`。这里的 `reconstructed` 说的是**本次规划真的读了布局**，不是「这份清单历史上是重建出来的」——重建后的记录落盘以后就是一份普通记录，下一次规划它是 `reconstructed: false`（`lib/restore.js:84-110`、`lib/restore.js:196-334`）。

完成后重写 manifest：全部还原则删掉 `manifest.json`，否则重写条目并追加 note「restored N item(s) at <ISO>; M remain in this batch」。失败条目**保留在 manifest 里**——「批次不得声称持有它没有的东西，也不得停止声称它持有的东西」（`lib/restore.js:231-268`）。**一条例外：被重建出来的记录即便一条都没还成也落盘**（`lib/restore.js:239-240`）——这样那个批次从此不必再靠推断描述自己；而删 `manifest.json` 遇到 `ENOENT` 不算失败（重建批次本来就没有这个文件），记为 `alreadyAbsent`（`lib/restore.js:247-252`）。

### 4.8 purge：唯一销毁数据的操作

`lib/purge.js` 头部四条设计约束（`lib/purge.js:4-20`）：

- **永不自作主张**：没有定时器、没有计划、没有「清理旧批次」路径；
- **确认不是本模块的事**：界面问「permanently delete N items, X MB」并传 `confirmed: true`；`purgeBatch` 缺这个字段一律拒绝，理由「a permanent delete requires an explicit confirmation; this call did not carry one, so nothing was touched（the interface is responsible for asking the user first）」（`lib/purge.js:101-113`）；
- **先报字节再删除**：`describePurge` 给出 `wouldDestroy` =「N item(s), M file(s), X B」（`lib/purge.js:62-114`）；
- **拒绝自行解释**：有内容没 manifest 的批次报为 `incomplete`，**不按名字删除**；只有显式「删除这个目录」的请求才碰它，且那个请求会列出即将销毁的东西（`lib/purge.js:193-256`）。

**「说不清内容」的那一行也给出真实项数（issue #1 修复之三的顺带结果）。** 清单缺失的批次，`describePurge` 与 `listBatches` 用同一套 `reconstructEntries` 从布局读回条目：`entries` 从 `null`（界面显示 `?`）变成真实项数，`sessionIds` 给出推断值，`reconstructed: true` / `recoverable: true`，`wouldDestroy` 前缀写明「N reconstructed item(s)，…」，理由行写明「N item(s) were read back from the batch layout and can be restored」（`lib/purge.js:69-98`、`lib/purge.js:233-255`）。**清单存在但损坏的批次仍然报 `entries: null`**——那种情况不该用推断值掩盖（`lib/purge.js:69-99`）。客户端因此不需要为这件事改动：条目计数本来就渲染 `batch.entries`，`?` 与数字走的是同一条通路（`lib/client.js:954`），恢复按钮本来也无条件渲染（`lib/client.js:970-985`）。

`pruneEmptyParents !== false` 时，从**批次的父目录**（隔离区一侧）清空目录——注释解释为什么不能从批次目录本身走：批次目录刚被删掉，走它什么也删不掉，实测第一版就是这样，用户清空一切后仍看到隔离区目录（`lib/purge.js:123-131`）。

> **不存在自动清理，这是决定而不是遗漏。** `AUTOMATIC_PURGE_IMPLEMENTED = false`（`lib/trash.js:643`），注释原话：「an automatic purge is a delete path with no user in front of it, and this plugin's contract is that nothing is destroyed except by a person who asked for it … `purgeBatch` cannot be reached from any scheduled path」。`GET /trash` 把这个事实作为字段报给界面（`lib/routes.js:571-577`）。

### 4.9 到底有没有东西被直接销毁

有，而且只有这些：

| 位置 | 销毁什么 | 触发条件 |
|---|---|---|
| `purgeBatch` → `removeTreeVerified` | 整个批次目录 | 人点名批次并确认（`lib/purge.js:101-147`） |
| 跨卷移动的 fallback | 原件（在副本按字节校验通过之后） | `EXDEV`，`lib/trash.js:507-591` |
| `restoreBatch` 全部还完 | `manifest.json` 一个文件 | 批次空了，`lib/restore.js:239-253` |
| `pruneEmptyDirs` | 空目录（`rmdirSync`，不碰文件） | 还原或清空之后 |

**除此之外，一切「清理」都是搬动。** 这条有代码可查：整个插件的写入作用域只有隔离区（`lib/trash.js:48-50`），路由头部的措辞是「No route writes outside `<home>/.dsh-reclaim-trash/`. The plugin's only mutating operation is moving data INTO the quarantine; nothing destroys data.」（`lib/routes.js:39-43`）。

---

## 五、安全保证

### 5.1 HTTP 面

- **所有路由必须在 `/api/` 之下，且必须经 `ctx.connection.fetch.register` 注册。** 只有这个前缀能让宿主的 Host/Origin 围栏与 cookie 认证挡在 handler 前面；`ctx.webServer` 的路由**不带认证**，「a plugin that can delete data behind an unauthenticated route can be triggered by any page the user happens to visit」（`lib/routes.js:9-16`）。注册时对每条路由调用 `assertApiPath`，不合规直接抛错（`lib/routes.js:80-88`、`lib/routes.js:466`）。
- **GET 永不改任何东西**；**每个 POST 都要求 body 里 `confirm: true`**，缺字段返回 **400 并附「会销毁什么」的描述**，因为那正是确认对话框需要的文本（`lib/routes.js:18-29`）。`POST /delete` 另接受 `dryRun`：「asking『what would happen』is never the same request as『do it』」。
- 事实缓存**只在内存**：持久缓存会过期并授权错误删除（`lib/routes.js:30-37`、`lib/routes.js:284-341`）。
- **首屏可以早于判词，但不可以冒充判词。** `GET /classify?preview=1` 只读「便宜的一半」——会话列举、附件遍历、缓存报告，**不打开任何会话日志**（`scanCheapFacts`，`lib/routes.js`）。它照样跑一遍分档以保持行形状一致，然后**把结果整体改标**：`pending: true`、每行 `tier: 'pending'`、`selectable: false`、`batchClearable: false`、`dedupCount` 与 `freedByDeletingBytes` 为 `null`（不是 0——0 会读成「没有」）、`tiers.sessions` 只有 `pending` 一档、`families` 为空（家族来自引用图）。理由：不带引用图的档位不是答案，所以一个档都不许声称；而任何 `pending` 行都不可选，**两段回答之间的空档不能被用来删任何东西**。预览与紧随其后的完整分档共用同一份便宜事实（`cheapFactsFor`），两次回答只付一次列举；删除路径的前置检查不受影响（见 §4.4、§4.5）。
- 批次名经 `resolveBatchDir` 解析，越出隔离区即抛错「refusing to operate on X: it is not inside the quarantine」——这是防止请求点名 `sessions/` 的边界（`lib/routes.js:344-360`）。

### 5.2 Agent 侧只有只读工具

- 工具名 `reclaim_audit`（`lib/tool.js:41`），参数只有三个：`thresholdDays`、`limit`、`tier`（`lib/tool.js:49-65`）。**没有** path、sessionId、delete/restore/purge、dryRun；参数集在单测里被断言为闭集（`lib/tool.js:12-20`）。
- 自带声明：「This tool is READ-ONLY and cannot delete, move or restore anything: it has no parameter for it. Destruction happens only in the settings interface, where a person confirms it.」（`lib/tool.js:68-70`）返回值里 `cannotDelete` 再重复一次（`lib/tool.js:241-244`）。
- 审计失败**报为失败**，而不是「没什么可清」：`throw new Error('the audit could not be produced: …')`（`lib/tool.js:176-179`）。
- 部署没有 tools 服务时就不注册，并给理由（`lib/tool.js:262-270`）。`inject` 只声明 `connection`（`lib/index.js:33-34`），attachments 与 tools 都走 `ctx.get`，否则缺服务的部署会整个插件加载失败（`lib/index.js:13-22`）。

### 5.3 决策当下的活态

活态必须在**使用当下重读**，不能复用快照：实测 `running` 窗口可以短到约 117ms（`lib/liveness.js:1-31`）；`probe(id)` 在一次分档里被调用两次，一次分档、一次第二遍，报告里没有任何活态值是复用快照（`lib/classification-report.js:1-26`）；单条删除也现读（`lib/delete-session.js:230-243`、`lib/delete-session.js:314` 之后的 `planSessionDelete`）。会话表里的 `live` 位与探针结果允许合法不同，差异记为 drift，**以探针为准**（`lib/sessions.js:20-33`、`lib/sessions.js:418`）。

### 5.4 「确认」在界面上的实际形态

- 批量清：勾选 `safe` 行 → 按钮文案「清理所选 N 项（进隔离区，可恢复）」+ 注「只会搬进插件自带的隔离区，不会销毁任何东西」（`lib/messages.js:43-145` 对应键，`lib/client.js:625`）；
- 需确认档：无复选框，「仍要清理…」展开后列出阻塞条件与家族规模，按钮「确认清理这一族」；家族整族一起动（`lib/client.js:755-790`、`lib/client.js:1081-1095`）；
- 危险档：复选框禁用（`lib/client.js:674-690`）；
- **参考图未读完时（冷启动首屏）**：表格照常显示标题与「已归档 / 归档状态未知」徽章，但分档标题写作「判定中…」、每行是**禁用**的 `pending` 复选框、行内只报「大小 / 未活动天数 / 判定中」（图片张数、删掉可释放、共享张数都来自引用图，此时**不显示**而不是显示 0）、顶部三个数字显示 `—`、清理按钮位置换成一句「参考图读完前不提供任何清理操作」（`lib/client.js` 的 `renderPending` 与 `renderRow` 的 `pending` 分支）。参考图读完后的完整分档自动替换这一屏。
- 永久删除：**唯一使用浏览器原生 `window.confirm` 的地方**，先报「N 项 · X」再问，标题「彻底清空（不可恢复）」，正文「将永久删除 N 项、X。这不进回收站，无法撤销。」（`lib/client.js:1121-1126`、`lib/client.js:1421-1424`）。而且 `POST /purge` 会在缺少 `confirm` 时把 `wouldDestroy` 一并返回，界面据此显示数字（`lib/routes.js:619-637`）。

### 5.5 这些保证是怎么被验证的

上面每一条原本只能靠读代码得出——上游仓库里没有测试。本仓库补上了两层闭环，结论现在可以自己跑一遍：

| 命令 | 层次 | 它证明什么 |
|---|---|---|
| `npm test` | 单元，`node:test`，**零依赖** | 被测试钉住的那几条行为 |
| `npm run test:host` | 真宿主在环 | 插件真的挂得上，且宿主具备它声明的每一项能力 |
| `npm run test:desktop` | 真宿主在环 + 对活 desktop profile 的只读断言 | 宿主闭环那一整套，外加「桌面端不需要专门适配」（§9 第 8 条） |
| `npm run test:all` | 前两层 | 先单元、后宿主。**不含** `test:desktop`——它要求这台机器装了桌面端 |

**为什么闭环要先修一个别的东西。** `lib/` 里唯一的裸 import 是 `@deepseek-ai/dsh-home-paths`（`lib/paths.js:32`），它只存在于宿主的 asar 内，所以在宿主体外**一个模块都加载不了**：

```
ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-home-paths'
        imported from .../dsh-reclaim/lib/paths.js
```

`test/hooks/` 用一个解析钩子把这**一个** specifier 映到测试替身（`test/hooks/peer-double.mjs`），生产代码一行不改。替身只实现被消费的三个导出，并且**故意不导出 `dshCachePath`**——让默认布局是确定的，而不是取决于替身恰好定义了什么。要测新布局的用例走代码里已有的注入点 `detectRequestImagesLayout(home, homePathsNs)`（`lib/paths.js:109`，其 JSDoc 自称 "injectable so tests can pin the feature detection"）。

**宿主那一层刻意不用替身。** 它证明的是宿主真的接受这份 manifest 与 patch，这是替身永远证不了的。脚本还显式断言 stderr 里没有 `did not activate`——**宿主带着一个挂掉的插件条目也能正常启动**，不断言这一条就会假绿。

**这一层原本只打印、不断言，等于把最该守的那几个值看成了装饰。** `ok` 与 `capabilities` 由后端能力探测产生，**路径解析出错不会让它们变红**，所以布局回归可以在这一层一路绿着过去。现在 `scripts/verify-host.sh` 对 `families[request-images].layout` 下三条值取等号断言：`selected === "cache"`、`dshCachePathExported === true`、`anomaly === null`（脚本自建全新 home，无历史残留，所以可以取等号而不是「非空」）。这三条**只有在这一层才验得到**——单元那层把 `@deepseek-ai/dsh-home-paths` 换成了替身，真包的契约它证不了。

**替身还有一处覆盖不到的地方，现在补上了。** 宿主那层的前四步只打 `/health`，而 `/health` 走的路径是 `resolveLayout`（`lib/paths.js:291`，只把 `trash.root` 拼成字符串），**不会调用 `canonicalizeWatchPath`**——它要到 `makeIsInsideTrash` 内才惰性调用（`lib/paths.js:337`、`lib/paths.js:351`），也就是只有在真的移动或还原时才会执行。第五步（`scripts/verify-clear.mjs`）正是这样一次真实的移动＋还原，所以 §8.6 修复所依赖的那个函数现在**在真包上被走到并给出了正确的否定判定**（判定为 `true` 会以「已经在隔离区里」拒绝，移动就不会成功）。仍未实测的是它的边界：不存在的路径、符号链接、权限错误——那些走 `catch` 返回 `true`（fail-closed，拒绝移动），方向安全但未验证，记在 §9 第 9 条。

`scripts/verify-host.sh` 自带一道拒绝真实 home 的守卫：

```sh
case "$VERIFY_HOME" in
  "$REAL_HOME"|"$REAL_HOME"/*) echo "REFUSING: …"; exit 2 ;;
esac
```

默认在 `/tmp/dsh-reclaim-verify` 下建一个一次性 `web` profile、跑完 `rm -rf`；`KEEP_HOME=1` 保留它，那个 profile 可以继续用来验别的插件。它**不碰** `desktop` profile。

**桌面端那一层（`scripts/verify-desktop.sh`）。** 它存在的理由很具体：`--profile desktop` **根本无法从命令行启动**，所以「在真 desktop profile 上跑一遍」这件事做不到，而在活着的那个上跑又会抢它写死的 19387 端口、并把插件装进用户真正在用的 profile。于是它改为四步——①只读检查活 desktop profile **自己声明的 manifest**：`dsh.profile.bundles` 的头两项必须是那两个官方 bundle，`dsh-desktop-host` **不能**出现在列表里（哪天成了成员，这个脚本就不再是忠实的检查，直接 FAIL），用户层 `cordis.patch.yml` 里**不能有 `insert:`**（它只有按 id 的 config 覆写，也就动不了提供者）。**`0.2.1` 起合成树不再落盘**——`cordis.yml` 只是四行注释加 `[]`，树在启动时由 bundle 列表加各 bundle 自带的 patch 现算——所以「五个服务由谁提供」这件事在这一步已经读不到，挪到了③；②断言 `lib/*.js` 里除 `DSH_HOME` 外不读任何环境变量、也不提 `DSH_PROFILE` / `profileContext`（多出一个就 FAIL——那会是一个可能在两端不同的新输入，必须单独验）；③在一个从 `web` 模板克隆的一次性 home 里（`desktop-clone`，端口 19400）跑完整闭环，再对这个 clone 跑 `--dump-config`，把五个提供者逐个归到 `dsh-base` / `dsh-web-app`（缺一个、或归到别的 bundle，都 FAIL），也就是把②③两条**做出来**而不只是读出来；④前后各取活 desktop profile 三个文件的 `shasum -a 256` 并比对，**这就是「没有污染全局环境」的断言**。它自带与 `verify-host.sh` 同款的拒绝真实 home 的守卫，并默认保留 home 供复用。详见 §9 第 8 条。

---

## 六、已知边界与明确不清理的东西

### 6.1 先看这个插件自己声明的极限

`COVERAGE_KNOWN_LIMIT` 原文（`lib/coverage.js:269-274`，每次扫描都带在报告里）：

> Completeness is proven relative to the READABLE log. This host exposes no stored event count (absent on both `sessionPersistence.list()` and `stat()`), and a log truncated at a zstd frame boundary reads as a legitimately shorter or empty log — **measured: a 193-byte remnant of a 1.9 MB log read as "0 events, contiguous, no error"**. No signal available here distinguishes that from a genuinely short session.

也就是说：**一个在压缩帧边界被截断的日志，会被读成一个合法地更短或空的日志，本机没有信号能把它和「本来就很短的会话」区分开。** 四个检查里的 `services` 与 `extraction` 对应失效模式 2（读取成功却什么都没解析出来），`read-paths` 与 `atomicity` 对应失效模式 3（日志截断 / 读取中断）（`lib/coverage.js:53-58`）。

### 6.2 明确不清理的东西

| 不清理 | 代码依据 |
|---|---|
| 日志（会话日志之外的其他日志） | 全库没有任何规则指向任何日志路径；插件只处理 §1 列出的族与会话目录 |
| 临时文件（**除了**附件暂存区） | 见下方「例外」 |
| 备份目录 | 同上，没有任何规则指向备份路径 |
| `profiles/` 下的插件依赖 | 本插件的 family 只覆盖 `<home>/attachments/v1/*`、`<home>/cache/attachments/request-images`、`<home>/storages/session_projcache/sessions`、`<home>/sessions/*`；`profiles/` 从不出现 |
| 定时 / 自动清理 | `AUTOMATIC_PURGE_IMPLEMENTED = false`（`lib/trash.js:643`），`purgeBatch` 无法从任何定时路径抵达 |
| 远端 / 共享存储后端 | 探针失败则**带着陈述的理由关掉**枚举与孤儿判定（`lib/backend-check.js:179-204`） |
| 用户没有点名要删的任何东西 | 唯一写入动作是「把人点名的那几件搬进隔离区」 |

> **例外（README 没提）：`<home>/attachments/v1/tmp` 是会被清的。** `tmp` 是一个已定义族，性质是「staging area for atomic writes」（`lib/paths.js:68-73`），它在缓存族行里被当作 `staging-leftovers` 判为 `safe` 且 `batchClearable = true`（`lib/classification-report.js:280-304`），消息是「暂存残留：写入被中断留下的半成品」（`lib/classify.js:92`）。README 的「不清理临时文件」应读作「不碰别处的临时文件」，而不是「附件暂存区也不碰」。**前提是它被枚举出来了**：只有 `checkAttachmentBackend` 确认 store 是宿主文件支撑且根在扫描树里时才会枚举，否则整行是 `unclassified` 且没有复选框——`lib/classify.js` 的 `cache-family-not-enumerated` 说的就是这件事。

### 6.3 其他边界

| 边界 | 后果 | 依据 |
|---|---|---|
| 投影缓存按**默认** storage-json 布局判定 | 宿主若迁移过 `storage-json.root`，孤儿缓存检测**不覆盖**（storage 服务不暴露根路径） | `lib/caches.js:39-42` |
| `file-objects` / `files` 两族已接入引用图谱 | 零引用孤儿可安全清理，双硬链接协同移入隔离区与恢复 | `lib/classification-report.js`、`lib/clear-objects.js` |
| 归属未定义的族外对象 | 恒 `danger`，不提供清理 | `lib/classify.js:403-421` |
| 附件族只校验有官方文档的形状 | `request-images` 刻意不校验（键是请求变体身份而非内容摘要） | `lib/attachments.js:56-61` |
| 目录深度上限 12 | 更深的子树记为 `uncertain`，且**排除**在族总数之外 | `lib/attachments.js:46`、`lib/attachments.js:93-159` |
| 符号链接 / junction | 扫描与复制都**永不跟随**；扫描记 `nonRegular`，复制则拒绝删除原件 | `lib/attachments.js:93-159`、`lib/trash.js:371-427` |
| 族根读不到 | `enumerated = false`，因此该族不进安全档 | `lib/attachments.js:175-319` |
| 对账规则 | 每族计数必须与 `dir /s /a-d <family>` 一致；**盈余永远不可接受**，短缺只在被拒计条目覆盖时可接受 | `lib/attachments.js:175-319` |
| 删除已归档会话 | 它的 id 会永远留在注册表全局的归档集合里（官方 API 没有 unarchive），已知代价约 44 字节/id，只报告不修复 | `lib/workspace-sync.js:11-15`、`lib/workspace-sync.js:183-238` |
| 后台任务归属 | 服务缺失时报 `unknown` 而不是「不拥有任何任务」；仍拥有任务的会话不动 | `lib/workspace-sync.js:247-278` |
| 无法解释的对象 | 「存在于磁盘但从未被日志引用」的对象**只报告不分档**——引用图由日志构建，解释不了一个没人提及的文件 | `lib/classification-report.js:388-397` |
| 两个读取器不一致 | 只要有一边读出而另一边没有的引用，该会话的覆盖率就是 `unknown` | `lib/coverage.js:104-131` |
| 跨卷移动 | 不是原子的，退化为 copy → 校验 → unlink | `lib/trash.js:27-45` |
| 观测租约未释放 | 该会话的 `atomicity` 直接不通过（泄漏的租约会在宿主整个生命周期里钉住内存或所有权） | `lib/coverage.js:232`、`lib/observe.js:18-20` |

---

## 七、平台与布局差异

### 7.1 请求图片缓存有两套布局，按「运行中宿主的写入方」选择

`:ref` 族目录在宿主版本之间搬过家，所以它的位置不是常量（`lib/paths.js:39-47`、`lib/paths.js:109-221`）：

- legacy 候选：`<home>/attachments/v1/request-images`；
- cache 候选：`<home>/cache/attachments/request-images`。

选择依据是**运行中宿主的写入方，而不是目录是否存在**：老到没有 `dshCachePath` 的宿主不可能是写 `cache/` 树的那一个，所以别的版本留下的陈旧 `cache/` 目录不能胜出（`lib/paths.js:76-93`）。

- `hasDshCachePath = typeof namespace.dshCachePath === 'function'`（`lib/paths.js:120`）；
- 该导出在这台机器的构建上不存在，**签名不可观测**，所以防御性地试两种调用形状（`dshCachePath(join('attachments','request-images'))` 与 `dshCachePath()`），只接受绝对路径字符串（`lib/paths.js:125-150`）；
- 返回值必须落在 `<home>/cache` 之下（`isUnder` 用 `path.relative` + 父级遍历检查，能挡住共享前缀的兄弟目录与盘符变化），否则**拒绝跟随**、降级 legacy 并记录 anomaly（`lib/paths.js:151-158`、`lib/paths.js:223-238`）；
- 两个候选的存在性总是作为证据报告；选中目录不存在而另一候选存在时也产 anomaly：「the stale one likely comes from a different host version; investigate before clearing」（`lib/paths.js:191-209`）；
- 返回 `{selected, selectedPath, reason, dshCachePathExported, dshCachePathResolved, dshCachePathError, candidates, anomaly}`（`lib/paths.js:210-220`）。

### 7.2 Windows / 跨平台

- `batchId` 用 `-` 替代冒号（`lib/trash.js:99`）；
- 卷根、盘符与 UNC 的处理在 `lib/trash.js:162-207`；
- 去重键统一 `resolve(path).toLowerCase()`（`lib/trash.js:714-721`）；
- 目录冲突报 `EPERM`、跨卷报 `EXDEV`，两条路径分别处理（`lib/trash.js:27-45`）。

### 7.3 隔离区归属判定按 realpath，且 fail-closed

`makeIsInsideTrash`（`lib/paths.js:331-367`）两侧都经官方 `canonicalizeWatchPath` 做 realpath 级归一化（能容忍尚不存在的尾段），再用 `path.relative` 比较；词法前缀会被共享前缀的兄弟目录与指向别处的符号链接骗过，realpath 形态不会。**分类跟随数据的物理位置，而不是到达它的路径**：隔离区内指向外面的 junction 解析到外面，故不算在内；外面指向隔离区内的 junction 算在内（两侧都有测试钉住）。

**错误策略是 fail-closed**：`canonicalizeWatchPath` 抛出（权限、文件形状的祖先等非 ENOENT 条件）时，该路径**算作在隔离区内**，即被排除在扫描之外——宁可少报，也不把一个读不到的路径当成活数据；不确定性通过 `onUncertain` 暴露而不是静默吞掉（`lib/paths.js:331-367`）。

### 7.4 版本支持

`engines.dsh` 与 `peerDependencies` 逐字相同（`package.json`）：

```
>=0.1.5-rc.1 <0.3.0-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0 || >=0.2.1-rc.1 <0.3.0-0
```

**这条声明在本仓库被改过两次，第二次是修第一次的错。**

原来的一版是 `>=0.1.5-rc.1 <0.2.0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.1.8-0`：`<0.2.0` 按字面把 0.2.0 整条线排除在外，它之所以还能装上 `0.2.0-rc.2`，是因为宿主用 `semver.satisfies(version, range, { includePrerelease: true })` 判兼容，而 `0.2.0-rc.2 < 0.2.0` 为真——**靠一个排序巧合放行，声明本身是错的**。

第一次修改把它换成了 `>=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`，并顺手断言「后两段与第一段完全冗余」。**这个断言是假的，而且换出来的范围是一次回归**：`<0.2.0-0` 排掉的不只是 `0.2.0` 线，还包括 `0.1.6-0`、`0.1.6-rc.1`、`0.1.7-0`、`0.1.7-rc.1`——在**默认语义**下（也就是任何人拿 `semver.satisfies(v, range)` 或某个不传 `includePrerelease` 的消费者来问的时候）这四版全部落空，而 `0.1.7-rc.1` 正是 README 版本表里列为「已验证」的那一版。原范围之所以收得住它们，靠的恰恰是那两段被删掉的 `>=0.1.6-0 <0.1.7-0` 与 `>=0.1.7-0 <0.1.8-0`，它们并不冗余。

现在的范围把两段显式补回来，并保留一条对 0.2.x 的兜底：默认语义下与原始范围在整条 0.1.x 线上逐格一致，另加 `0.2.0-rc.1` / `0.2.0-rc.2` / 整个 `0.2.x`；拒收 `0.2.0-0`、`0.3.0-rc.1`、`0.3.0`、`1.0.0`。唯一一处与原始范围仍然不同的是 `0.1.8-rc.1`（两边都不收），故不构成回归。

第三次修改（在 `0.2.1-rc.3` 上实测之后）只是照同一条规则补了一句 `>=0.2.1-rc.1 <0.3.0-0`：`0.2.1-rc.1` 与 `0.2.1-rc.3` 的 tuple 是 `0.2.1`，`>=0.2.0-rc.1 <0.3.0-0` 在**默认语义**下对它们都是 `false`（实测），而它们正是这一轮验证过的宿主。补完之后的默认语义矩阵：`0.1.5-rc.1` / `0.1.6-0` / `0.1.6-rc.1` / `0.1.7-rc.1` / `0.1.7-rc.2` / `0.2.0-rc.1` / `0.2.0-rc.2` / `0.2.0` / `0.2.1-rc.1` / `0.2.1-rc.3` / `0.2.1` / `0.2.2` 全为 `true`；`0.1.8-rc.1` / `0.3.0-0` / `0.3.0-rc.1` / `0.3.0` / `1.0.0` 全为 `false`。**这不是一次性修补：每出一个新 minor，都得再补一句。**

用 `<0.2.0-0` 而不是 `<0.2.0`：prerelease 排序里数字标识符低于字母标识符，所以 `0.2.0-0 < 0.2.0-rc.2`，`<0.3.0-0` 同理把 `0.3.0` 线整个挡在外面。

顺带说明：**两个字段的强制力不同，别按同一句话读。**

- **`engines.dsh` 在安装期是真的被检查的。** `@deepseek-ai/dsh-plugin-manager` 的 preflight 跑 `evaluatePluginCompatibility`，不匹配就 `rejected(preflight, "nothing was installed")`。实测 `dsh plugin add` 直接报 `dsh: installation rejected: Plugin … is incompatible with dsh 0.2.1-rc.3: requirements {"engines.dsh":"…"} … dsh: nothing was installed.`；逃生舱是显式的逐版本豁免 `dsh plugin allow-version <pkg@version> --dsh-version <exact> --accept-risk`（配 `revoke-version` / `version-exemptions`），写进 profile 的兼容文件。判定时带 `includePrerelease: true`（`@deepseek-ai/dsh-app-boot` 的 `satisfies`），所以预发布版不会被保守范围挡住——但反过来，**范围写错时宿主也不会报错**，发现它的是默认语义的消费方（npm/pnpm 工具链、市场、第三方检查）。
- **`dsh.manifestVersion` 仍然是纯声明。** `0.2.1-rc.3` 的整棵宿主树里没有任何代码读它（grep 零命中）。宿主包文档那句 "Compatibility is declarative. Current installers and loaders do not enforce dsh.manifestVersion or engines.dsh." 现在只对后者成立。

**实测过的是 `0.1.7-rc.1`（上游自述）、`0.2.0-rc.2` 与 `0.2.1-rc.3`（本仓库，`npm run test:host` / `npm run test:desktop` / `scripts/bench-audit.sh`）；`0.1.6-*` 仍是推断。** 旧版本那条判据——「该版本是否导出 `dshCachePath`」——现在有答案了：**0.2.0-rc.2 导出它**，`/health` 报 `dshCachePathExported: true`。早先「这台机器的构建没有这个导出」是 app.asar 对普通 shell 不可见造成的**测量假象**。

---

## 八、代码与 README 的出入

这一节记录**代码与 README 说法不一致**的地方。其中 **8.5、8.6 与 8.8 已在本仓库修复**，条目保留是为了留下修复的判据与代价（8.8 里还有一半是刻意不做的，条目内写明）；其余各条仍然成立。

### 8.1 `/health` 报告的路径与 README 写的不同

README 的验证方法一节说「本插件在 `/health` 里报告 `layout.dshCachePathExported`」。实际上 `healthPayload`（`lib/routes.js:266-282`）的顶层是：

```js
{ ok, plugin, name, capabilities, home, attachmentsRoot, families, trash: { root } }
```

**没有顶层 `layout` 对象，也没有顶层 `dshCachePathExported`。** 该字段确实能通过 `/health` 读到，但位置是 `families[<请求图片族>].layout.dshCachePathExported`——因为 `resolveLayout()` 只给 `request-images` 这一个族挂上 `layout`（`lib/paths.js:271-284`）。用 README 里那个路径去取值会得到 `undefined`，于是「与目标版本不符」的判断会被误触发。要核对依赖层，请读 `families[].layout.dshCachePathExported`（或直接用 `detectRequestImagesLayout` 的返回结构，`lib/paths.js:210-220`）。

### 8.2 「不清理临时文件」与代码不符

README「不做的事」写「不清理日志 / 临时文件 / 备份目录」。代码里 `<home>/attachments/v1/tmp` 是**已定义族**（`lib/paths.js:68-73`），在缓存族行里被判为 `safe` 且 `batchClearable = true`（`lib/classification-report.js:280-304`），消息是「暂存残留：写入被中断留下的半成品」（`lib/classify.js:92`）。准确的表述应是：**插件会清附件存储的原子写暂存区，不碰别处的临时文件。**

### 8.3 分四级之外，代码还有第五类与两种行

README 说分四级。代码里除 `TIERS` 四个值之外还有：

- `reportOnly` 分组（`file-objects` / `files`），`tier: 'reportOnly'`，不在 `TIERS` 内（`lib/classification-report.js:39`、`lib/classification-report.js:412-430`）；
- 家族行（`kind: 'family'`，档位取自成员最差档，`lib/classify.js:431-465`）与缓存族行（`kind: 'cache-family'`，`lib/classification-report.js:280-304`）——它们也是行，但不对应任何单个文件或会话。

### 8.4 README 从未提到存在「永久删除」

README 的「它做什么」只说「清理**不是删除**，搬进隔离区可恢复」。但代码里有完整的永久删除通路：`lib/purge.js`、`POST /api/dsh-reclaim/purge`（`lib/routes.js:619-637`）以及界面上的「彻底清空这一批」／原生确认框「彻底清空（不可恢复）」（`lib/client.js:1121-1126`、`lib/client.js:1421-1426`）。README 说的「所有破坏性操作都要人在界面上明确确认」涵盖了它，但**「存在一个不可恢复的操作」这件事本身没有出现在 README 里**。这是本文档存在的主要理由之一。

### 8.5 「危险（不可清理）」只在界面层成立 —— **已修复**

**原状。** 档位计算给出 `selectable: false`（`lib/classify.js:250-253`），界面把复选框禁用（`lib/client.js:674-690`），但 `POST /delete` 不复核档位、引用、归档或阈值：`planSessionDelete` 的 blocker 只有活态与「目录找不到」。所以「危险」当时是一个「界面不提供清理入口」的档，**不是**一个「API 拒绝执行」的档。

**实质的洞只有一支。** `tier === 'danger'` 的判据是 `livenessBlocks || referencing.length > 0`。活态已经被 blocker 覆盖了，所以真正没人复核的是**引用**：一个被别的会话引用的会话，可以凭一个手写的 `{"sessionId": …, "confirm": true}` 被搬走。

**现在。** 引用关系与活态一样在决定的当下现读（`readReferences`，`lib/delete-session.js:276`），三条新 blocker 是 `reference-graph-unavailable`、`reference-graph-incomplete` 与 `referenced-by-other-session`。判档与拒绝共用同一条规则（`buildReferencingIndex` / `referencingSessionIdsOf`，`lib/graph.js:53-72`），从 `lib/classification-report.js` 里抽出来收成一处——两者必须永远一致，不一致时无人报警，而最坏方向的不一致正是「界面禁勾的会话被服务端放行」。

**这里曾经失败开放，是 review 抓出来的第二处洞。** 第一版修复只检查了 `graph.ok`，而 `buildReferenceGraph` 有两种失败形态：整张图读不出来时它给 `ok: false`，但**只读出一半时它给 `ok: true`**——`coverage.unknownSessions` 非空、`orphanDetermination.allowed` 为 `false`（`lib/graph.js:251`）。于是「有 1 个会话的关系没证出来」被读成了「没有别的会话引用它」，删除照做。判据因此收紧成一个具名谓词 `referencesProvenComplete(graph)`（`lib/graph.js:98`），成立条件是 `graph.ok === true && graph.orphanDetermination.allowed === true`；`readReferences` 里 `ok` 的含义也随之从「已建成」改成「**已证明**」。选 `orphanDetermination.allowed` 是因为它是两种失败模式下都正确的唯一字段（`unavailable()` 路径给 `false`、unknown 非空给 `false`、只有完全证成才给 `true`），而且 `lib/classification-report.js:163` 本来就拿它给孤儿档做闸门——这个谓词存在的目的是让两个读者一致，不是提供第二种意见。

两条 blocker 的**顺序是有意的：具体压过笼统**。在一张不完整的图上，「图没证完」与「确实有别的会话引用它」可以同时为真，而后者能指名道姓（`detail.referencingSessionIds`）让人去查，所以 `referenced-by-other-session` 排在前面。

`POST /delete`（`lib/routes.js:674-695`）把界面判过档的**同一代缓存事实**里的图传下去，一批删除只付一次扫描；扫描失败**不返回 500**，而是 fail-closed 拒绝——500 说的是「再试一次」，这里要说的必须是「别做」。`catch` 也不吞原因（`lib/routes.js:686-695`）：它交回一个图形状的 `{ ok: false, reason }` 而不是 `null`，这样操作员看到的是**这里真正发生的那个故障**，而不是下游重建图时撞上的第二个。不新增选项、不再扫第二遍，原因字符串就地拼。

**代价，说清楚。** 一条删除现在多付一次引用图读取（缓存命中时为零）；图读不出来的部署里，删除会从「照做」变成「拒绝」，这是有意的方向。**档位本身仍然不授权也不拒绝任何事**——`danger` / `confirm` / `safe` 依旧是界面语汇，服务端认的是它背后的事实。`body.risk` 是调用方自述，只记录不授权。

修复前的红证据（测试先于实现写下）：

```
✖ planSessionDelete refuses a session that another session references
    a session another session references must not be planned for a move; blockers were []
✖ deleteSession refuses a referenced session and moves nothing
    true !== false          ← ok:true，会话真的被搬走了
```

### 8.6 代码自己的实现与自己的注释/类型契约不一致 —— **已修复**

**原状（双重失效）——下面几处行号是修复前的位置。** `makeIsInsideTrash` 返回的是 **async 函数**（`Promise<boolean>`，`lib/paths.js:329-367`），而两处调用点拿 Promise 去和 `true` 比较，永远为假：

- `lib/trash.js:244`（`planMove` 的 `already-in-trash` 守卫）；
- `lib/restore.js:89`（`planRestore` 的 `target-inside-trash` 守卫）。

而且两处都还带一个 `options.isInsideTrash !== undefined` 前缀，**两个 HTTP 调用方一个都不传**（`lib/routes.js:590`、`:614`）——所以即使把比较修对，守卫照样不触发。`lib/restore.js:57` 的 JSDoc 还把参数类型声明成同步的 `(path: string) => boolean`，**正是这个错误类型让错误写法看起来是对的**。

**安全影响有限但不为零。** `lib/attachments.js:197` 是正确 `await` 的，所以「隔离区被排除在扫描之外」这条真正要紧的保证不受影响。失效的是两条纵深防御：移动时不会识别「源已在隔离区内」，还原时不会拒绝「原路径落在隔离区内」。第三条测试证明这不是理论风险：

```
✖ restoreBatch refuses to restore into the quarantine when the caller injects no predicate
    nothing may be restored into the quarantine / 1 !== 0
```

`restoreBatch` 在调用方不传谓词时，**真的把隔离区里的内容恢复回了原路径**。

**现在。** `planMove`、`planRestore`、`restoreBatch` 全部改为 `async` 并 `await` 谓词；`planRestore` 内新增默认绑定 `options.isInsideTrash ?? makeIsInsideTrash(options.layout ?? resolveLayout())`，守卫是 `if ((await isInsideTrash(target)) === true)`。默认绑定放在 `planRestore` 而不是各调用方，是为了让预览（`/trash/plan`）与执行（`/restore`）说同一件事——**一个与自己预览的操作不符的预览，比没有预览更糟**。修复后的位置：`planMove` 在 `lib/trash.js:246`，`planRestore` 在 `lib/restore.js:71`，`restoreBatch` 在 `lib/restore.js:151`，路由侧的 `await` 在 `lib/routes.js:590` 与 `lib/routes.js:614`。`lib/restore.js:57` 的参数类型也从同步的 `(path: string) => boolean` 改为 `(path: string) => Promise<boolean>|boolean`——**正是那个错误类型让错误写法看起来是对的**。

> 上面这些「修复后的位置」是当时的值；§8.9 那一轮的改动移了行，今天是：`planMove` 绑定与守卫在 `lib/trash.js:275-276`，`planRestore` 在 `lib/restore.js:81` 与 `:146`，`restoreBatch` 在 `lib/restore.js:196`，`deleteSessionItems` 的整批绑定在 `lib/trash.js:792`。

**那个 `!== undefined` 前缀后来也被拆掉了。** 修 async 比较时，`planMove` 保留了 `options.isInsideTrash !== undefined && …` 的形状，而 `planRestore` 改成了自绑默认值——同一个仓库里两个孪生函数用两种纪律。前缀的含义是「调用方没给谓词」等于「不设防」，**这正是这个守卫当初能一直是死代码的原因**。现在 `planMove` 也自绑默认值（`lib/trash.js:275`，导入加了 `resolveLayout`），与 `deleteSessionItems` 里已有的整批绑定（`lib/trash.js:792`）同形。本仓库内没有实际行为变化——`deleteSessionItems` 本来就为整批绑一个谓词传下去——改的是这个形状本身：**不传谓词不再等于不设防**。

**代价。** 三个规划函数从同步变异步，波及它们的所有调用方。备选的「加一个同步版 canonicalizer」被否掉了：那会让同一份判断有两份实现，而这份文档存在的理由之一就是两份实现会悄悄分叉。

### 8.7 `deleteSessionItems` 的注释与代码有一处小出入 —— **已修复**

注释说「if **nothing** moved, no manifest is written and the batch directory is removed again」。当时代码里 `moveable.length === 0` 的早退发生在 `mkdirSync(batchDir, …)` **之前**，所以不是「建了再删」，而是**根本不建**——行为更干净，注释略旧。

**现在这句话是字面成立的（issue #1 那一轮改的）。** 目录先被 `claimBatchDir` 认领（`lib/trash.js:626-699`），`moveable.length === 0` 的早退再调 `releaseEmptyBatch`：**只有当这个目录是本次调用创建的**才 `rmdirSync` 删回去（`lib/trash.js:884-907`、`lib/trash.js:708-715`）。复用来的目录一律不动——它可能是别的操作正在填的批次，也可能是唯一记着某些条目来路的目录。`rmdirSync` 本身还要求目录为空，所以「删回一个已经有内容的目录」在系统调用层也不可能。

（顺带一个容易看错的点：`createBatch`（`lib/trash.js:586-594`）里也有一处 `mkdirSync(batchDir, …)`（`lib/trash.js:592`），与本条无关；它按 instant 建目录，认领规则由 `claimBatchDir` 执行。）

### 8.8 分级与实际可执行能力之间有一处错位 —— **已修复**（本次最重要的发现）

**原状。在发布出去的那份代码里，唯一能被执行的动作是把会话目录（及其投影缓存）搬进隔离区。** 依据：

- `deleteSessionItems` 只有一个调用者，就是 `deleteSession`（`lib/delete-session.js:448`）；
- 它拿到的条目只有两种 `kind`：`'session'`（`lib/delete-session.js:350`）与 `'session-cache'`（`lib/delete-session.js:364`）；
- `lib/trash.js:65-71` 定义了 `attachment` / `cache` / `other` 三个子目录与对应 kind，`lib/manifest.js:306-315` 也为它们定义了映射，但**全库没有任何地方产生这三种 kind 的条目**（`grep` 结果只有 `classify.js` 里作为「行种类」的 `kind: 'attachment'` / `kind: 'cache'`，那是报告行的种类，不是待搬条目）；
- 唯一接受「要删什么」的路由是 `POST /delete`，参数只有 `sessionId`（`lib/routes.js:639-701`），没有接受附件 id 或缓存路径的路由；
- 界面只渲染 `report.tiers.sessions`（`lib/client.js:431`），检查框、批量清与「仍要清理…」三条通路最终都落到 `POST /delete` + `sessionId`。

**原状里有一句我说错了，这里更正。** 上面第二条原写「附件行、缓存族行、孤儿投影缓存行都会被标 `selectable` / `batchClearable`」。缓存那一半对：`cache-family` 行在 `family.enumerated === true` 时确实被判 `tier: 'safe'`、`selectable: true`、`batchClearable: true`。**附件那一半不对，而且不是「缺生产者」，是「被分级规则挡住」**：`classifyAttachment`（`lib/classify.js:296`）在 `entry.sessionIds.length > 0` 时加 blocker `referenced-by-session`，`tier` 因此是 `danger`；而它唯一的调用方喂的是 `graph.attachments`（`lib/classification-report.js:176`、`:246`），该图的每一个条目都在 `lib/graph.js:204-211` 由「某个会话提到了这个 id」创建并 `indexed.sessionIds.push(id)`，所以 `sessionIds.length >= 1` **恒成立**——**附件行恒为 `danger`，从来没有被标成可批量清理过**。连带地，`lib/classification-report.js:436-439` 的 `alreadyOrphanRows` / `alreadyOrphanBytes` 结构性恒为 0（`totals.alreadyOrphanAttachmentBytes` 永远是 0），`lib/recompute.js:170-172` 的 `if (referenced.size === 0)` 永不进入。会变成孤儿的对象走 `lib/recompute.js:179-190`：`tier: 'confirm'`、`batchClearable: false`、`cascade: true`，注释明写「It is NOT promoted into an already-safe row: it becomes a cascade item, shown to the user rather than swept silently」——**这是刻意的安全决定，不是遗漏**。

**现在：缓存那一半补上了通路，附件那一半维持「不提供」。** 新增的写入面只有一条：

- **`lib/clear-objects.js` 的 `planClearCandidates(rows, requestedIds)`**。调用方**只用 id 指名，永不提供路径**；路径由服务端从**刚分级的那一行**读出来（`row.facts.paths`，由 `lib/classification-report.js:274` 从 `onDisk.filesById` 推导）。`TRASH_KIND_BY_ROW_KIND = { attachment, cache, 'cache-family' }` 是 allow-list，新增行种类默认被拒，直到有人决定它该去哪；**会话行被拒**，码 `session-not-clearable-here`，文案指向 `POST /delete` 并说明理由——搬走目录只是删除一个会话的一部分，工作区 `sessionIds` 与后台任务归属还要一并处理，那条通路是 `POST /delete`，而且只有它。其余拒绝码：`invalid-id`、`unknown-id`、`kind-not-clearable`、`row-not-clearable`（带 `tier` / `tierReasons`）、`no-paths`、`nested-selection`。
- **`POST /api/dsh-reclaim/clear`**（`lib/routes.js`，`kind: 'write'`）。它**与 `/delete` 有一处刻意的不同**：`factsFor(..., rescan = true, ...)`——每次清理重新扫一遍。`/delete` 尊重界面渲染时那一代事实，因为会话的身份不依赖扫描；而这里**行同时提供判据（「这个对象无人引用」）与判据所指向的路径**，页面渲染之后新写入的会话能把一个孤儿变成被引用的对象，所以两者必须来自同一个瞬间。代价是每次清理付一次扫描。
- **全有或全无。** `plan.ok === false` 时 `items` 为空，路由返回 200 + `{ ok: false, error, refusals, move: null }`——不是 500（「没有这一行」是答案，500 说的是「再试一次」），也不是部分执行。「用户当作一次动作做出的选择被清掉一半」正是这个插件要避免的意外。同一文件被两个 id 各指名一次会先按 `resolve` 后的路径折叠成一项：那是「一项被说了两遍」，不是父子关系；而目录与它内部的文件**不能**同时选（`nested-selection`），否则还原时目录会回来而文件不会。
- **界面**（`lib/client.js`）：`report.tiers.caches` 与 `report.tiers.attachments` 现在有自己的卡片（`data-dshr-clearables`）。可清的行拿到可用复选框；不可清的行**照样列出并写明原因**（「没读到」是一个答案，而且正是它解释了为什么没有复选框）。批量按钮按 id 的来源分流：会话走 `/delete`，其余走 `/clear`；混合选择跑成一次动作、只出一条提示。

**这一条现在有实测。** 宿主闭环第 5 步（`scripts/verify-clear.mjs`，由 `scripts/verify-host.sh` 调用）在一次性 home 里种两个夹具文件，然后按顺序断言：族被分到 `tier=safe` / `batchClearable=true`；`POST /clear` 把它搬进隔离区且原路径消失；manifest 记下 `originalPath → relativePath` 与「是哪一行 id 触发的」；`POST /restore` **逐字节**放回原处。**最后一步是要害**：本插件的全部承诺是「清理是搬运不是删除」，而关于还原的承诺只有在真的还原过一次之后才算数。实测输出：

```
graded        : cache-family:request-images tier=safe batchClearable=true bytes=68
cleared       : 1 item(s), 68 B → /tmp/dsh-reclaim-verify/.dsh-reclaim-trash/2026-10-10T22-01-28
quarantined   : caches/tmp/dsh-reclaim-verify/cache/attachments/request-images holds 2 file(s), contents intact
recorded      : kind=cache bytes=68 note="cleared by id cache-family:request-images (cache-family)"
restored      : 2 file(s) back at /tmp/dsh-reclaim-verify/cache/attachments/request-images, byte for byte
```

**为什么这一条不能在单元层证明。** 缓存族只有在 `checkAttachmentBackend`（`lib/backend-check.js`）确认已挂载的 store 是宿主文件支撑、且根在这次扫描的树里时才枚举；单元层把 `@deepseek-ai/dsh-home-paths` 换成了替身，那里什么都不枚举，每一行都是 `unclassified`。**只有真宿主能造出可清理的行，因此也只有真宿主能证明清得掉、还原得回来。**

**代价与仍然不做的事。** `cacheBytes` 与零引用 `attachmentBytes` 现在均具备完整通路，`totalReclaimableBytes` 精准统计真实释放空间。零引用孤儿附件（`sessionIds: []`）在引用图谱完整时可进 `safe` 并提供勾选清理，而仍被现存会话引用的附件行维持 `danger` 绝不误删。未归类对象（`unknown`）维持只报告原则。

这一条我按代码逐处核对过；如果上游的私库里有额外的写入通路（例如另一个包的 CLI），那它不在本仓库内。

### 8.9 同一秒的多次移动共用一个批次目录并互相覆盖记录 —— **已修复**（issue #1 的根因）

**原状：一次「清理」把同一秒里先移入的条目变成了孤儿。** 三个各自都不算错的机制叠在一起：

- 批次目录名只有**秒**分辨率（`batchIdFor`，`lib/trash.js:105`），而 `deleteSessionItems` 直接拿 `batchDirFor(layout, instant)` 当目录用并 `mkdirSync(…, { recursive: true })`——**同名就共用，不管是不是同一次操作**；
- 界面的「清理」是**逐会话各发一次** `POST /delete`（`lib/client.js` 的 `moveSessions` 用 `ids.forEach` 串行链），于是一屏里选中 N 个会话、同一秒内跑完的 N 次移动共用同一个批次目录；
- 每次移动都 `writeManifest(batchDir, manifest)` **整份覆写**（修复前的 `lib/trash.js` 写入段）。后写的清单只记得自己那次移动的条目，**先移入的条目的 `originalPath` 就此消失**——那些文件还在批次目录里，但没有任何记录说它们从哪来。

随后只要恢复或清空掉清单里还记着的那部分，`restoreBatch` 会在 `remaining.length === 0` 时把 `manifest.json` `unlinkSync` 掉（这条行为本身是对的：批次空了）。批次于是变成「有内容、无清单」。而 `planRestore` 当时读不到清单就**直接返回失败**（修复前的 `lib/restore.js:82-84`，`reason: 'the batch has no manifest'`），界面把三个计数都渲染成 0——用户看到的就是「成功 0、受阻 0、失败 0」。

**这条规则其实写在注释里，只是从未实现。** `createBatch` 的 JSDoc 原话：「A new batch is only started when the caller asks for one with a distinct instant, or when the existing directory holds a manifest for a *different* session id.」而 `createBatch` 全库没有任何调用方，`deleteSessionItems` 走的是自己的 `mkdirSync`。**注释描述了有意的设计，代码没有执行它**——这是本条的起点，也是 §8.7 括号里那个「容易看错的 `mkdirSync`」真正的分量所在。

**安全影响：没有字节被销毁，被销毁的是来路。** 受影响的是**同一秒内进入同一批次、且不是最后一批**的那些条目：它们对插件而言不再可还原，而本插件的全部承诺是「清理是搬动，不是删除」。这比一次普通的 bug 更严重，因为它破坏的正是这个承诺成立所依赖的那份记录。

**现在，三条修复（各节详述）。**

1. **批次目录按操作认领**（§4.6）：`claimBatchDir`（`lib/trash.js:626-699`）用「非 recursive 的 `mkdirSync` + `EEXIST` 即重试」认领 `<stamp>` / `<stamp>-2` / …，并且只复用**同一次操作**的目录（空目录，或清单的 `sessionIds` 认这个会话；说不清内容的目录一律跳过）。`createBatch` 注释里那条规则由此真正生效。
2. **清单是并集**（§4.5）：写入改为 `mergeIntoManifest`（`lib/recover.js`），读回-合并-回读校验，**不再有「整份覆写」这条路径**。
3. **无清单批次可被读回并还原**（§4.5、§4.7、§4.8）：`reconstructEntries` 从镜像布局推回 `originalPath`，`planRestore` / `restoreBatch` 据此工作并把记录落盘，`listBatches` / `describePurge` 据此报出真实项数。**用户报告里那批数据正是靠这一条救回来的**——它已经躺在隔离区里而且没有清单，除了从布局读回来，没有别的办法能知道那两个会话原本住在哪。

**这一条有实测。** 新增 `test/batch-record.test.js`（6 条，`npm test` 共 41 条全绿）逐条钉住：

- 同一秒、两个不同会话 → **两个**批次目录（`<stamp>` 与 `<stamp>-2`），两份清单各记各的；
- 同一秒、同一会话的第二次移动 → 复用同一目录，清单条目数 **2**（不是 1）；
- 同一秒、无 `sessionId` 的两次移动（`/clear` 的形状）→ 复用同一目录，两条 `originalPath` 都在；
- 一个没有清单、但目录里有内容的旧批次 → 不被复用、不被写入，原样留着；
- 没有清单的批次 → `planRestore` 报 `reconstructed: true` 且能分出 `pending` / `target-occupied`，`restoreBatch` 真的把文件放回原路径，并把重建的记录写回批次；下一次规划它是 `reconstructed: false`（记录已落盘，不再是推断）；
- `listBatches` 对无清单批次报出**真实项数**、推断出的 `sessionIds` 与那句理由。

**代价与仍然不做的事。** 批次目录名不再是操作的唯一标识：同一秒可以有 `<stamp>`、`<stamp>-2`…，所以**任何把批次名当成时间戳解析的调用方都要容忍后缀**。路由侧不需要改动——`resolveBatchDir`（`lib/routes.js:346-362`）只做包含性校验、不校验名字形状（这也正是加后缀可行的前提）；但 `listBatches` 按 `batchId` **字符串**降序排（`lib/purge.js:255`），同一秒的多个批次之间的先后因此不保证（跨秒仍然正确）。重建的已知局限见 §4.5：镜像不记录条目边界，顶层只有目录的条目会被拆成多块还原；**一次移动自己的记录优先于这份猜测**（issue #12 修复，同样见 §4.5）——记着目录又记着它子目录的那种清单不再被写出来；同理，一次只搬走文件的清理也不再把它留守的目录记成条目（前提是该目录下的文件全部属于本次移动，见 §4.5）。

---

## 九、本文无法从代码确定的事项

1. **上游私库里的 `docs/safety.md` 写了什么。** 本仓库是 fork，上游把文档搬进私有仓库；本文完全从这份源码重建，与原文档的措辞、结构不保证一致。
2. **`@deepseek-ai/dsh-home-paths` 的 `dshCachePath` 真实签名。** 该导出在 `0.2.0-rc.2` 上**确实存在**（`/health` 报 `dshCachePathExported: true`，`layout.selected: 'cache'`，路径解析正确，`anomaly: null`），所以「这个版本有没有它」不再是未知。但代码是防御性地试两种调用形状的（`lib/paths.js:120`、`lib/paths.js:125-127`），**哪一种才是宿主真正支持的**仍然看不出来——两种都能得出正确路径时，从外部无法分辨。
3. **宿主 `0.1.6-*` 的实际行为。** README 自述是推断、未实测；实测过的版本是 `0.1.5-rc.1/2/3`、`0.1.7-rc.1`（上游）、`0.2.0-rc.2` 与 `0.2.1-rc.3`（本仓库）。
4. **界面（`lib/client.js`，1672 行）的完整交互。** 我只读了与安全有关的路径：三档控件渲染、批量清、家族复核、还原、永久删除的原生确认框。其余界面行为（视图切换、折叠、状态刷新）未审阅，可能还有与安全相关的细节。
5. **`purge` 之后隔离区根目录是否总被清掉。** 代码意图明确（`pruneEmptyDirs(pruneFrom, {keepRoot:false})`，`lib/purge.js:123-131`），但「清空后根目录一定消失」依赖文件系统在那一刻允许 `rmdir`；`ENOENT`/`ENOTEMPTY` 都不算失败（`lib/restore.js:283-311`），所以根可能合法地留下。我没有在真机跑清空来确认。
6. **附件/缓存清理通路是「尚未实现」还是「已被移除」。** 这一条现在有答案了：`git log -S "attachment: 'attachments'" -- lib/trash.js` 只命中引入搬运原语的那一个提交（`d41600f`「feat: 隔离区搬运、清单、恢复与彻底清空」），`git log --all -S "kind: 'attachment'"` 与 `-S "attachmentId:"` **零命中**。三个子目录是跟着搬运原语一起、**作为预留结构引入的，从未有过生产者**。所以是尚未实现，不是被移除。
7. **`sessionIds` 之外的记账残留会不会影响宿主的其他行为。** 删掉已归档会话会在注册表全局的归档集合里留下 id（`lib/workspace-sync.js:11-15`），代码报为 `dangling`；宿主之外还有什么组件会读那个集合，本仓库看不出来。
8. **`desktop` profile 上的真机行为 —— 已推进到「没有 desktop 专属的东西需要适配」，并把它做成了断言（本条保留原状记录）。** 原状：所有实测都在一个一次性 `web` profile 里做的（`scripts/verify-host.sh`）；`desktop` profile 由 Electron 独占，没有在活着的桌面 profile 上跑过任何一次清理；「两端在这个插件的依赖面上应该没有差别」是推断，不是实测。现在有四条证据。①**`--profile desktop` 无法从任何命令行启动**：`rejectElectronProfile`（`@deepseek-ai/dsh/lib/bin.js:35-37`）内容是 `if (profile.toLowerCase() === "desktop") program.error(...)`，它在 profile action（`:112`）里**没有任何开关保护**，只有 `plugin` 子命令那次调用（`:119`）带 `if (!manageDesktopProfile)`——所以 `manageDesktopProfile: true` 只解锁 `dsh plugin --profile desktop`，不解锁启动。实测两次：`ELECTRON_RUN_AS_NODE=1 … --profile desktop --dump-config` 与直接 import 后调 `runDesktopCli()` 都报同一条错。真正的启动器是 carrier：`dsh-desktop-host/lib/index.js:226` 的 `main()` 自己调 `runProfile`，绕过 `parseDshArgs`，并把 `--no-open --port 19387` **写死**（`:235`）。②**carrier 不是 profile 成员**，它从外面叠上去，所以 profile 的组成就是它自己声明的 bundle 列表（活的那份声明 16 个：两个官方 bundle 打头，后面 13 个第三方插件与 1 个官方按需 bundle `@deepseek-ai/dsh-experimental-auto-review`——它在 `dsh.profile.bundles` 里但不在 `dependencies` 里）。③**它需要的每个服务都由那两个官方 bundle 提供**。`0.2.1` 起这条不能靠读文件了：合成树不再落盘（`cordis.yml` 只是四行注释加 `[]`），改由 `--dump-config` 在一次性 home 的克隆上现算——`sessions` / `attachments` / `sessionQuery` / `tools` / `connection.fetch` 的提供者 `@deepseek-ai/dsh-session-persistence-jsonl`、`dsh-attachment-local`、`dsh-session-query-sqlite`、`dsh-tools`、`dsh-client-connection` 全部归到 `dsh-base` / `dsh-web-app`；那 13 个第三方 bundle 与那个官方按需 bundle 一个都没参与。④**插件分不出两者**：`lib/` 里 `DSH_PROFILE` 与 `profileContext` **零命中**，唯一读的环境变量是 `DSH_HOME`（`lib/paths.js:260` `const env = options.env ?? process.env`，`:262` `const envValue = env.DSH_HOME`），而 desktop 与 web 用的是同一个 `~/.dsh`。`scripts/verify-desktop.sh` 把①②③④都做成了断言（① 只读检查活 profile 的 manifest、② 扫 `lib/*.js`、③ 在克隆出来的一次性 home 上跑完整闭环并用 `--dump-config` 归因五个提供者），**前后比对活 desktop profile 三个文件的 sha256** 来证明整个过程没有碰过它——那是一条断言，不是承诺。**仍未做的**：在 Electron 窗口里真的点一遍（与第 10 条同一个缺口），以及那 13 个第三方 bundle 会不会影响本插件——它们不提供任何被依赖的服务，所以按当前证据不会，但那是从「提供者是谁」推出来的，不是实测出来的。
9. **`canonicalizeWatchPath` 在真包上的契约 —— 已由宿主闭环第 5 步覆盖（本条保留记录）。** 原状：两层闭环都只走到 `/health`，而 `/health` 经 `resolveLayout`（`lib/paths.js:291`）只拼 `trash.root` 字符串，不会调用它；它只在 `makeIsInsideTrash` 内部被惰性调用（`lib/paths.js:337`、`lib/paths.js:351`），也就是只有在真的移动或还原时才会执行；单元那层把它换成了替身（`test/hooks/peer-double.mjs`），宿主那层根本没触发它。现在 `scripts/verify-clear.mjs` 在真宿主上真的搬走一个缓存族再逐字节还原，两次判定都必须返回 `false` 才能成功（返回 `true` 会以「已经在隔离区里」被拒），所以这个函数在真包上**至少被走到并且给出了正确的否定判定**。仍然没验到的是它的边界：不存在的路径、符号链接、权限错误——那些会走 `catch` 分支返回 `true`（fail-closed，拒绝移动），方向是安全的，但**没有实测过**。
10. **面板的按钮到路由之间那一段，没有在真浏览器里点过。** 两半各自有证据：渲染由 `test/client-panel.test.js` 在 `node:vm` 里直接调 `renderPanel` 断言（复选框的可用/禁用、原因文案、卡片缺席），路由由宿主闭环第 5 步用 `curl` 断言。中间那段——`clearableIdSet()` 认不认得出这一行、`cleanUp()` 的分流会不会把 id 发到**对**的那条路由、混合选择时那条提示——只在假 DOM 上走过，**没有人真的在浏览器里勾一个缓存族再点批量清理**。要补上它需要在一次性 profile 里开真界面点一遍；本轮没做。
