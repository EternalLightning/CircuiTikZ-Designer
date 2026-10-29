# CircuiTikZ Designer MCP 使用说明

Agent 通过标准 MCP **stdio** 连接 Node 服务；服务通过有令牌保护的本机 WebSocket 连接你选择的浏览器画布。浏览器仍使用 `npm start`，所有编辑都经过应用的元件模型，可继续手动编辑。

本文依次介绍 [启动与连接](#启动与连接)、[工具](#工具)、[导出代码](#导出当前代码)、[指定元件编辑](#指定元件编辑)、[网格检查](#网格对齐与检查)、[排错](#常见问题) 和 [源码包](#源码-zip-内容)。下文 JSON 示例是对应工具的**参数对象**，不是完整 JSON-RPC 请求；会话 ID、revision 和元件 ID 均需替换为实际返回值。

## 启动与连接

需要 **Node.js 20 或更高版本**及现代浏览器，已使用 Node.js 24 测试。正常使用不需要 Python 或 TeX 环境。首次安装需要网络，网页中的外部字体等资源也可能需要网络，因此不承诺完全离线。

解压源码 ZIP 或克隆仓库，进入包含根目录 `package.json` 的文件夹，首次安装执行：

```powershell
npm ci
npm --prefix mcp ci
```

这两条命令分别安装网页和 MCP 依赖，不能互相替代。然后启动网页，保持终端运行：

```powershell
npm start
```

打开终端输出的地址，通常为 `http://localhost:1234/`。后续启动只需 npm start；依赖锁文件变化后重新安装。`npm run mcp:install` 也是 MCP 依赖安装入口，但不会安装主项目依赖。

将服务器添加到支持 stdio 的 MCP 客户端。下面是通用 JSON 配置；各客户端配置文件的位置和外层结构可能不同：

<!-- example: client-config -->
```json
{
  "mcpServers": {
    "circuitikz-designer": {
      "command": "node",
      "args": ["E:/Projects/Circuitikz/CircuiTikZ-Designer/mcp/server.mjs"],
      "env": {
        "MCP_APP_URL": "http://localhost:1234/",
        "MCP_BRIDGE_PORT": "3210"
      }
    }
  }
}
```

`args` 使用实际的绝对路径，`command` 可改为 Node 可执行文件的绝对路径。客户端启动该进程，不必另外执行 `npm run mcp`，否则相同端口会冲突。网页服务器和 MCP 服务是两个进程，使用时均需保持运行；MCP 服务不是供浏览器访问的 HTTP 接口。直接运行 `npm run mcp` 仅用于手动启动 stdio 服务器，stdout 留给 MCP 消息，启动信息写入 stderr。

1. Agent 调用 `designer_status`，取得 `connectUrl`。
2. 在浏览器打开该链接；或在已打开的图纸上点击顶栏 **MCP**，粘贴链接并连接。
3. 再调用 `designer_status`，选取明确的 `sessionId`。
4. 调用 `designer_get_document`，读取当前 `revision`；编辑时必须传入 `expectedRevision`。
5. 用 `designer_preview` 检查 PNG 预览，再继续调整或导出。

连接链接含私密令牌，请不要分享。链接中的令牌在连接时从地址栏移除，保存在该标签页的 sessionStorage 中，以支持刷新后重新连接。点击 **断开** 即清除凭据并关闭连接。服务器重启后需要使用新链接；不会自动重连其他服务器。每个浏览器标签页是独立会话，刷新或重连后应重新查询 sessionId，不要长期缓存会话 ID。

默认画布地址是 `http://localhost:1234/`，桥接端口是 `3210`。上面的完整配置已经显式设置这两个值；需要调整时修改该服务器的 env：

<!-- example: client-config -->
```json
{
  "env": {
    "MCP_APP_URL": "http://localhost:1234/",
    "MCP_BRIDGE_PORT": "3210"
  }
}
```

修改画布端口时同步设置 `MCP_APP_URL`。多个 MCP 客户端可设置不同桥接端口，或设为 `0` 自动分配端口；每个服务的连接链接由 `designer_status` 返回。桥接只监听 `127.0.0.1`，校验浏览器 Origin 和每次启动生成的随机令牌，不提供远程公网连接。

## 工具

| 工具 | 功能 |
| --- | --- |
| `designer_status` | 查询连接链接和浏览器会话 |
| `designer_list_symbols` | 搜索真实元件库，读取符号、选项、引脚名和 JSON 示例 |
| `designer_get_document` | 读取当前元件、稳定 ID、几何边界、引脚坐标及完整存档 |
| `designer_find_components` | 按标签、类型、符号、选中状态、文字或邻近位置查找候选，报告歧义 |
| `designer_get_component` | 指定元件详情，含 cm/px 坐标及真实可编辑属性、类型、范围和选项 |
| `designer_get_connections` | 检查指定元件的几何接触，区分引脚接触和导线中段接点 |
| `designer_check_layout` | 只读检查当前图纸的接触、导线重叠、疑似主体重叠和不确定交叉；可限定元件范围 |
| `designer_select` | 在浏览器中选中、定位指定元件；空数组清除选择 |
| `designer_import_tikz` | 将 TikZ 导入为可编辑元件，默认追加并对齐网格，警告默认拒绝 |
| `designer_check_grid` | 只读检查整张图及分组内元件的网格对齐情况，返回偏移量 |
| `designer_apply_operations` | 批量创建、更新、移动、端点/属性编辑、旋转、对齐、分布、复制和删除；支持试算 |
| `designer_history` | 撤销或重做 |
| `designer_export` | 导出当前画布的 TikZ、SVG、JSON，或上次导入的原始源码，返回文本或写入指定文件 |
| `designer_preview` | PNG 预览，可加临时编号、高亮及重叠/交叉诊断，并返回稳定 ID 映射 |
| `designer_fit_view` | 显示完整图纸，或传 ids 聚焦指定顶层元件 |
| `designer_compile` | 用真实 TeX 编译当前画布或保留源码，返回诊断及首张 PDF 页面的 PNG，可保存 PDF |

### 参数约定与默认值

除 designer_status 外，所有工具都要求 sessionId；修改模型或选区另需 expectedRevision。导出和编译可选传入 expectedRevision，要求开始导出时图纸仍与读取时一致。下表省略共同的 sessionId：

| 工具 | 其他必需参数 | 可选参数与默认值 |
| --- | --- | --- |
| designer_status | 无 | 无 |
| designer_list_symbols | 无 | query；limit: 30（1–100） |
| designer_get_document | 无 | includeComponents: true、includeSaveFile: true；都为 false 时只读状态 |
| designer_find_components | 无 | label/type/symbol/query/selected/near；radius: 1、unit: cm、includeChildren: false、limit: 100（1–500） |
| designer_get_component | id | 无 |
| designer_get_connections | ids | tolerancePx: 0.05（0.0001–1） |
| designer_check_layout | 无 | ids；tolerancePx: 0.05（0.0001–1）、limit: 200（1–2000） |
| designer_select | expectedRevision, ids | ids: [] 清空选区，返回新 revision |
| designer_import_tikz | expectedRevision, source | preamble；mode: editable，可选 source；replace: false、allowWarnings: false、snapToGrid: true |
| designer_check_grid | 无 | tolerancePx: 0.0001、limit: 200；容差限制见网格章节 |
| designer_apply_operations | expectedRevision, operations | dryRun: false、analyze: true、diagnosticLimit: 200、includePreview: true、previewMaxDimension: 1400 |
| designer_history | expectedRevision, action | action 为 undo 或 redo |
| designer_export | 无 | expectedRevision；format: tikz，可选 svg/json/source；outputPath: 绝对文件路径；overwrite: false |
| designer_compile | 无 | expectedRevision；representation: canvas，可选 source；engine: xelatex；includePreview: true；maxDimension: 1600；resourceDirectory；outputPath: 绝对 PDF 路径；overwrite: false |
| designer_preview | 无 | maxDimension: 1400、showGrid: true、showDiagnostics: false、annotate: false、highlightIds: [] |
| designer_fit_view | 无 | ids 聚焦指定顶层对象，省略则适配整图 |

每批 operations 为 1–100 项，常规目标 ids 为 1–500 项。预览最大边长为 128–2048，highlightIds 最多 200 项；diagnosticLimit 为 1–2000。near 按参考位置查询，radius 必须大于 0。属性数值使用属性自己报告的单位。正式工具定义由 MCP 客户端读取，表内字符串值在 JSON 中需要双引号。

工具通常通过 MCP 文本内容返回 JSON，预览及带图片的试算还返回 PNG image 内容。失败时检查 isError 和文字原因，不能只根据是否收到响应判断成功。

### 大图纸的轻量读取

只需要判断图纸有没有变化或取得当前选区时，可以省略对象详情和完整存档：

```json
{"sessionId":"会话 ID","includeComponents":false,"includeSaveFile":false}
```

此时仍返回 `revision`、`sourceStatus`、`componentCount`、`selectedIds`、名称和坐标约定。`componentCount` 统计顶层对象。两个开关独立，默认均为 true；后续按稳定 ID 调用 `designer_get_component` 读取所需对象即可。轻量读取省略响应内容，服务仍检查真实模型以保证 revision 正确。

## 通用 TikZ、源码与编译校样

可编辑导入现在支持数值 `\foreach` 列表及范围、带花括号参数的 `\newcommand` / `\def`、`\pgfmathsetmacro` / `\pgfmathtruncatemacro` 的有界数学子集、`plot` 函数曲线、原生三次贝塞尔控制点、命名样式、xcolor 常用颜色与混合，以及二维坐标单位和常见作用域变换。三角函数以度为单位。未知顶层指令、样式或颜色会报告；这不是完整 TeX 解释器。

`preamble` 最多 128 KiB，保存片段依赖的宏、颜色、字体和宏包，例如：

```json
{"sessionId":"会话 ID","expectedRevision":"当前 revision","replace":true,"snapToGrid":false,"preamble":"\\definecolor{chapter}{HTML}{0984e3}","source":"\\begin{tikzpicture}[x=2cm]\\draw[chapter,domain=0:180,samples=100] plot ({\\x/45},{sin(\\x)});\\end{tikzpicture}"}
```

浏览器 UI 导入默认不对齐网格，MCP 的 `snapToGrid: true` 默认值保持兼容。科学图建议显式设为 false。函数曲线以 `type: plot` 存档，保留 x/y 表达式、定义域和采样数；整体移动、旋转和缩放后仍导出 `plot`。用 `designer_get_component` 读取实际的 `plot:*` 属性来修改公式，不能单独编辑采样点。贝塞尔以 `type: bezier` 存档，四个 points 依次为起点、终点、第一控制点、第二控制点；`set_endpoints` 只改变前两个点。

`designer_list_symbols` 的 `shapeExamples` 还提供可直接创建的 `arc`、`bezier` 和 `plot` 存档示例。调用 `designer_apply_operations` 时，将选定示例放入 `{"op":"create","component":示例}`。原生存档坐标使用 px、y 向下；公式中的 `\x` 及导出 TikZ 使用数学坐标。

无法可视化转换的完整文档可以使用 `mode: source`。该模式要求空画布或 `replace: true`，保存原文但不建立画布对象。`designer_export` 的 `format: source` 返回保留的环境定义和上次导入源码；`format: tikz` 继续从当前模型生成代码。`sourceStatus` 报告源码是否存在、是否为源码模式、是否与导入后的画布基线一致，以及导入警告。画布修改不会改写源码快照。原文、环境和基线随原生 JSON、保存及撤销历史保存。

`designer_compile` 的参数示例：

```json
{"sessionId":"会话 ID","expectedRevision":"刚读取的 revision","representation":"canvas","engine":"xelatex","includePreview":true,"outputPath":"E:/Projects/Circuitikz/output/diagram.pdf"}
```

`representation: canvas` 编译当前模型的导出；`source` 编译保留原文。响应包含 `success`、`engine`、`renderer: TeX`、源码哈希、revision 和编译诊断；如可渲染则另附 PNG。校样只展示第 1 页，多页内容以保存的 PDF 为准。工具不改变图纸或撤销历史。依赖项目资源时传绝对 `resourceDirectory`，通过 TeX 搜索路径读取资源；编译临时文件不会写进资源目录。`outputPath` 必须是绝对 `.pdf` 路径，已有文件要求 `overwrite: true`。

MCP 服务进程的 PATH 中需有所选 TeX 引擎（默认 xelatex，也可 lualatex/pdflatex）；PNG 校样还需 `pdftoppm`。编译关闭 shell escape，限制为 45 秒，渲染限制为 20 秒；临时文件在调用结束时清理。缺少编译器、依赖或字体时返回实际诊断，不将浏览器 SVG 当作 TeX 编译通过。

每个 MCP 服务同时运行最多 2 个编译任务，最多另有 8 个排队。支持客户端的 MCP 请求取消：排队中的任务不会启动编译器，已经启动的编译器或 PNG 渲染进程会终止并清理临时文件。取消前已经成功保存的 PDF 可能保留。`expectedRevision` 校验的是取出源码时的版本；排队和编译使用这份固定源码，响应中的 `revision` 与 `sourceSha256` 用于确认结果对应哪一版。

正常编译响应还提供 `queueWaitMs`、`durationMs`，编译成功时提供 `compileMs`，单位均为毫秒。`queueWaitMs` 是编译槽位等待时间；`durationMs` 包括编译及请求的 PNG 渲染，不包括排队。失败响应含 `success: false`、`errorCode` 和诊断；常用错误如下：

| errorCode | 含义 |
| --- | --- |
| `queue_full` | 已达到并发和排队上限，等待现有任务结束后重试 |
| `cancelled` | 请求被取消 |
| `output_exists` | 目标 PDF 已存在，未允许覆盖 |
| `compiler_not_found` | PATH 中找不到指定引擎 |
| `compile_timeout` | TeX 进程超时 |
| `compile_failed` | 真实 TeX 编译失败，检查 diagnostics |
| `compile_request_failed` 或系统错误码 | 版本冲突、输入或文件访问等请求错误，检查 diagnostics |

PNG 不可用但 PDF 编译成功时返回 `previewWarning`，仍可使用 PDF。取消可能由客户端直接结束等待，不能仅依赖最终响应判断是否取消。独立编译器、排队和取消回归入口为 `npm run test:mcp:compile`；需要本地 TeX 环境。

范围限制：循环最多展开 5000 次，单个数值范围最多 2000 项，宏/循环嵌套最多 32 层，展开文本最多 2 MiB；命名样式最多嵌套 20 层、每次展开最多 10000 项和 2 MiB；函数曲线为 2–500 个采样点。画布中的 `ex` 暂按半个 em 近似并明确警告；字体相关细节以真实 TeX 校样为准。复杂库、任意宏展开及基于源码位置的局部回写仍属于后续工作。

## 导出当前代码

调用 `designer_export`，只提供目标画布的 `sessionId`，即可取得当前完整 TikZ 绘图代码：

<!-- example: designer_export -->
```json
{"sessionId":"从 designer_status 取得"}
```

不提供 `outputPath` 时，返回对象含 `revision`、`format: "tikz"` 和 `content`，与原来的调用方式兼容。代码来自当前可编辑模型，包括刚刚用鼠标或 MCP 完成的修改；不要求先保存、重新导入或传入 `expectedRevision`，也不会新增撤销记录。普通图形的宿主文档加载 `tikz`，含电路符号时加载 `circuitikz`。其他格式可选 `svg`、`json` 或 `source`；SVG 为独立图像文本，JSON 为可编辑存档，source 为保留的导入原文及环境定义。

需要固定版本时可选传入 `expectedRevision`。图纸或选区已变化则拒绝导出；重新读取后再调用。编译工具使用同样的校验。

提供 `outputPath` 时，MCP 服务将同一份导出文本直接写入指定文件，不弹浏览器下载框：

<!-- example: designer_export -->
```json
{
  "sessionId": "从 designer_status 取得",
  "format": "tikz",
  "outputPath": "E:/Projects/Circuitikz/output/circuit.tex"
}
```

路径必须是 **运行 MCP 服务的机器上的绝对文件路径**，不能使用相对路径或 `~`。缺失的父目录会自动创建，文件按 UTF-8（无 BOM）写入；扩展名不自动更改，请根据 format 选择 `.tex`、`.svg` 或 `.json`。写入仍受服务进程的系统权限限制。

文件模式返回 `revision`、`format`、`outputPath`、`bytesWritten` 和 `encoding: "utf-8"`，不再重复返回 `content`。默认拒绝覆盖已有文件；需要替换时显式增加 `"overwrite": true`。写入失败返回 `isError: true` 及原因，不改变画布。由于该工具现在可以写文件，其 MCP 工具注解已标记为可能修改文件。更新服务后，重启 MCP 连接以重新读取工具参数。

可运行 `npm run test:mcp:export` 检查导出的服务端协议与文件行为。它使用真实 SDK stdio 消息和带认证的 WebSocket 测试端，不启动浏览器；浏览器加载和实际画布导出仍由 `npm run test:mcp` 检查。设置 `QA_MCP_CHILD_PROCESS=1` 可让前者使用独立 Node 服务进程。

## 绘图工作流

建议先读图纸、查元件和引脚，再画主体，查看 PNG 后调整标注和间距。可以用 TikZ 创建初稿，再针对稳定的 `automationId` 做精细修改。

下面的导入示例调用 `designer_import_tikz`，默认追加到图纸，只有显式提供 `replace: true` 才替换当前图纸。

PNG 预览默认带淡网格，与画布原点、主网格及细分间距对齐，方便 agent 判断位置和距离。缩小时会减少网格线以保持清晰。返回的文字信息包含 `viewBox` 和实际显示的网格间距（SVG px）。预览网格独立于界面的网格显示开关，设置 `showGrid: false` 可获得纯白背景；SVG、TikZ 和 JSON 导出仍保留原图内容。

<!-- example: designer_import_tikz -->
```json
{
  "sessionId": "从 designer_status 取得",
  "expectedRevision": "从 designer_get_document 取得",
  "source": "\\begin{circuitikz}\n\\draw (0,0) to[R,l=$R_1$] (3,0) to[C,l=$C_1$] (3,-2) -- (0,-2) to[V,l=$U$] (0,0);\n\\end{circuitikz}"
}
```

TikZ 坐标单位是 cm，y 向上；原生 JSON、`points`、`pins` 和旧 `move` 操作默认使用 SVG px，y 向下（`1 cm = 96 / 2.54 px`）。新的几何操作默认 cm，y 向上，也可明确 `unit: "px"`。为避免混淆，建议调用时总是写出 `unit`。详情额外返回 `positionCm`、`pointsCm`、引脚的 `cm` 坐标。原生 create.component 和 update.patch 始终使用存档的 px 单位，不接受操作级 unit。

下面是 `designer_apply_operations` 的 operations 数组示例，调用时外层还需提供 sessionId 和 expectedRevision：

<!-- example: designer_apply_operations.operations -->
```json
[
  { "op": "create", "component": { "type": "wire", "points": [{"x":0,"y":0},{"x":80,"y":40}], "directions": ["-|"] } },
  { "op": "update", "id": "元件 automationId", "patch": { "label": { "value": "R_2" } } },
  { "op": "move", "ids": ["元件 automationId"], "dx": 20, "dy": 0 },
  { "op": "delete", "ids": ["元件 automationId"] }
]
```

`update` 对存档做浅层合并，嵌套对象需完整提供，顶层 `null` 删除字段。符号用 `id`（如实际元件库返回的电阻标识）指定；用于编辑定位的稳定 ID 是 `automationId`，工具描述对象的 id 对应该稳定 ID，不能与原生 save.id 的符号标识混淆。`type` 与稳定 ID 不可修改。工具以顶层元件为编辑单位，编组内的内容通过父组完整存档修改。创建和追加时自动生成新 ID，撤销/重做和保存载入时保留 ID。

如果手动修改、鼠标改变选择或其他请求已改变图纸状态，旧 `expectedRevision` 会被拒绝，防止 `selected: true` 操作错误的选区。失败的批量编辑恢复原图和选区，成功编辑写入应用撤销历史并等待 IndexedDB 保存。若浏览器存储失败，结果中会明确给出 `persistenceWarning`。断线或超时后的执行结果可能未知，应重新读图确认，再决定是否重试。

移动默认只影响指定元件；显式 `connections: "follow_wires"` 可以让直接相接的导线端点和接点跟随，但不自动绕过障碍。不支持的导入语法会返回警告，只有明确设置 `allowWarnings: true` 才允许有警告的可编辑导入。绘图工具不验证电气正确性；`designer_preview` 是应用 SVG 渲染预览，`designer_compile` 独立提供真实 TeX 校样。

## 指定元件编辑

推荐顺序：查找候选或读取当前选区 → 读取详情 → 编辑 → 查看编号预览及连接。所有命令都需要明确的 `sessionId`，编辑还需要刚读取的 `expectedRevision`。

### 找到目标

<!-- example: designer_find_components -->
```json
{"sessionId":"会话 ID","label":"R_1"}
```

这是 `designer_find_components` 的参数。标签是精确匹配，不自动转换 LaTeX 拼写；`query` 则在名称、标签、符号及 ID 中进行不区分大小写的子串搜索。还可以提供 `type`、`symbol`、`selected`、`near: {"x":1.5,"y":0}`、`radius`、`unit`。邻近查询按元件参考位置筛选并排序。`total` 计全部结果，`limit` 只限制返回数量，`truncated` 表示截断；多个候选返回 `ambiguous: true`，agent 不应擅自选择第一个。

`designer_get_document` 返回 `selectedIds`。用户可以直接用鼠标选中元件，再让 agent 使用 `selected: true` 操作。也可用 `designer_select` 显式选择 ID，返回新的 revision；选择本身不新增绘图撤销步骤。

需要让用户看到目标时，调用 `designer_fit_view` 并提供 `ids`，浏览器视图会聚焦这些元件；不提供 ids 则显示完整图纸。它只改变视图，不改变模型、revision 或导出内容。

`designer_preview` 提供 `annotate: true`、`highlightIds: ["稳定 ID"]`。编号和高亮只画在此次 PNG 上，不污染画布、TikZ、SVG 或 JSON。返回文字中的 `annotations` 将编号映射到稳定 ID；编号属于此次 revision，不是可长期保存的 ID。最多编号 200 个顶层对象，超出时返回 `annotationsTruncated: true`。

### 读取真实属性

调用 `designer_get_component`，传入 `id`。`editableProperties` 返回真正的 UI 属性 ID、标签、当前值、类型、是否禁用，以及下拉选项的 key/name 和数值范围。`number` 使用该属性的 `unit`，不是操作级坐标单位；`restricted` 区分硬范围和 UI 滑块的建议范围。`choice` 修改时传 key，不传名称或整个对象。颜色用 `#RRGGBB`，允许恢复默认时 `nullable: true`；禁止修改禁用或不存在的字段。

下面的属性、移动、端点和试算示例均调用 `designer_apply_operations`。

例如，电阻标签的实际属性 ID 是 `label:label`，下面的编辑只改文字，保留原标签侧、颜色及间距：

<!-- example: designer_apply_operations -->
```json
{
  "sessionId":"会话 ID",
  "expectedRevision":"当前 revision",
  "operations":[
    {"op":"set_properties","ids":["电阻稳定 ID"],"values":{"label:label":"R_2"}}
  ]
}
```

属性编辑执行与 UI 相同的校验和变化监听器，支持文字、公式、布尔值、颜色、数值、下拉框及单选项。按钮与信息栏不作为属性执行。和旧的原生 `update.patch` 不同，`set_properties` 不要求重写整个嵌套对象。

### 几何和批量操作

除 `create` 和旧 `update` 外，操作以 `ids: [...]` 或 `selected: true` 定位，必须二选一。空选区会报错，不会退化为“整图”。

| op | 参数与语义 |
| --- | --- |
| `create` | component 为完整原生存档；先从 designer_list_symbols 取得真实示例，不猜测符号 ID |
| `update` | id、patch，浅合并顶层原生存档，嵌套对象需完整提供 |
| `move` | `dx,dy,unit` 相对平移；保留旧默认 px，建议显式写 unit |
| `move_to` | `position,unit`；单元件移到参考位置，多元件把参考位置的平均值移到目标 |
| `set_endpoints` | `start`、`end` 可指定一个或两个；只允许一个路径对象，保留中间参考点 |
| `set_points` | `points,unit`；改一个路径的所有参考点，点数必须不变。要改变折线路由的点数或方向，仍用原生 `update` 提供完整 points/directions |
| `set_properties` | `values` 按实际属性 ID 修改，保留未指定属性 |
| `rotate` | `angle` 为角度，正数逆时针；`pivot,unit` 可指定中心，否则按目标参考位置平均值旋转 |
| `align` | `axis: "x"/"y"`，至少两个目标，对齐参考位置；给 `referenceId` 时对齐到它，否则对齐到目标的平均位置。不是按标签包围盒边缘对齐 |
| `distribute` | `axis: "x"/"y"`，至少三个目标；保留两端参考位置，中间按参考位置等距分布 |
| `duplicate` | `dx,dy,unit`；偏移默认均为 0，应主动设置避免原地重叠。复制后返回源 ID → 新 ID 的映射，编组内子元件同样生成新 ID |
| `delete` | 删除显式 ID 或当前选区 |

例如，“把当前选中的电阻向右移动 1 cm，同时让相接导线端点跟随”：

<!-- example: designer_apply_operations -->
```json
{
  "sessionId":"会话 ID",
  "expectedRevision":"当前 revision",
  "operations":[
    {"op":"move","selected":true,"dx":1,"dy":0,"unit":"cm","connections":"follow_wires"}
  ]
}
```

再如，“保持电阻左端，右端移到 (4,2) cm”：

<!-- example: designer_apply_operations -->
```json
{
  "sessionId":"会话 ID",
  "expectedRevision":"当前 revision",
  "operations":[
    {"op":"set_endpoints","ids":["电阻稳定 ID"],"end":{"x":4,"y":2},"unit":"cm","connections":"follow_wires"}
  ]
}
```

这些几何编辑不自动吸附网格；可在完成后调用 `designer_check_grid` 检查。运放等多引脚节点支持整体移动和旋转，其引脚由符号决定，不能当成二端路径拉伸。

### 连接策略、试算与撤销

- `connections: "detach"` 是默认值，仅改变目标，其他导线保留原位置。
- `connections: "follow_wires"` 根据编辑前后引脚坐标，移动直接相接的 wire/short 端点及接点，保留导线中间参考点；HV/VH 路由的隐式拐点按原方向重新计算。接触容差为 0.05 px，以容纳存档坐标舍入。
- 若同一旧接点被拉到两个不同位置、接点直接连着未包含的刚性元件，或接点位于导线中段，操作会拒绝并整体回滚。请显式编辑完整连接集合或使用 detach；工具不会猜测复杂布线意图。
- `designer_get_connections` 可在编辑前后检查几何接触，但不把交叉线自动解释为电气连接，不提供完整电气网表或电路等价性证明。
- `dryRun: true` 放在 apply_operations 的顶层，会执行校验并返回 `proposed` 图纸、`changes`、`diagnostics` 及建议状态的 PNG。原图、选区和 revision 在异步渲染开始前同步恢复，不保存、不改变撤销历史，也不会在图片生成期间覆盖用户的新修改。`proposed` 不含可用于提交的 revision；试算产生的新 ID 也不是现存元件 ID。正式执行前重新读图确认变化，以当前 revision 重新调用并去掉 dryRun。试算不是待提交事务，不提供锁定或提交令牌。
- 正式批次只占一个绘图撤销步骤，返回 `changes.createdIds/deletedIds/modifiedIds` 及 `operationResults`。跟随移动的导线也会列入 modifiedIds。
- 编组子元件可以查询、读取详情；`parentIds/topLevelId/editable` 明确指明归属。当前以顶层对象为编辑单位，直接修改子元件会拒绝；可以整体编辑父组或用旧 update 提供完整编组存档。

升级后重启 MCP 服务以刷新工具定义，重新取得连接链接，并刷新/重新连接应用页面以加载新浏览器代码。

### 试算预览与连接、重叠变化

apply_operations 默认 `analyze: true`，对整个批次执行前后的几何状态作对比，正式编辑和 dryRun 都返回 `diagnostics`。不是按坐标判断连接身份，而是按稳定的元件 ID、命名引脚或端点索引匹配，所以一起移动后仍相接的关系属于保留。

<!-- example: designer_apply_operations -->
```json
{
  "sessionId":"会话 ID",
  "expectedRevision":"当前 revision",
  "dryRun":true,
  "operations":[
    {"op":"move","ids":["电阻稳定 ID"],"dx":0,"dy":1,"unit":"cm","connections":"detach"}
  ]
}
```

返回的 MCP `content` 同时包含 JSON 文字和 PNG 图像。JSON 的 `preview` 只含图片元数据，不把 base64 塞进文字；`preview.state` 为 `proposed`，`preview.baseRevision` 指向试算依据的原图版本。PNG 是建议图纸，不是恢复后的原图。`previewMaxDimension` 可设 128–2048，默认 1400；不需要图片时使用 `includePreview: false`。若图片解码失败，原图仍已恢复，返回 `previewWarning`，保留建议状态和诊断结果。

`diagnostics` 的三类结果分别返回 `counts`、`preserved`、`removed`、`added` 和 `truncated`：

| 类别 | 含义 |
| --- | --- |
| `connections` | 保留、断开和新增的引脚接触或引脚/端点与导线中段接触 |
| `overlaps` | 仍存在、已消除和新增的重叠关系，进一步按 kind 区分下述三种情况 |
| `crossings` | 仍存在、已消失和新增的不确定导线交叉，不自动作为接通或短路 |

重叠的 kind：

- `wire-overlap`：两个 wire/short 的中心线共线，并有超过容差的共同长度，返回重叠线段。仅端点相碰不属于重叠。
- `component-bounds-overlap`：元件主体的旋转包围区域有正面积重叠，返回区域。不是标签外框；该结果标为 potential，因为符号包围区域包含轮廓内的空白，需视觉确认。
- `wire-component-overlap`：导线中心线穿入元件主体的旋转包围区域，返回内部线段，同样标为 potential。正常引脚端点接触不因此判成碰撞。

每条关系提供 `ids`、元件类型/符号/标签/父组信息、代表位置 `point`，以及相应的引脚或区域/线段。保留项给出 `before` 和 `after`，可比较移动前后的位置。重叠与交叉按“对象对 + kind”汇总；一对导线的代表位置不等于全部交点清单，重叠线段最多列 100 段，超过时标记 `geometryTruncated`。

试算 PNG 默认标出**本批次变化**：红圈是已断开接触的旧位置，绿圈是新增接触，琥珀色是新增重叠，紫色是新增不确定交叉。移出建议图纸原边界的旧接点也会包含在预览范围内。`diagnosticLegend` 返回图例；最多显示 200 个关系标记，`diagnosticMarkersTruncated` 明确说明图片是否只显示部分。

检查当前图纸时可调用 `designer_check_layout`，或让 `designer_preview` 带 `showDiagnostics: true`。后者显示当前的重叠/交叉，并返回当前布局报告；不会修改画布或导出。只读检查接受 `ids`（可含编组 ID，展开其子元件）、`tolerancePx` 和 `limit`；数组放在 `connections/overlaps/crossings.items` 中，另有完整 `total` 和截断标志。

检查范围与限制：

- 检查几何接触和主体包围区域，不构建电气网表，不判断电路正确性，不把交叉自动解释为短路。交叉处显式接点通过接点与两条导线的关系表达，不再列为不确定交叉。
- 支持直线、实际折线、HV/VH 隐式拐点及已经采样为折线的曲线。纯标签、open 电压标注和 arc 弯曲注释箭头不作为电气导线或元件主体检查；不做文字重叠和逐像素/线宽相交检测。
- 新增重叠或断开是观察结果，不会自动取消正式编辑；连接保持操作本身原有的安全拒绝规则继续生效。agent 应对照用户意图评估，不可把允许断开的编辑一概视为错误。
- `diagnosticLimit` 默认 200，只限制每个变化数组的详情，`counts` 保留总数；设 `analyze: false` 可省略自动对比。
- 每次扫描有候选对象对和线段对的计算预算。`coverage` 披露缺失主体几何、已扫描数量和预算限制。若任一侧不完整，`diagnostics.complete: false`，会扣留新增/断开的结论，不把“没扫描到”当成“已不存在”；可以用只读工具限定 IDs 后继续检查。

## 验证

这部分面向开发者，正常使用 MCP 无需测试环境。源码 ZIP 不附带 .qa-tools 环境。完成前面的两处依赖安装后，Windows 测试另需 Microsoft Edge 和 Playwright：

```powershell
npm install --prefix .qa-tools --no-audit --no-fund playwright@1.64.1
npm run build
npm run test:mcp
```

未设置 QA_APP_URL 时，测试自行服务 dist，因此需先构建。其他 qa-* 脚本可能还需要额外依赖、外部课程样本或 TeX 工具，不是正常 MCP 使用的前提。

构建应用后运行 `npm run test:mcp`。测试使用真实浏览器和官方 SDK 的 stdio 消息编解码，检查连接、认证、多会话、元件编辑、版本冲突、失败回滚、撤销/重做、导出、PNG 与刷新恢复。可使用 `.qa-tools/node_modules/playwright`，或在项目内安装 Playwright。可设置 `QA_CDP_URL` 连接专用的已启动测试浏览器，不要指向保存日常工作状态的浏览器。

也可对运行中的 `npm start` 执行相同检查。测试使用独立浏览器上下文，不修改现有浏览器的图纸：

```powershell
$env:QA_APP_URL = "http://localhost:1234/"
$env:QA_OUTPUT_DIR = "qa-results/mcp-dev"
npm run test:mcp
```

测试报告、PNG、SVG、TikZ 和 JSON 保存在 `qa-results/mcp/`，设置 `QA_OUTPUT_DIR` 可更换目录。

## 网格对齐与检查

`designer_import_tikz` 默认 `snapToGrid: true`，依据当前画布的主网格及细分设置对齐到细网格，以世界原点 `(0,0)` 为基准。设置 `snapToGrid: false` 可保留导入坐标。返回值中的 `gridAlignment` 只统计本次导入的元件。

对齐使用共享坐标映射，尽量保留相接端点、水平和竖直关系；为避免把相近节点合并，或拉伸刚性多引脚符号，部分点可能保留原坐标。因此“已执行对齐”不保证所有点都在网格上，请读取 `allAligned` 和 `issues`。

调用 `designer_check_grid` 检查整张图，无须 `expectedRevision`，不会移动元件或新增撤销步骤：

<!-- example: designer_check_grid -->
```json
{"sessionId":"从 designer_status 取得","tolerancePx":0.0001,"limit":200}
```

检查路径的端点和控制点、节点符号的引脚（没有引脚时检查位置）、其他元件的位置，并递归检查分组。标签边界、符号视觉轮廓和路径元件中心不作为判据。`issues` 返回元件 ID、祖先分组 ID、点坐标、最近网格点和 `delta`（最近点减当前点），单位均为 SVG px。`tolerancePx` 按各坐标轴判断，默认 `0.0001`，最大为 `1` 且不能超过网格间距一半。`limit` 只限制问题明细数量，不影响总计；`truncated` 表示明细被截断。空图的 `allAligned` 为 true、检查点数为 0。

建议流程：导入 → 读取 `gridAlignment` → 编辑 → `designer_check_grid` → 检查 PNG。不要逐点机械套用 `delta`，以免断开相连导线；必要时统一更新连接两端。网格检查不判断电气连接或电路正确性。


## 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| 找不到 node 或 MCP 进程无法启动 | 检查版本、客户端 PATH 及配置中的绝对路径，必要时使用 node.exe 完整路径 |
| 缺少 Parcel、SDK、ws 或 zod | 分别执行根目录 npm ci 和 npm --prefix mcp ci |
| EADDRINUSE | 关闭重复服务，或修改 MCP_BRIDGE_PORT，也可设为 0 自动分配 |
| status 没有浏览器会话 | 确认 npm start 仍在运行，打开本次服务的 connectUrl，查看网页 MCP 状态 |
| 网页端口改变、WebSocket 被拒绝 | MCP_APP_URL 应指向实际本地 HTTP 网页地址；修改后重启服务并使用新链接。支持 localhost/127.0.0.1 同端口别名，不支持任意 Origin |
| 重启后链接失效或 sessionId 不存在 | 重新调用 status，使用新链接连接，再查询 sessionId |
| revision 冲突 | 重读图纸和选区，检查用户最近修改，再基于新 revision 规划 |
| 标签匹配多个对象 | 结合候选详情、编号 PNG 或用户选区识别，不取第一个候选 |
| selected 操作报空选区 | 先用鼠标或 designer_select 选择，使用选择后的新 revision |
| 属性或选项值被拒绝 | 从 get_component 读取真实属性 ID、choice key、单位、范围及 disabled 状态 |
| follow_wires 拒绝 | 检查完整连接范围或重新规划，不能默默改为 detach |
| 导入警告 | 检查不支持的 TeX 语法，仅在接受可能不完整的结果时设置 allowWarnings；不会自动读取外部 TeX 文件 |
| diagnostics.complete 为 false | 检查 coverage，使用 ids 缩小检查范围，不完整报告不能证明无问题 |
| previewWarning / persistenceWarning | 前者为图片失败且试算原图已恢复；后者为持久化失败，应导出 JSON 备份并检查浏览器存储 |
| 超时或断线 | 操作可能已执行，重连后先读图确认，避免重复导入、移动或复制 |

试算不是待提交事务，不提供锁定或提交令牌。正式执行前重读当前图纸，确认变化后以当前 revision 重新调用，去掉 dryRun；不要把 proposed 的临时 ID 当成现存元件 ID。

## 源码 ZIP 内容

源码包保留网页源码、MCP 服务及本说明、两份依赖锁文件、构建/测试脚本、示例、元件 XML schema 和必要配置。解压后从本文的 npm ci 开始安装，目录可自行选择。

包内不带 node_modules、.qa-tools、.git、编辑器目录、Parcel 缓存、dist 编译结果、测试截图/结果、日志或本机环境文件。npm run build 可重新生成 dist。若改用本地 HTTP 服务托管 dist，MCP_APP_URL 应同步修改；不要用 file:// 打开页面作为 MCP 连接入口。
