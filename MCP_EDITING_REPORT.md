# MCP 指定元件编辑：实现与验证

后续已加入试算 PNG、连接变化与重叠检查，当前 MCP 为 15 个工具；最新扩展和测试见 [MCP_DIAGNOSTICS_REPORT.md](MCP_DIAGNOSTICS_REPORT.md)。以下保留指定元件编辑这一阶段的实现与验证记录。

日期：2026-10-25。实现位于当前 `E:\Projects\Circuitikz\CircuiTikZ-Designer` 工作区；浏览器生产资源已重新构建。没有替换其他目录中的副本或旧压缩包。

## 已实现

现在 MCP 共 14 个工具。新增 `designer_find_components`、`designer_get_component`、`designer_get_connections`、`designer_select`，并扩展现有预览、编辑和视图工具。

- **定位**：精确标签、类型、符号、子串搜索、选中状态、邻近坐标；返回全部匹配计数、候选、歧义和截断标志，不自动选择重复标签的第一个。
- **指定元件详情**：稳定 ID、归属编组、参考位置、路径参考点、引脚及 cm/px 两种坐标；直接读取真实属性集合，暴露属性 ID、类型、当前值、是否禁用、选项键和数值范围。
- **鼠标与 AI 协作**：用户用鼠标选择后，AI 可用 `selected: true` 编辑；选区变化也会更新 revision，避免读完状态后误改另一个新选区。
- **编号预览**：PNG 可加临时编号、稳定 ID 映射及红框高亮；不改图纸或任何导出内容。编号绑定此次 revision，后续执行仍使用稳定 ID。
- **几何编辑**：相对移动、移动到参考位置、单独改起点/终点、同时改两端、更新路径参考点、指定中心旋转、参考位置对齐及等距分布。
- **属性编辑**：按真实属性 ID 调用实际 UI 变化监听器；支持公式/文字、布尔、数值、颜色、下拉及单选，执行类型、禁用状态、选项及硬范围校验。未指定的属性保留。
- **连接处理**：明确选择只改目标的 `detach`，或让直接相接导线端点与接点跟随的 `follow_wires`。变更摘要包含跟随修改的导线 ID。
- **复制**：生成新稳定 ID，编组内部也更新全部 ID；返回源 ID 到新 ID 的映射。
- **试算**：`dryRun` 返回建议图纸和变更摘要，随后恢复当前图纸、选区和 revision，不保存、不改变撤销/重做历史。
- **聚焦**：`designer_fit_view` 可指定 IDs，将实际浏览器视图聚焦到目标；不指定则显示整图。
- **原有事务保障**：整个正式批次一个撤销步骤，失败恢复整个批次；成功等待 IndexedDB 保存。

已有的默认 TikZ 当前代码导出继续可用，也能导出上述编辑后的状态。

## 验证结果

验证使用真实 Edge、官方 MCP SDK、独立 stdio 服务子进程及隔离浏览器上下文，没有修改用户正在编辑的图纸。

| 验证 | 结果及证据 |
| --- | --- |
| 原有 MCP 集成 | 25 项通过，包括协议、认证、事务、会话、持久化、版本、撤销重做和当前代码导出 |
| 新编辑工作流 | 24 项通过；见 `qa-results/mcp-editing/editing-results.json` |
| 鼠标真实点击 → MCP | 点击电阻后，MCP 可读到其选中 ID；不是仅手工伪造 selected 字段 |
| 端点与导线 | 同时把两端移到不同高度，相接 wire 端点和接点正确跟随；远端保留 |
| 多引脚符号 | 移动运放，负输入和输出的相接导线端点跟随，远端保持原位 |
| 属性 | 文字、选择项、布尔、数值、颜色及默认颜色恢复通过；错误值整体回滚 |
| 试算 | 实测原图、revision、选区、IndexedDB、撤销及重做均未被试算修改 |
| 复杂接点 | 与未包含的刚性元件共享引脚、位于导线中段的接点会明确拒绝并回滚 |
| 编组 | 子元件可发现和读取，直接编辑明确拒绝；复制编组会生成全新的嵌套 ID |
| 课程导入 | 35 张课程图及网格/连接回归通过；扫描到 364 个环境，不表示全部已测 |
| 文本 | 28 项集成回归通过 |
| 绘图语义 | 原 71 项极性、箭头、曲线及标签语义回归通过 |
| 导出编译 | 新编辑测试中的原图、独立移动两端后的图，导出 TikZ 均实际编译为 PDF 并渲染查看；连接及图形与 MCP 预览相符 |
| 静态检查 | TypeScript、生产构建、Node 语法检查、git diff --check 通过 |

生产构建仍有既有 Sass 弃用及资源体积提示。当前编译图与 SVG 的细微字体、线宽及排版差异仍按前序视觉报告的边界处理。

## 图像与原始结果

- [编号与高亮预览](qa-results/mcp-editing/editing-numbered.png)
- [端点编辑前预览](qa-results/mcp-editing/editing-before.png)
- [两端独立移动后预览](qa-results/mcp-editing/editing-endpoints.png)
- [对应导出编译图](qa-results/mcp-editing/editing-endpoints-compiled.png)
- [对应导出 TikZ](qa-results/mcp-editing/editing-endpoints.tikz)
- [原有与新增 MCP 结果](qa-results/mcp-editing/results.json)
- [71 项绘图语义回归](qa-results/editing-render-regression/semantics.json)

`qa-results/mcp-editing/` 同时保存编辑前后 JSON、LaTeX 编译源文件、日志和 PDF。

## 使用约定和边界

1. 几何新操作默认 cm、y 向上；旧 `move` 保留 px、y 向下默认值。建议 agent 始终显式写 `unit`。属性数值使用属性自己的 unit。
2. 新 `set_properties` 只改指定字段；旧原生 `update.patch` 仍是浅合并。元件符号 ID 和用于定位的 automationId 含义不同。
3. `set_endpoints` 只用于路径对象。运放等多引脚节点应整体移动、旋转或改符号属性；不能任意拉伸其引脚。
4. `follow_wires` 是直接端点跟随，不是完整自动布线，不处理障碍避让，也不把交叉线自动视作电气接点。复杂接点拒绝时，agent 不得悄悄改用 detach。
5. 编组当前以顶层对象为编辑单位。可整体移动/旋转/复制父组，或通过原生 update 提供完整编组存档；子元件详情明确返回 editable=false 和父组 ID。
6. 对齐/分布基于元件参考位置，移动多个元件到 position 时使用这些参考位置的平均值，不按标签外框对齐。
7. 新几何操作不会自动吸附。操作后可调用只读网格检查及连接检查，再查看预览。
8. 试算返回的新增 ID 是临时建议状态中的 ID，不能直接作为现有元件使用。提交时重新调用，使用当前图纸 revision。

完整参数及例子见 [mcp/README.md](mcp/README.md)。升级后需重启 MCP 服务以刷新工具定义，并刷新/重新连接浏览器页面；旧服务启动时的连接令牌不可继续使用。

## 复现

```powershell
node node_modules/typescript/bin/tsc --noEmit --pretty false
npm run build
$env:QA_OUTPUT_DIR = 'qa-results/mcp-editing'
node scripts/qa-mcp.cjs
node scripts/qa-import.cjs
node scripts/qa-simple-text.cjs
```

新增工作流测试作为 qa-mcp 的一部分执行，也保留原 25 项检查。核心编辑实现集中在 `src/scripts/utils/agentEditing.ts`；浏览器事务入口在 `agentController.ts`；MCP 输入模式在 `mcp/server.mjs`。
