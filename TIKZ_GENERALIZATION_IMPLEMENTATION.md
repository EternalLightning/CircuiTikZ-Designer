# TikZ 通用化第一阶段实施说明

日期：2026-10-27。代码与构建均位于当前本地工作区，原有未提交修改予以保留。

## 已实现

### 通用语法与图形

- 新增独立、有边界的数学与语法层，没有使用 JavaScript `eval`，也不在浏览器执行 TeX。
- 支持数值循环的显式列表、递增/递减范围、带步长范围、多变量列表、嵌套循环；宏定义在花括号组、作用域和循环内保持局部性。
- 支持带花括号参数的 `\newcommand` / `\def`，以及 `\pgfmathsetmacro` / `\pgfmathtruncatemacro` 的数学子集。三角函数按度计算，支持幂、比较、条件表达式、常用数学函数。
- 支持 `x`、`y` 坐标单位、常用长度单位、`em`，以及作用域中的平移、旋转、缩放和可逆二维 `cm` 矩阵。命名坐标在作用域之间按世界坐标解析。
- 支持命名样式、样式引用和局部作用域、常用 xcolor 颜色、混合色、`\definecolor` 和 `\colorlet`。
- 新增 `bezier` 原生对象，保存两个端点及两个控制点，支持控制点编辑并导出 `controls`。
- 新增 `plot` 原生对象，保存 x/y 表达式、定义域与采样数。整体变换后恢复仿射矩阵并导出公式；通过属性修改公式，避免独立修改采样点破坏语义。
- 保留自然宽度文字、字号、颜色和锚点，修复全局箭头选项将文字误转为固定宽度矩形的问题。
- 修复直线、贝塞尔与圆弧末尾 `node[midway]` / `node[pos=...]` 的标签位置，并保留 `Stealth` / `Latex` 箭头的大小写与库依赖。
- 修复圆弧 sweep 到 bend 的方向转换，并验证顺时针、逆时针、bend left/right 的画布、导出和重新导入方向；合法箭头写法重新导入不再误报未知样式。
- 普通图形导出不再自动加入电压设置和 `\ctikzset`；包含电路对象时保留原有电路导出设置。

### 原始源码与环境

导入窗口新增环境定义和保留源码模式。环境定义可以提供宏、颜色、字体和宏包。UI 默认保留坐标；MCP 的默认网格对齐保持兼容，科学图应显式使用 `snapToGrid: false`。

原始文本、环境定义、导入警告和基线随 JSON、浏览器保存与撤销历史存档。`sourceStatus` 说明源码是否存在、是否采用源码模式、是否与画布基线一致。选择变化不算绘图修改。

两种导出有明确含义：

- “当前图形”或 MCP `format: tikz` 由当前模型生成，包括画布修改。
- “保留源码”或 MCP `format: source` 返回上次导入的原文和环境定义，包括原注释、循环、宏和未转换的语法。

画布编辑目前不会局部回写原始文本。源码模式可保存任意 TikZ / TeX 文档，但不承诺逐对象可视化编辑。该模式要求空画布或替换现有图纸；真实 TeX 校样可独立编译原文。

### 真实 TeX 编译

新增 MCP `designer_compile`，可选择 `representation: canvas` 或 `source`，默认使用本地 XeLaTeX，返回诊断、revision、源码哈希及首张 PDF 页面的 PNG，也可保存 PDF。支持绝对资源目录和 PDF 输出路径，默认拒绝覆盖已有 PDF。

片段会包装为独立文档；完整 `\documentclass` 文档直接编译。包装器将顶层宏包声明留在导言区，允许“模板宏定义中包含 tikzpicture，再传参调用”的源码直接编译。

编译不改变浏览器图纸和撤销历史。引擎、字体、宏包和资源缺失时返回实际错误。普通浏览器编辑不需要 TeX；真实校样需要本地引擎，PNG 另需 Poppler。

### 优化与 MCP 完善

数学表达式先编译再求值，使用有容量限制的 LRU，曲线复用基础采样点。数学求值微基准由 103.13 ms 降至 7.87 ms，约 13.1 倍；该结果仅覆盖指定表达式求值。新增 MCP 轻量读取，导出/编译可按 expectedRevision 校验；编译最多 2 个并发任务和 8 个等待任务，支持取消、耗时和错误码。

本轮整库验收也发现并修复快照复用导致的源码状态误判，保留原 version 1 基线格式。详细变更、性能方法及证据见 [优化报告](TIKZ_OPTIMIZATION_REPORT.md)。

## 验证与证据

此次复查时 review 图库已有 36 个 `.tex` 图形文件，包含 35 幅独立图和一个参数模板，比最初评估多一个文件。测试显式提供该工程实际使用的 `amzchaptercolor` 和 `\jj` 定义，原始资料未修改。

| 验证项目 | 结果 |
| --- | --- |
| TypeScript 检查、生产构建 | 通过；构建存在原有 Sass 弃用提示 |
| 数学、宏、循环、颜色、样式、作用域、仿射恢复检查 | 通过 |
| 八项原始最小问题 | 全部通过：单位、范围循环、计算标签、命名样式、两种颜色写法、函数曲线、贝塞尔语义 |
| 35 幅独立图导入 | 全部创建成功；34 幅无警告，1 幅明确提示 `ex` 近似 |
| 35 幅模型导出的真实编译 | 全部通过 |
| 代表原图的源码编译 | 功角、同步相量、绕组连接三幅通过 |
| 参数化相量图 | 三组实际参数的导入与源码/模型编译验证 |
| 源码模式 | 保存、导出、真实编译验证 |
| 编辑与存储 | 原文文本及换行、编辑状态、撤销、刷新重载、公式属性编辑与曲线变换验证 |
| 通用工作流与新增 MCP 能力 | 16 项通过；46 次列入清单的真实编译，另有 1 次源码模式真实编译 |
| 既有 MCP 集成、编辑和诊断 | 25 + 24 + 21 项通过 |
| 既有图形语义回归 | 71 项通过，含 16 种电压标注的原图与导出编译 |
| 既有文件导出后端 | 10 项通过 |
| 编译队列、包装器、错误、取消与清理 | 6 组通过，含真实 XeLaTeX/pdfLaTeX 和活动 TeX 取消 |

整库编译通过不等于整库视觉等价。已对功角、相量、绕组三组及圆弧方向的真实校样进行视觉对照，其他图完成模型与编译检查。代表图的曲线、箭头方向与连接关系一致，仍可见文字位置、边距及箭头外观差异，尤其相量图的角标布局。画布预览与 TeX 字体布局仍可能不同。

最终语料及编译证据位于 [验收目录](qa-results/tikz-generalization-optimized-final/)，核心结果为 `results.json`、`compile-results.json`；每幅图保存输入、导出、模型及相应 PDF。MCP 回归位于 `qa-results/mcp-optimized-acceptance/`，图形语义回归位于 `qa-results/semantics-optimized-final/`，性能和编译器回归位于 `qa-results/tikz-optimization/`。旧 `phase1-acceptance` 是圆弧修正前的中间证据，不代表最终方向结果。

初始基线见 [实施前评估](TIKZ_GENERALIZATION_REVIEW.md)。由于语料有新增且实施后提供了宿主环境，数量不能直接当作完全等条件的视觉比较；八项固定最小用例用于验证对应缺口。

## 使用入口

1. 正常启动 `npm start`，刷新浏览器后打开“导入 TikZ / CircuitikZ”。
2. 粘贴绘图代码，在“环境定义”中提供其自定义宏、颜色和字体；科学图保留默认的不对齐网格。
3. 对支持的内容进行画布或 MCP 编辑；函数曲线在属性中调整表达式、定义域及采样数。
4. 导出当前图形，或导出上次导入的保留源码。需要真实校样时使用 `designer_compile`。

更新 MCP 服务器后需重启连接，以发现新工具及 `source` 导出格式。参数与示例见 [MCP 使用说明](mcp/README.md)。

独立语法检查：

```powershell
npm run test:tikz
```

整库验收（当前机器已有 Playwright、Edge、TeX 和 Poppler）：

```powershell
$env:QA_GENERALIZATION_CHECKS = '1'
node scripts/audit-tikz-generalization.cjs 'E:\Projects\Thesis\电机学\review\figures' 'E:\Projects\Circuitikz\CircuiTikZ-Designer\qa-results\new-generalization-run' '.qa-tools\review-preamble.tex'
```

第四个参数是测试导言区文件。输出目录必须不存在且位于语料之外。测试使用隔离浏览器及临时桥接端口。

## 当前边界与后续工作

- `ex` 暂按半个 em 近似，并明确报告；任意字体相关长度须以真实 TeX 校样为准。
- 不支持完整 TeX 宏语言、全部 PGF 数学函数或全部 TikZ 库；复杂文档可用源码模式保存与编译。
- 当前模型会展开循环；画布编辑不会同步修改原循环或宏参数定义。基于源码位置的局部回写属于下一阶段。
- 普通圆弧仍沿用现有弯曲模型或采样表示；原始源码保留精确写法。
- PNG 校样只返回第 1 页；多页文档以 PDF 为准。
- 旧 JSON 可继续读取；含新增对象的 JSON 需要本地新版。没有发布、打包或安装发行版。

主要新增实现位于 `src/scripts/utils/tikzMath.ts`、`tikzPreprocessor.ts`、`tikzColors.ts`、`tikzStyles.ts`、`tikzDocument.ts`、`affineFit.ts`，图形对象位于 `src/scripts/components/bezierComponent.ts`、`plotComponent.ts`，编译器位于 `mcp/compile.mjs`。
