# CircuiTi*k*Z-Designer

本仓库在 [Circuit2TikZ/CircuiTikZ-Designer](https://github.com/Circuit2TikZ/CircuiTikZ-Designer) 的 `main`（`67d1ebf`，v0.8.2）基础上整合扩展功能，维护于 [EternalLightning/CircuiTikZ-Designer](https://github.com/EternalLightning/CircuiTikZ-Designer)。下文的“本地版本”指本分支版本。回归脚本位于 `scripts/qa-*.cjs`；报告中的 `qa-results/` 是本地生成的验证产物，不随源码提交。

本地版本现已加入通用 TikZ 工作台的第一阶段功能：函数曲线、原生贝塞尔控制点、数值循环、计算宏、坐标单位与作用域变换、样式和颜色。CircuitikZ 的元件、标注和编辑接口继续保留。实现范围与验证结果见 [通用化实施说明](TIKZ_GENERALIZATION_IMPLEMENTATION.md)。这些新增功能属于当前本地版本。

导入窗口可单独提供宏、颜色、字体和宏包等环境定义；普通导入默认保留坐标。新增“保留源码模式”及“导出保留源码”，原始导入文本会随 JSON、浏览器存档及撤销历史保存。当前图形导出反映画布修改，保留源码导出反映上次导入，两者分别标明用途。

MCP 新增 `designer_compile`，可用本地 TeX 编译当前图形或保留源码并取得真实校样。默认 XeLaTeX；PNG 校样另需 Poppler 的 `pdftoppm`。普通浏览器画布仍可在没有 TeX 时使用。连接配置与示例见 [MCP 使用说明](mcp/README.md)。

已补充数学表达式编译缓存、曲线采样复用，以及 MCP 轻量读取、导出/编译版本校验、编译排队与取消。实测数据、缺陷修复和整库验收见 [优化报告](TIKZ_OPTIMIZATION_REPORT.md)。

[![License](https://img.shields.io/github/license/circuit2tikz/circuitikz-designer)](LICENSE)
![GitHub last commit (dev)](https://img.shields.io/github/last-commit/circuit2tikz/circuitikz-designer/dev)
![GitHub commit activity (dev)](https://img.shields.io/github/commit-activity/m/circuit2tikz/circuitikz-designer/dev)
![GitHub Issues or Pull Requests](https://img.shields.io/github/issues/circuit2tikz/circuitikz-designer)

An interactive, visual, online editor for creating electrical circuit diagrams for LaTeX/CircuiTi*k*Z with ease. Try it out [online](https://circuit2tikz.tf.fau.de/designer/)!

## Overview

CircuiTi*k*Z-Designer bridges the gap between visual circuit design and precise LaTeX code, letting you design, customize, and export diagrams without manually writing TikZ commands.
Whether you’re preparing academic papers, teaching materials, or engineering documentation, CircuiTi*k*Z-Designer provides:

- A clean, intuitive interface for fast diagram creation
- An extensive component library for all your circuit needs
- Real-time previews and instant export to high-quality LaTeX code

Stop wrestling with code syntax — focus on your circuit design, and let CircuiTikZ-Designer handle the Ti*k*Z.

|         Edit in CircuiTi*k*Z-Designer         |            Export to compilable Ti*k*Z code            |
| :-------------------------------------------: | :----------------------------------------------------: |
| ![sallen-key edit](./examples/sallen-key.png) | ![sallen-key export](./examples/sallen-key_export.png) |

|               Use it in your LaTeX project!                |
| :--------------------------------------------------------: |
| ![sallen-key overleaf](./examples/sallen-key_overleaf.png) |

## Key Features

- **Visual Circuit Design:** Intuitive interface with multi-tab support and component grouping
- **Wide Component Library:** Includes most circuit elements plus some tikz components like rectangles, ellipses and arrows
- **Export Ready:** Generate clean LaTeX/TikZ code and compatible SVG exports for seamless document integration
- **Advanced Editing:** Rotate, scale, align, distribute, and snap components with clear visuals and flexible editing capabilities
- **Component Variants:** Easily switch between different versions of components and adjust their properties via the properties window
- **Cross-Platform Friendly:** Dark mode and mobile support for comfortable online editing anywhere
- **MathJax Support:** Write MathJax math expressions directly inside text components with real-time rendering

## Use locally

This project supports the browser version. Electron desktop builds are no longer maintained or included.

1. Have [Node.js](https://nodejs.org/) 20 or later installed
2. Clone the repository or extract the source ZIP
3. Run "npm ci" in terminal in project directory
4. Run "npm start" in terminal in project directory
5. Open website at URL provided in command line output

Startup resources (MathJax 3.2.2, Computer Modern fonts and Material Symbols) are included locally in `src/vendor`; opening the editor does not require a CDN connection. `npm start` builds the editor when the server starts, so the first browser visit no longer triggers a lazy build. Restart an already running development server after updating. For a deployed site, rebuild with `npm run build` and serve the updated `dist` directory.

## How to use

Local agents can operate the browser canvas through the optional [MCP server](./mcp/README.md), including document inspection, editable circuit creation, batch edits, undo/redo, exports, and PNG previews. Run `npm run mcp:install` once, keep using `npm start`, and connect the agent using the MCP guide.
`designer_export` returns text by default, or writes UTF-8 directly to an absolute `outputPath`; existing files require `overwrite: true`.

All controls of the application are explained in the help menu in the top right corner via the circled questionmark in the application itself.

If you need help, please use the [general discussions](https://github.com/Circuit2TikZ/CircuiTikZ-Designer/discussions/categories/general) page.

## Contributing

### Bug reporting

Please use the [issues page](https://github.com/Circuit2TikZ/CircuiTikZ-Designer/issues) of the project to report bugs. Please always provide steps on how to reproduce the bug.

### Feature requests

You can post feature requests and discuss them on the [discussions](https://github.com/Circuit2TikZ/CircuiTikZ-Designer/discussions/categories/ideas) page.

### Contribute code/component implementations

Fork the repo, and create a pull request. Please always test your code thoroughly!
