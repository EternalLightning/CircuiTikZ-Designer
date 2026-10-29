# MCP 调用检查与文件导出变更

日期：2026-10-26。修改范围为 `E:/Projects/Circuitikz/CircuiTikZ-Designer`；未同步到 Qoder 使用的 `E:/Projects/SJTUCircuitsCamp/CircuiTikZ-Designer`，未修改客户端配置。

## 调用检查

- 当前会话的 `node_repl` MCP 工具实际请求、响应正常。
- 当前会话工具列表与 Codex 配置中未注册 `circuitikz-designer`，因此不能声称已通过当前客户端直接调用该工具。
- 使用项目安装的官方 MCP SDK，完成 initialize、tools/list、工具参数校验和调用；通过真实 TCP WebSocket 及令牌认证连接测试端。10 项后端集成检查通过，详见 `qa-results/mcp-export/results.json`。
- 独立 stdio 子进程启动被沙箱拒绝，错误为 `spawn EPERM`。完整浏览器套件已通过协议协商、断线状态及错误令牌/Origin 拒绝检查，然后在启动 Edge 时同样被 `spawn EPERM` 阻止。浏览器页面初始化、真实画布导出的端到端结果仍未验证。
- 后端集成检查使用确定性 WebSocket 测试端提供文本，不替代真实画布检查，也不证明外部 CDN 可达。

## 新导出接口

工具仍为 `designer_export`：不传 `outputPath` 时返回原来的 `revision`、`format` 和 `content`；传入绝对文件路径后，服务端创建缺失父目录并以 UTF-8 无 BOM 写入，返回 `revision`、`format`、`outputPath`、`bytesWritten`、`encoding`，不重复传输正文。

支持 TikZ（默认）、SVG、JSON。文件路径属于运行 MCP 服务的机器，使用原样扩展名；相对路径、空路径和 NUL 字符被拒绝。默认拒绝覆盖，显式 `overwrite: true` 才替换文件。浏览器导出失败时不创建文件。写入受服务进程的操作系统权限限制。

```json
{
  "sessionId": "从 designer_status 取得",
  "format": "tikz",
  "outputPath": "E:/Projects/Circuitikz/output/circuit.tex",
  "overwrite": false
}
```

导出仍不修改画布或撤销历史。由于可写文件，MCP 工具注解改为可能修改数据。另修正本项目 `scripts/qa-mcp.cjs` 的四处 Playwright 等待调用，将超时选项放到第三个参数。

## 验证与后续使用

`node scripts/qa-mcp-export.cjs` 的 10 项检查覆盖：协议与参数、认证会话、默认文本兼容、三种格式文件与文本逐字节一致、中文路径、父目录创建、拒绝覆盖、显式覆盖、非法路径、文件系统错误、浏览器错误以及并发写入唯一成功。脚本和服务端语法检查通过。

在允许启动进程的环境，可设置 `QA_MCP_CHILD_PROCESS=1` 再执行后端检查，并运行 `npm run test:mcp` 完成真实浏览器检查。完整套件已加入实际画布导出文本与文件对比。

使用新功能需要更新实际运行的 `mcp/server.mjs` 并重启 MCP 连接，重新加载工具参数。
