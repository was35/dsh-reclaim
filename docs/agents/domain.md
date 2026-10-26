# Domain Docs

工程类技能在探索代码库时，应当如何消费本仓库的领域文档。

## 布局

**single-context** —— 一个仓库共用一份根目录的 `CONTEXT.md`，架构决定放 `docs/adr/`。

本仓库目前没有 `CONTEXT-MAP.md`，也没有各子项目的 `CONTEXT.md`；两者都按需惰性创建，等第一次真正写下词条或 ADR 时再建。

## 动手探索之前，先读这些

- **`CONTEXT.md`**（仓库根目录），或
- **`CONTEXT-MAP.md`**（仓库根目录，若存在）：它指向每个上下文各自的 `CONTEXT.md`，读其中与当前主题相关的那些。
- **`docs/adr/`**：读与你要动的区域相关的 ADR。多上下文仓库还要看 `src/<context>/docs/adr/` 里的上下文级决策。

这些文件如果不存在，**静默跳过**。不要指出它们缺失，也不要提议现在就建。`/domain-modeling` 技能（经 `/grill-with-docs` 与 `/improve-codebase-architecture` 到达）会在术语或决策真正定下来时惰性创建它们。

## 文件结构

单上下文仓库（大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根目录存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 用 CONTEXT.md 的词汇说话

当你的产出点到一个领域概念时（issue 标题、重构提案、假设、测试名），用 `CONTEXT.md` 里定义的那个说法。不要漂到词汇表明确回避的同义词上去。

如果需要的概念还不在词汇表里，那是个信号：要么你在发明这个项目不用的语言（重新考虑），要么这里确实有个缺口（记下来交给 `/domain-modeling`）。

## ADR 冲突要挑明

如果你的产出与既有 ADR 相矛盾，明确摆出来，不要悄悄盖过去：

> _与 ADR-0007（event-sourced orders）矛盾，但值得重开，因为……_
