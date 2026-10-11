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
- **可重建缓存是真的能清的**：派生图片、原子写暂存残留这些族会被枚举出来、搬进隔离区，再**逐字节还原**回原处。附件对象**不在此列**——它们全都至少被一个会话引用，所以分级规则恒判「危险」；这不是漏做，见 [docs/safety.md](docs/safety.md) §8.8
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
| `0.2.0-rc.2` | **已验证** | 本仓库实测：隔离 home 里的 `web` profile 装上本插件，能力探测 **7 present / 0 missing**，`request-images` 解析到 `cache/attachments/request-images`，`dshCachePathExported: true`。`npm run test:host` 每次都会重跑并**断言**这三条（以前只是打印） |
| `0.2.0-rc.2` **desktop 端** | **已验证到「不需要专门适配」** | 见下节。`npm run test:desktop` 把它做成了断言 |

### desktop 端：结论是**没有 desktop 专属的东西需要适配**

这一节的每一条都由 `npm run test:desktop` 断言，不是推断（下面引的宿主源码都在 `app.asar` 里，不在本仓库）：

- **`desktop` profile 无法从任何命令行启动**，这是设计而不是缺陷。`@deepseek-ai/dsh/lib/bin.js:35-37` 的 `rejectElectronProfile`
  对 `--profile desktop` 无条件报错，而它在 profile action（`:112`）里**没有开关保护**；`manageDesktopProfile: true`
  只解锁 `dsh plugin --profile desktop`（`:119`），不解锁启动。真正启动它的是 carrier——`dsh-desktop-host/lib/index.js:216`
  的 `main()` 自己调 `runProfile`，绕过参数解析，并把 `--no-open --port 19387` **写死**。所以第二个 desktop 实例
  必然和活着的那个抢端口，**任何隔离验证都不可能在真的 `desktop` profile 上做**。
- **carrier 不是 profile 成员**，它从外面叠上去。所以 profile 的组成就是它自己声明的 bundle 列表——两个官方
  bundle 打头，后面 13 个是第三方插件。
- **这个插件需要的每个服务都由那两个官方 bundle 提供**：读活 desktop profile 合成出的 `cordis.yml`（330 条），
  `sessions` / `attachments` / `sessionQuery` / `tools` / `connection.fetch` 的提供者分别是
  `@deepseek-ai/dsh-session-persistence-jsonl`、`dsh-attachment-local`、`dsh-session-query-sqlite`、`dsh-tools`、
  `dsh-client-connection`，**全部来自 `dsh-base` + `dsh-web-app`**，那 13 个第三方 bundle 一个都没参与。
- **插件分不出两者**：`lib/` 里 `DSH_PROFILE` 与 `profileContext` 零命中，唯一读的环境变量是 `DSH_HOME`
  （`lib/paths.js:260-262`），而 desktop 与 web 用的是同一个 `~/.dsh`。它的全部世界观就是 home 目录。

`npm run test:desktop` 因此做四件事：只读扫描活 desktop profile 的配置并断言上面第二、三条；断言 `lib/*.js`
里除 `DSH_HOME` 外不读任何环境变量、也不提 profile 名（那就是第四条，多读一个变量就 FAIL，因为那会是一个
可能在两端不同的新输入）；在一个从 `web` 模板克隆出来的一次性 home 里跑完整闭环；**前后比对活 desktop profile
三个文件的 sha256**——最后这条是「没有污染全局环境」的断言，不是承诺。它默认保留那个 home
（`/tmp/dsh-reclaim-desktop-verify`），可以继续用来验别的插件，并打印一条 `rm -rf` 供你随时完全清理。

> 仍未做的：在 Electron 窗口里真的点一遍（见 [docs/safety.md](docs/safety.md) §9 第 10 条），以及那 13 个第三方
> bundle 会不会影响本插件——它们不提供任何被依赖的服务，所以按当前证据不会，但那是从「提供者是谁」推出来的，
> 不是实测出来的。

> 版本范围的实现方式值得说明：**必须逐 minor 串 OR 子句**，
> `>=0.1.5-rc.1 <0.3.0-0 || >=0.1.6-0 <0.1.7-0 || >=0.1.7-0 <0.1.8-0 || >=0.2.0-rc.1 <0.3.0-0`。
> `engines.dsh` 与 `peerDependencies` 里这段文本**逐字相同**，避免两者漂移。
>
> 用 `<0.2.0-0` / `<0.3.0-0` 而不是 `<0.2.0` / `<0.3.0`：prerelease 排序里数字标识符低于字母标识符，所以
> `0.2.0-0 < 0.2.0-rc.2`，`<0.3.0-0` 把整条 `0.3.0` 线挡在外面。写成 `<0.2.0` 会**按字面把 0.2.0 排除在外**，
> 只因为宿主判定时带 `includePrerelease` 才侥幸放行 `0.2.0-rc.2`（详见 [docs/safety.md](docs/safety.md) §7.4）。

### 为什么不写成"看起来更合理"的范围

顺手记在这里，免得后人（包括我自己）把它"简化"回去：

- `>=0.1.5-rc.1 <0.3.0-0` **不是**"任意 0.1.x"。semver 规定：预发布版本只能被**同一 `major.minor.patch`
  且自身带预发布标识**的比较器放行——所以这一条在 0.1.x 的预发布里**只放行 `0.1.5-rc.1/2/3`**：实测
  `0.1.6-0`、`0.1.6-rc.1`、`0.1.7-0`、`0.1.7-rc.1`、`0.1.8-rc.1` 全为 `false`，而同一批的**稳定版**
  `0.1.6`、`0.1.7`、`0.1.8` 以及整个 `0.2.x` 稳定版为 `true`。想要别的预发布版，就得为它单开一条同 tuple 的子句。
- 同理 `>=0.1.0-rc.8 <0.2.0` 会**只剩 `0.1.0-rc.8` 一个版本**——这正是 `dsh-lsp-actions` 记录过的
  "broke fresh tarball installs"。
- **这条已经真的踩过一次。** 曾经有一版把范围"简化"成 `>=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`，
  以为逐 minor 的子句是冗余的。它不是：在**默认语义**下（任何不传 `includePrerelease` 的消费者）`0.1.6-0`、
  `0.1.6-rc.1`、`0.1.7-0`、`0.1.7-rc.1` 四版全部落空，而 `0.1.7-rc.1` 正是上面版本表里列为"已验证"的那一版。
  所以 `>=0.1.6-0 <0.1.7-0` 与 `>=0.1.7-0 <0.1.8-0` 现在显式写在范围里；`>=0.2.0-rc.1 <0.3.0-0` 也是同样的
  理由——`0.2.0-rc.*` 是 tuple 为 `0.2.0` 的预发布版，只有同 tuple 且带预发布标识的比较器才放行它。

装好之后，**一条请求就能看出当前宿主对不对得上**——`/health` 的 `capabilities` 字段逐项列出本插件依赖的
宿主接口在不在（`ctx.effect`、`ctx.connection.fetch.register`、`ctx.get`，以及 `sessions` / `attachments` /
`sessionQuery` / `tools` 四个服务），每项都写明**缺了会坏什么**。版本对不上时，这是最快的诊断入口。
- 想表达多个 minor 的宿主，只能逐 minor 串 OR 子句，且**每出一个新 minor 要手加一句**：
  `>=0.1.5-rc.1 <0.2.0-0 || >=0.2.0-rc.1 <0.3.0-0`。
  注意**每条带止于下一个 minor**：写成 `<0.2.0` 会按字面把 0.2.0 整条线排除在外，
  写成 `<0.3.0` 又会悄悄囊括还没验证过的 `0.3.x`。
- `@deepseek-ai/dsh-home-paths` 的 `latest` dist-tag **是过期的旧版本**（`0.0.1-rc.3`），无范围的安装会解析到化石版本。

**验证方法**（要加新版本时照做）：换 CLI **不够**——插件从自己的安装位置解析依赖，所以必须**同时**让插件拿到那个版本的依赖树（例如在一个独立的 home 里，用该版本的 CLI 启动，并把依赖树一并指向该版本）。判据不能只看"能不能起来"，要看**依赖层是否真的换了**：要读的判据是 **`families[<请求图片族>].layout.dshCachePathExported`**——顶层并没有 `layout` 对象，照旧写法取值只会拿到 `undefined` 并误判成「版本不符」（见 [docs/safety.md](docs/safety.md) §8.1）。它在 `0.1.5` 上应为 `false`、在 `0.1.6+` 上应为 `true`——如果与目标版本不符，说明插件拿到的仍是旧依赖，**这次验证不算数**。

## 怎么自己验一遍

仓库自带两层闭环，都不需要额外依赖：

```sh
npm test            # 单元：node:test，零依赖
npm run test:host   # 真宿主在环：装一遍、启一遍、探 /health，再清一个缓存族并还原
npm run test:desktop # 上面那一整套，外加对活 desktop profile 的四条断言（只读）
npm run test:all    # 先单元、后宿主
```

`npm run test:host` 默认在 `/tmp/dsh-reclaim-verify` 下建一个**一次性 `web` profile**，跑完删掉；
`KEEP_HOME=1 npm run test:host` 保留它，那个 profile 可以继续用来验别的插件。它**不碰** `desktop` profile，
并且自带一道拒绝真实 home 的守卫——把 `VERIFY_HOME` 指向 `$HOME` 会被直接拒绝（退出码 2）。

`npm run test:desktop` 是宿主闭环的超集：它先只读扫描活 desktop profile 自己的配置并断言「插件要的五个服务
全由那两个官方 bundle 提供」，再在 `/tmp/dsh-reclaim-desktop-verify` 下从 `web` 模板克隆一个
`desktop-clone` profile 跑完整闭环（端口 19400，避开桌面端写死的 19387），最后比对活 desktop profile 三个
文件的 sha256 证明没碰过它。那台机器上没有 desktop profile 时它以退出码 3 跳过并说明原因。它**不**在
`test:all` 里——`test:all` 要在任何机器上都能跑，而这个脚本的前提是装了桌面端。

宿主那一层刻意**不用**测试替身：它证明的是宿主真的接受这份 manifest 与 patch。脚本还会显式断言 stderr 里
没有 `did not activate`——**宿主带着一个挂掉的插件条目也能正常启动**，不断言这一条就会假绿。

`/health` 里的路径解析结果也是**断言**出来的，不只是打印出来给人看：`request-images` 必须解析到 `cache`
候选、`dshCachePathExported` 必须为 `true`、`anomaly` 必须为 `null`。这三条**只有这一层验得到**——单元那层
把 `@deepseek-ai/dsh-home-paths` 换成了替身，真包的契约它证不了。加这三条之前它们只是三行 `console.log`，
而 `ok` 与 `capabilities` 由后端能力探测产生，**路径解析出错不会让它们变红**，所以布局回归能在这一层一路绿着过去。

宿主闭环的最后一步（`scripts/verify-clear.mjs`）是**唯一能证明这个插件的核心承诺的地方**：它在一次性 home 里
种两个夹具文件，断言缓存族被判 `safe` / `batchClearable`，`POST /clear` 把它搬进隔离区且原路径消失，
manifest 记下「哪一行 id 触发的」与 `originalPath → relativePath` 的映射，最后 `POST /restore` **逐字节**放回原处。
**最后一步是要害**：全部承诺是「清理是搬运不是删除」，而关于还原的承诺只有在真的还原过一次之后才算数。
单元层证不了它——替身不枚举附件后端，所以那里造不出任何一行可清理的行。

> 顺带说明为什么以前没有测试：`lib/` 里唯一的裸 import 是 `@deepseek-ai/dsh-home-paths`，它只存在于宿主的
> asar 内，所以在宿主体外**一个模块都加载不了**。`test/hooks/` 用一个解析钩子把这**一个** specifier 映到测试
> 替身，生产代码一行不改；替身**故意不导出** `dshCachePath`，让默认布局是确定的。
>
> `canonicalizeWatchPath` 只在真的移动或还原时才被调用，`/health` 走不到它——上面那最后一步正好是它的第一次
> 真实触发。仍未实测的是它的边界（不存在的路径、符号链接、权限错误），记在 [docs/safety.md](docs/safety.md) §9 第 9 条。

## 它凭什么判断

**引用关系只认结构化字段，不在日志文本里搜哈希。** 判定相对于"这一批保留下来的东西"，并遵循一条硬规则：

> **只要有任何一个会话的引用关系读不出来，「孤儿附件」这一档就整体暂停。**

宁可少删，不可删错。完整的分档判定规则、安全保证与已知边界见 **[docs/safety.md](docs/safety.md)**；该文档第八节逐条记录了**代码与本文档已知的出入**——其中 §8.5（「危险」档只在界面成立，且第一版修复在引用图**只读出一半**时失败开放）、§8.6（两条纵深防御守卫从未生效）与 **§8.8（分级里标成「可批量清理」的缓存字节没有任何通路会真正释放）已在本仓库修复**并留档。§8.8 里有一半是**故意的**：附件对象至今一个都清不掉，因为它们全都至少被一个会话引用，分级规则因此恒判「危险」——要让「零引用」的行存在，那是改判据而不是加通路，必须同时重过 §2 的硬规则，本轮没做。改动前先读那一节。§8.7（`createBatch` 的注释写着一条从未实现的规则）与 **§8.9（同一秒的多次移动共用一个批次目录并互相覆盖记录——issue #1 的根因）也已修复**。逐版本的变更记录见 **[CHANGELOG.md](CHANGELOG.md)**。

同一节还记下了修复之后的**代价**，因为它们是有意选择的：一条删除现在会多读一次引用关系（缓存命中时为零），**被别的会话引用的会话会被服务端直接拒绝搬走**，引用关系读不出来**或没能证明读完**时也拒绝——宁可少删，不可删错。

## 发版

版本号在 `package.json`，变更按时间倒序写进 [CHANGELOG.md](CHANGELOG.md)（Keep-a-Changelog 子集：只用 `Added` / `Changed` / `Fixed` / `Security` 这几个**英文**小节名，正文中文）。一版的完整动作：

```sh
# 1) 抬 package.json 的 version，并在 CHANGELOG.md 顶部加一节
npm test
git commit -am "release: vX.Y.Z" && git push origin main
git tag -a vX.Y.Z -m "vX.Y.Z — 一句话" && git push origin vX.Y.Z
gh release create vX.Y.Z --title "vX.Y.Z — 一句话" --notes-file <把 CHANGELOG 里那一节存成的文件>
```

**为什么要三样都做**：桌面端面板里那行「有新版本 …」和它下面的更新说明**都不读本仓库的文件**——市场客户端只认一份**按仓库 URL 索引**的中央产物（`awesome-dsh-plugin.com/updates.json`，每天探一次），条目内容是 **Release 正文**或提交切片，仓库不在那份目录里就永远显示「该插件未提供更新说明」；另一条路 `dsh-plugin-update` 读的是**新版 npm tarball 里包根的 `CHANGELOG.md`**，因此要求包真的发到 npm（本包目前不在 npm 上）。两条路都认「仓库 + 版本」这个身份，所以 tag、Release、CHANGELOG 一起写，等哪天被目录收录或发上 npm，说明自然出现，不用再改代码。

## 不做的事

不清理日志 / 备份目录 / 附件存储之外的临时文件（附件存储自己的原子写暂存区 `attachments/v1/tmp` 属于可重建残留，会清）；**不清理附件对象**——它们全都被至少一个会话引用着，所以一个都到不了「安全」档，见 [docs/safety.md](docs/safety.md) §8.8；不管理 `profiles/` 下的插件依赖；不做定时自动清理；不允许模型替用户删数据；不支持远端 / 共享存储后端。

上面这些**不是设计目标，而是已经实现的行为**：所有破坏性操作都要人在界面上明确确认，Agent 侧只有只读工具。

## 许可

[MIT](LICENSE)
