# dsh-reclaim

> Audit and safely reclaim the disk space DeepSeek Harness keeps forever.
> 审计并安全回收 DeepSeek Harness 永久占用的磁盘空间。

**DSH 插件。尚未发布，还不可安装。**

---

## 为什么有这个项目

DSH 官方明确**不回收**附件。`@deepseek-ai/dsh-attachment-local` 的 README 原文：

> **Images are kept forever** — stored images are never deleted automatically, and nothing collects unreferenced objects.

官方也说明了推迟的原因：

> Retention and garbage collection are deferred because **resumed and forked sessions may share immutable objects** …

也就是说，这不是漏做，而是一个需要先解决正确性问题的功能。`dsh-reclaim` 把它做出来，并且尊重官方指出的那条约束。

## 它做什么

- 审计 **会话**、**附件**、**可重建缓存**各自占了多少、还有谁在用
- 按三档风险分级：**安全**（可批量清理）/ **需确认**（逐个查看）/ **危险**（不可勾选）
- 清理**不是删除**：数据搬进插件自带的隔离区，可随时恢复
- 只读的 Agent 审计工具（模型能查、不能删）

## 它凭什么判断

**引用关系只认结构化字段，不在日志文本里搜哈希。**

判定相对于"这一批保留下来的东西"，并遵循一条硬规则：

> **只要有任何一个会话的引用关系读不出来，「孤儿附件」这一档就整体暂停。**

宁可少删，不可删错。

完整的三档判定规则、安全保证与已知边界见 **[docs/safety.md](docs/safety.md)**。

## 不做的事

不清理日志 / 临时文件 / 备份目录；不管理 `profiles/` 下的插件依赖；不做定时自动清理；不允许模型替用户删数据；不支持远端 / 共享存储后端。

> ⚠️ 本项目**还没有实现**，上面的规则是它要满足的设计契约（可审计的目标），不是已经跑起来的功能。

## 开发笔记


## 许可

[MIT](LICENSE)
