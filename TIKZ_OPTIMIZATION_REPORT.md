# TikZ 通用化优化与验收报告

日期：2026-10-27。适用于当前本地工作区。保留原有未提交工作，未发布发行版；外部测试语料保持不变。

## 性能变化

| 项目 | 优化前或完整读取 | 优化后或轻量读取 | 测试范围 |
| --- | --- | --- | --- |
| 数学表达式求值中位耗时 | 103.13 ms | 7.87 ms | 4 种 review 风格表达式，每轮 50000 次求值，5 轮，结果校验一致 |
| MCP 响应 JSON 大小 | 355661 字节 | 319 字节 | 200 条导线及 500 采样点曲线；轻量响应省略组件详情和完整存档 |
| MCP 读取中位耗时 | 28.56 ms | 4.19 ms | 真实 SDK stdio、隔离 Edge，每种模式交替读取 6 次 |

数学微基准约提升 13.1 倍，不能据此推断整个应用提升相同比例。MCP 两列是不同输出量的比较：轻量模式供 revision、源码状态、对象数量和选区查询；需要完整对象时仍使用默认完整读取。两种模式的版本与源码状态已验证一致。

具体实现：

- `compileTikzMath` 将有界数学子集编译为求值函数，无 `eval`；`evaluateTikzMath` 使用最多 128 项、总表达式字符数最多 128 KiB 的 LRU。缓存不捕获变量值。
- `PlotComponent` 每次采样只编译 x/y 公式各一次，保存基础采样点供变换恢复和导出复用，避免重复求值。
- MCP 文档读取复用一次存档快照计算 revision 和返回存档，按需跳过组件详情生成与大响应。

原始数据见 [数学微基准](qa-results/tikz-optimization/math-performance.json) 和 [MCP 读取](qa-results/tikz-generalization-optimized-final/mcp-read-performance.json)。数学比较基线位于 `.qa-tools/optimization-baseline-20261027/src/scripts/utils/tikzMath.ts`，基准脚本是 `scripts/benchmark-tikz-math.cjs`。

## 已修复问题

| 问题 | 修复及验证 |
| --- | --- |
| 正反圆弧转为 bend 时方向相反 | 修正 sweep 到 bend 的符号；检查真实画布中点、导出、重新导入，以及源码/模型独立 TeX 校样 |
| 合法箭头选项重新导入被当作未知样式 | 未知选项检查共用箭头解析；拒绝仅一端合法的箭头写法，名字表只接受自有属性 |
| 数学解析读取继承属性 | 函数和运算符查询使用自有属性，拒绝 `1 constructor 2`、`1 toString 2` 等非法表达式 |
| 样式定义很短但展开呈指数增长 | 除深度限制外，增加每次展开 10000 项和 2 MiB 上限；循环与扇出用例验证 |
| 优化快照导致未编辑图纸被判为源码不一致 | JSON 克隆改变 SVG.Number 表示；源码状态恢复使用原始 toJson 值，保持 version 1 基线兼容，验证编辑、撤销、刷新及轻量读取 |
| 注释或宏体中的 documentclass 误触发完整文档检测 | 仅识别组外、非注释中的指令；片段与完整文档真实编译通过 |
| 编译取消后 Windows 文件句柄尚未关闭，临时目录清理报 EBUSY | 取消时等待进程 close，再有限重试清理；实际运行无限 TeX 循环并取消，确认未残留新目录 |
| 已有 PDF 或无效资源目录仍消耗编译时间 | 编译前检查目标文件及资源目录，保留最终排他写入以防覆盖竞争 |
| 图形回归报告日期固定为旧日期 | 改为实际运行时间，最终语义验收使用新目录保存 |

## MCP 新能力

- `designer_get_document` 提供 `includeComponents`、`includeSaveFile`，默认保持兼容；都为 false 时返回轻量状态。
- `designer_export`、`designer_compile` 可选 `expectedRevision`，在取出源码时拒绝过期版本；编译结果对应固定源码快照。
- `designer_list_symbols.shapeExamples` 增加可直接创建的 arc、bezier、plot 示例，已通过真实模型创建验证。
- 编译任务每个服务最多 2 个并发、8 个等待；支持客户端取消、排队计时、编译计时、错误码与诊断。排队取消不启动编译器。
- 新增 `npm run test:mcp:compile` 入口；完整参数、响应和错误说明见 [MCP 文档](mcp/README.md)。更新后需刷新网页并重启 MCP 连接。

## 最终验收

| 验证 | 结果与证据 |
| --- | --- |
| TypeScript、生产构建、语法检查 | 通过；构建保留原有 Sass/Bootstrap 弃用提示 |
| 电机学 review 图库 | 36 个 tex 文件，35 幅独立图、1 个参数模板；35 幅全部导入，34 幅无警告，1 幅报告 ex 近似 |
| 固定缺口 probe | 8 项全部通过，含单位、范围循环、计算标签、样式/颜色、公式曲线和贝塞尔语义 |
| 通用工作流 | 16 项通过，含原文换行、撤销、刷新、公式编辑和变换、版本冲突、轻量读取及原生示例 |
| 真实 TeX 编译 | 清单内 46 次全部成功，另有源码模式 1 次成功；包含全部 35 幅模型导出、3 幅代表原文及 3 组模板参数的原文/模型编译 |
| 现有 MCP 回归 | 25 项集成、24 项编辑、21 项诊断全部通过 |
| 图形语义回归 | 71 项通过；包含 16 种电压标注组成的原文/导出矩阵真实编译 |
| 文件导出后端 | 10 项通过 |
| 编译器回归 | 6 组通过，含队列限制、取消、文档检测、真实编译失败诊断及临时目录清理 |
| 语料与浏览器 | 原始语料 SHA256 未变；整库及 MCP 回归未记录浏览器脚本错误 |

核心证据：

- [验收与性能汇总](qa-results/tikz-optimization/final-summary.json)。
- [最终整库验收](qa-results/tikz-generalization-optimized-final/results.json)、[编译清单](qa-results/tikz-generalization-optimized-final/compile-results.json)。
- [MCP 集成](qa-results/mcp-optimized-acceptance/results.json)、[编辑](qa-results/mcp-optimized-acceptance/editing-results.json)、[诊断](qa-results/mcp-optimized-acceptance/diagnostics-results.json)。
- [图形语义](qa-results/semantics-optimized-final/semantics.json)、[编译器](qa-results/tikz-optimization/compiler-results.json)。

## 视觉与适用边界

已逐对查看功角、同步相量、绕组连接和正反圆弧的模型/原文 PNG。曲线、连接及圆弧方向保持对应，仍可见字体布局、标注位置、边距和箭头外观差异；同步相量的角标尤其不能据此声称像素一致。其余图完成模型与编译检查，没有逐幅证明视觉等价。

仍采用通用 TikZ 第一阶段的边界：支持的宏和循环会展开为模型；画布编辑不会局部回写原始循环或宏。复杂 TikZ 库和完整 TeX 可保存源码并编译，但不保证逐对象可视化编辑。`ex` 是明确报告的近似，最终排版以真实 TeX 为准。旧版 JSON 仍可读取；新增对象需要当前版本。

清理旧取消测试留下的 `D:\AppData\Temp\tikz-designer-OT9Goc` 时，自动审批返回 `blocked by policy`，未提供更具体原因。该旧目录已保留；新的活动编译取消及清理测试通过，没有产生新的残留目录。
