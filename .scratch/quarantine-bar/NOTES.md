# 原型：底部固定操作条与就地结果条（#21）

单文件静态原型，回答两个问题：**固定条与结果条长什么样**、**480px 窄窗与超长标题下是否可用**。
不接真实接口，数据全部是演示数据（与 #18 的 9 项现场同构）；不合并 main。

打开方式：直接把 `quarantine-bar.html` 拖进浏览器，或用
`python3 -m http.server` 之类起个静态服务（本文件无外部依赖）。

## 演示参数（也可用底部悬浮条点选）

| 参数 | 取值 | 作用 |
| --- | --- | --- |
| `variant` | A / B / C | 三种结果条结构，见下 |
| `state` | idle0 / idle / running / done | 0 选中 / 已选 4 项 / 处理中（第 3/7 项）/ 完成 |
| `at` | 数字 | running 时已经处理完几项（默认 2） |
| `sel` | 数字 | idle 时预选几项（默认 4） |
| `narrow` | 1 | 480px 视口：导航消失、标题两行截断、底栏改竖排 |
| `long` | 1 | 打开超长标题（第 4 行是刻意的两行标题） |
| `folds` | open | 把「需确认 / 危险」两个默认折叠的档展开 |
| `scroll` | bottom | 打开后直接滚到列表底部（看折叠档与可清理对象） |
| `drawer` | 1 | C 变体默认展开抽屉 |
| `debug` | boxes | 左上角打印底栏/滚动区几何，供实现时核对 sticky 边界 |

示例：`quarantine-bar.html?variant=A&state=running&at=2&long=1&narrow=1`

## 三个变体（只有结果条结构不同，底栏动作区一致）

- **A · 底栏内叠放结果**：结果条直接叠在固定条上方，仍在视口底部；点击处就是看结果处。
- **B · 顶部结果卡 + 底栏摘要**：结果卡插在顶部统计卡下面，底栏只留一行「本次 · 成功 5 · 失败 1 查看」。
- **C · 底栏抽屉明细**：底栏行内放汇总与「展开明细」，逐项结果在抽屉里，可收起。

## 已覆盖的票面要求

- 底栏：已选 N 项与合计、主按钮「隔离所选 N 项（可恢复）」、全选安全项、清除选择；0 选中 / 处理中 / 完成三态；旁注「只会搬进插件自带的隔离区，不会销毁任何东西」。
- 处理中：`第 N/M 项 + 当前会话标题`、进度条、行上「搬运中 / 已搬走 / 已在隔离区 / 排队中」、主按钮禁用且连点无效。
- 完成：成功后不跳转，「查看隔离区」是显式动作；结果条给成功/失败/已在隔离区三个计数，失败原因可展开；行上保留终态。
- 折叠档：「需确认」「危险」默认折叠，标题行 = 计数 + 原因 + 展开入口（`aria-expanded`），展开后行不可勾选。
- 窄窗 480px：导航隐藏、标题两行截断、底栏竖排（计数 / 次按钮 / 主按钮各占一行）。
- 无障碍：底栏与折叠档有 `focus-visible`；持久 live region（`role=status` `aria-live=polite` `aria-atomic=true`）按批播报进度与结果，失败另走 `role=alert`；右上角面板列出实际播报文本，便于核对。

## 已知取舍 / 待定

1. 底栏用 `position:sticky; bottom:0` 挂在 `.dshr-root` 末尾（#20 的结论：宿主的滚动容器是 `._77Pn0W_options`，不是 `.dshr-root`）。sticky 底边与滚动容器下沿偶尔差 1–5px，原型用同色 `::after` 补块盖住；实现时优先给容器补 `padding-bottom` 或让底栏做 flex 子项。
2. 结果条不自动消失，也不自动跳转；演示里刷新/继续勾选即丢弃（真实实现是否保留，待拍板）。
3. 「已在隔离区」在演示里作为第三种终态（源目录不存在 + 隔离区已有批次）；真实实现的判定在 #22。
4. 窄窗下结果条 + 底栏合计约 200px，列表可视区被压到 3 行左右——这是要拍板的点。

## 截图

`01-a-idle` `02-a-running` `03-a-done` `04-b-done` `05-c-done` `07-a-narrow-running` `08-a-narrow-done` `11-a-folds-open`。
截图命令：
```
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new --no-sandbox \
  --disable-crash-reporter --disable-breakpad --hide-scrollbars \
  --user-data-dir=".scratch/chrome-profile" --screenshot=out.png --window-size=980,1250 \
  --virtual-time-budget=3000 "file://$PWD/.scratch/quarantine-bar.html?variant=A&state=done&long=1"
```
（480px 用 `--window-size=520,1150`；没有 `--no-sandbox` 时 crashpad 写 `~/Library` 会被拒且不出图。）
