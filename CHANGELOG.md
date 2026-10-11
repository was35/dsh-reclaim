# 更新说明

本文件自 `0.2.1` 起记录。格式是 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的子集——只使用 `Added` / `Changed` / `Fixed` / `Security` / `Deprecated` / `Removed` 这几个固定小节名（这些名字是给消费方解析用的，写成中文会让解析失败）；正文用中文。版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

本仓库此前未记录变更历史，`0.2.1` 之前的版本不在本文件中补写。

## [0.2.1] - 2026-10-11

这个插件对外承诺「清理是搬动，不是删除」。这一版修的是那条承诺所依赖的记录：**没有字节被销毁，被销毁的是来路**。完整推演、代码与文档的出入记在 [docs/safety.md](docs/safety.md) 的 §4.5–§4.9 与 §8.9。

### Fixed

- **同一秒内的多次移动不再共用一个批次目录**（issue #1 的根因）。批次目录名原先只有秒分辨率，而界面「清理」是逐会话各发一次 `POST /delete`，同一秒里的多次移动因此落进同一个目录；每次移动又整份覆写 `manifest.json`，后写覆盖先写，**先移入的条目就此失去 `originalPath`**——文件还在，但没有任何记录说它们从哪来。受影响的是同一秒内进入同一批次、且不是最后一批的那些条目，对插件而言不再可还原。现在由 `claimBatchDir`（`lib/trash.js`）按**操作**认领目录：非递归 `mkdirSync` + `EEXIST` 重试，依次尝试 `<stamp>`、`<stamp>-2`…，只复用**同一次操作**的目录（空目录，或清单的 `sessionIds` 认这个会话）。`dryRun` 不认领，认领失败则什么都不搬，零移动时只删本次创建的目录。
- **写清单改为并集，不再是整份覆写**（`mergeIntoManifest`，`lib/recover.js`）：读回-合并-写入，并在写入后回读校验。两个记录指向不同 `volumeRoot` 时**拒绝合并**——宁可不写，也不写出指向不明的记录。
- **没有清单的批次可以被读回、展示和还原**（`reconstructEntries`，`lib/recover.js`）。批次目录是原路径的镜像，于是「一个条目 = 直接含文件的目录，或空目录」这条边界规则足以把 `originalPath` / `relativePath` / `kind` / `sessionId` 推回来：`planRestore` / `restoreBatch` 据此给出待还原项并把重建的记录落盘（条目带 `inferred: true`），`describePurge` / `listBatches` 据此报出**真实项数**。界面因此不再对这类批次显示 `?`，也不再给出注定失败的按钮。**只对「完全没有清单」重建**：清单存在但校验失败属于 bug，应当报出来，不该被静默补齐。**已知局限**：镜像不记录条目边界，所以顶层只有目录的条目会被更深一层地拆开还原（§4.5）。

### Changed

- `planRestore` 返回值里的 `reconstructed` 现在表示「**本次规划**读了布局」，而不是「这份记录当初是推断的」——重建记录落盘后再规划一次即为 `false`。
- 还原时删除空的 `manifest.json` 若遇到 `ENOENT`，记为 `alreadyAbsent` 而不是失败。
- `directoryBytes` / `directoryFileCount` 从 `lib/trash.js` 移到 `lib/measure.js`（由 `lib/trash.js` 转出，既有调用点不变），避免与 `lib/recover.js` 形成循环依赖。
- 批次目录名不再唯一标识一次操作：同一秒可以有 `<stamp>`、`<stamp>-2`…，把批次名当时间戳解析的调用方要容忍后缀。路由侧无需改动（批次的包含性校验不看名字形状），但隔离区列表按 `batchId` 字符串降序排，同一秒的多个批次之间先后不保证。

### Added

- `lib/recover.js`：清单并集写入与从批次布局读回条目。
- `lib/measure.js`：目录体积/文件数测量，只有一份实现。
- `test/batch-record.test.js`：6 条回归测试，钉住「同秒不同会话各得一个批次」「同 session 同秒复用且条目累加」「无清单旧批次不被复用」「无清单批次可规划、可还原且还原后记录落盘」「列表报出真实项数与推断出的 `sessionIds`」。`npm test` 由 35 条增至 **41 条**。
