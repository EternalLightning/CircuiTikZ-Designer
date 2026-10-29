import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { createBridge } from "./bridge.mjs"
import { pathToFileURL } from "node:url"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, resolve } from "node:path"
import { compileTikz } from "./compile.mjs"
import { createCompileQueue } from "./compileQueue.mjs"

const sessionId = z.string().min(1).describe("Browser sessionId returned by designer_status.")
const expectedRevision = z.string().min(1).describe("Revision from designer_get_document or the last successful edit. A stale revision rejects the edit.")
const ids = z.array(z.string().min(1)).min(1).max(500)
const savedComponent = z.record(z.string(), z.unknown()).describe("Native component save object. Inspect designer_get_document and the examples from designer_list_symbols. Coordinates are SVG px, x right/y down.")
const target = { ids: ids.optional(), selected: z.literal(true).optional().describe("Use the current browser selection instead of ids; expectedRevision guards selection changes too. Supply exactly one targeting method.") }
const point = z.object({ x: z.number().finite(), y: z.number().finite() })
const unit = z.enum(["cm", "px"]).default("cm").describe("cm uses TikZ coordinates, y up; px uses canvas coordinates, y down.")
const connections = z.enum(["detach", "follow_wires"]).default("detach").describe("detach edits only targets. follow_wires moves directly attached wire/short endpoints and junction dots; refuses rigid shared pins and wire-interior contacts. Does not route around obstacles.")
const operation = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), component: savedComponent }),
  z.object({ op: z.literal("update"), id: z.string().min(1), patch: savedComponent.describe("Shallow merge into the current save object. Supply full nested label/text/stroke objects. null deletes a field; type and automationId cannot be changed.") }),
  z.object({ op: z.literal("move"), ...target, dx: z.number().finite(), dy: z.number().finite(), unit: z.enum(["cm", "px"]).default("px"), connections }),
  z.object({ op: z.literal("delete"), ...target }),
  z.object({ op: z.literal("move_to"), ...target, position: point, unit, connections }),
  z.object({ op: z.literal("set_endpoints"), ...target, start: point.optional(), end: point.optional(), unit, connections }),
  z.object({ op: z.literal("set_points"), ...target, points: z.array(point).min(2).max(500), unit, connections }),
  z.object({ op: z.literal("set_properties"), ...target, values: z.record(z.string(), z.union([z.string(), z.number().finite(), z.boolean(), z.null()])), connections }),
  z.object({ op: z.literal("rotate"), ...target, angle: z.number().finite().min(-36000).max(36000), pivot: point.optional(), unit, connections }),
  z.object({ op: z.literal("align"), ...target, axis: z.enum(["x", "y"]), referenceId: z.string().min(1).optional(), connections }),
  z.object({ op: z.literal("distribute"), ...target, axis: z.enum(["x", "y"]), connections }),
  z.object({ op: z.literal("duplicate"), ...target, dx: z.number().finite().default(0), dy: z.number().finite().default(0), unit }),
])
export function createDesignerServer(bridge) {
const scheduleCompile = createCompileQueue()
const server = new McpServer({ name: "circuitikz-designer", version: "0.1.0" }, {
  instructions: "Operate the user's live CircuiTikZ browser canvas. First call designer_status and connect a browser using its URL, then choose a sessionId. List symbols and read the document. Read coordinates and pins to plan geometry, edit with expectedRevision, inspect a PNG preview, and export. Import TikZ uses cm with y up; native JSON uses SVG px with y down (96 px/inch, 37.79527559 px/cm). Import appends and aligns to the minor grid by default. Inspect gridAlignment after importing and use designer_check_grid after edits; preserve connectivity when correcting remaining offsets. Find candidates and read designer_get_component before editing; use actual property ids and choice keys. Target stable ids or the current selection; revisions also guard mouse selection changes. New geometric operations use cm/y-up unless specified; legacy move defaults to px/y-down. Set connections=follow_wires to move directly attached conductor endpoints and junction dots; complex shared or wire-interior contacts are refused. detach leaves other routes unchanged. Explicitly choose a connection policy; for edits intended to keep a circuit connected use follow_wires and never silently fall back to detach after refusal. Never resolve an ambiguous label by taking the first candidate. Use numbered/highlighted previews to identify targets. dryRun includes a proposed-state PNG and geometric diagnostics without committing. Inspect preserved/removed/added contacts and overlaps, and use designer_check_layout for current-scene checks. Body bounds overlap is potential; plain wire crossings do not establish an electrical connection. Warnings are rejected unless allowWarnings is true. Batch edits are one undo step. Never retry an uncertain operation blindly; reread the document. This tool draws diagrams, it does not simulate or verify electrical correctness.",
})

function register(name, description, inputSchema, method, readOnly = true) {
  server.registerTool(name, {
    description, inputSchema,
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, idempotentHint: readOnly, openWorldHint: false },
  }, async args => {
    try {
      const result = method === "status" ? bridge.status() : await bridge.request(args.sessionId, method, args)
      if (method === "export" && args.outputPath !== undefined) {
        if (typeof result.content !== "string") throw new Error("Browser export did not return text; no file was written.")
        const outputPath = resolve(args.outputPath)
        await mkdir(dirname(outputPath), { recursive: true })
        try {
          await writeFile(outputPath, result.content, { encoding: "utf8", flag: args.overwrite ? "w" : "wx" })
        } catch (error) {
          if (error.code === "EEXIST") throw new Error(`Output file already exists: ${outputPath}. Set overwrite=true to replace it.`)
          throw new Error(`Cannot write export to ${outputPath}: ${error.message}`)
        }
        return { content: [{ type: "text", text: JSON.stringify({ revision: result.revision, format: result.format, outputPath, bytesWritten: Buffer.byteLength(result.content, "utf8"), encoding: "utf-8" }) }] }
      }
      if (method === "preview") return {
        content: [
          { type: "text", text: JSON.stringify({ revision: result.revision, width: result.width, height: result.height, viewBox: result.viewBox, grid: result.grid, annotations: result.annotations, annotationsTruncated: result.annotationsTruncated, diagnosticMarkerCount: result.diagnosticMarkerCount, diagnosticMarkersTruncated: result.diagnosticMarkersTruncated, diagnosticLegend: result.diagnosticLegend, diagnostics: result.diagnostics }) },
          { type: "image", mimeType: "image/png", data: result.data },
        ],
      }
      if (result.preview?.data) {
        const { data, ...metadata } = result.preview
        return { content: [{ type: "text", text: JSON.stringify({ ...result, preview: metadata }) }, { type: "image", mimeType: "image/png", data }] }
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }] }
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }
    }
  })
}

register("designer_status", "List connected browser canvases and obtain the private browser connection URL. Works before any browser connects.", {}, "status")
register("designer_list_symbols", "Search the real component library. Returns symbol ids, options, pin names, and native JSON creation examples.", {
  sessionId, query: z.string().max(200).optional(), limit: z.number().int().min(1).max(100).default(30),
}, "symbols")
register("designer_get_document", "Read the live editable document, revision, source status, top-level component count, selection, geometry and native JSON. For a compact status response set includeComponents=false and includeSaveFile=false; use designer_get_component for chosen objects. Defaults preserve full output.", {
  sessionId, includeComponents: z.boolean().default(true), includeSaveFile: z.boolean().default(true),
}, "document")
register("designer_find_components", "Find candidates by exact label, type, symbol, selection, text search or nearby position. Returns stable ids and ambiguity; never automatically chooses the first match. Group children can be inspected but edits target their top-level group.", {
  sessionId, query: z.string().max(200).optional(), label: z.string().max(1000).optional(), type: z.string().max(50).optional(), symbol: z.string().max(200).optional(), selected: z.boolean().optional(),
  near: point.optional(), radius: z.number().finite().positive().default(1), unit, includeChildren: z.boolean().default(false), limit: z.number().int().min(1).max(500).default(100),
}, "find_components")
register("designer_get_component", "Inspect one stable component id: native state, cm/px geometry, electrical pins, parent group, capabilities and actual editable property ids, types, values, choices and numeric ranges. Pass choice keys and property ids to set_properties.", { sessionId, id: z.string().min(1) }, "component")
register("designer_get_connections", "Inspect geometric pin contacts and wire-interior junctions for explicit ids. Not an electrical netlist: crossing/insulation semantics are not inferred. Coordinates and tolerance use canvas px.", { sessionId, ids, tolerancePx: z.number().finite().min(0.0001).max(1).default(0.05) }, "connections")
register("designer_check_layout", "Read-only geometric layout inspection: pin contacts, positive-length collinear wire overlap, potential oriented component-body bounds overlap, wires penetrating body bounds, and ambiguous wire crossings. Labels and curved annotation arrows are excluded. Normal endpoint contact and junction dots are not wire overlap; crossings do not imply a short circuit. Reports coverage/budget limits and bounded details. Optionally restrict to pairs involving ids (including group descendants).", {
  sessionId, ids: ids.optional(), tolerancePx: z.number().finite().min(0.0001).max(1).default(0.05), limit: z.number().int().min(1).max(2000).default(200),
}, "check_layout")
register("designer_select", "Select/highlight explicit top-level component ids in the live browser, or clear with an empty array. Changes selection only, without a drawing undo step; returns the new revision. Then selected:true can target this selection. Requires current expectedRevision.", { sessionId, expectedRevision, ids: z.array(z.string().min(1)).max(500) }, "select", false)
register("designer_import_tikz", "Parse CircuiTikZ into editable components and align to the current minor grid by default. Appends unless replace=true. Rejects parser warnings by default. A successful import is one undo step. Returns gridAlignment for imported components; rigid multi-pin symbols and crowded coordinates can remain off-grid to preserve geometry and connections. Set snapToGrid=false to preserve source coordinates.", {
  sessionId, expectedRevision, source: z.string().min(1).max(1024 * 1024),
  preamble: z.string().max(128 * 1024).optional().describe("Project macros, colors, fonts and packages needed by this fragment. Preserved with the source and native JSON."),
  mode: z.enum(["editable", "source"]).default("editable").describe("editable builds canvas objects; source preserves arbitrary TikZ/TeX unchanged without interpreting it. Source mode requires replace=true or an empty canvas."),
  replace: z.boolean().default(false), allowWarnings: z.boolean().default(false), snapToGrid: z.boolean().default(true),
}, "import", false)
register("designer_check_grid", "Read-only grid alignment check for the whole document, including grouped children. Checks path control/end points, node-symbol pins (or position if no pins), and other component positions against the current minor grid at world origin. Returns off-grid coordinates, nearest grid points and deltas in SVG px. Does not check label outlines, visual bounds or electrical correctness. Some rigid symbol pins cannot all fit the grid without distortion.", {
  sessionId, tolerancePx: z.number().finite().min(0).max(1).default(0.0001).describe("Per-axis tolerance in SVG px; must also be no greater than half the grid spacing."),
  limit: z.number().int().min(1).max(2000).default(200).describe("Maximum reported point issues; totals always cover the whole document."),
}, "check_grid")
register("designer_apply_operations", "Atomically edit explicit stable ids or the current selection. Supports create/update/delete, move/move_to, set_endpoints/set_points, typed set_properties, rotation, reference-position alignment/distribution and duplicate. Read get_component before property edits. New geometry operations default to cm/y-up, legacy move defaults px/y-down. Connection policy is explicit. All operations form one undo step, failures roll back, and dryRun returns a proposed document and PNG without commit, persistence or history changes. By default diagnostics compare preserved/removed/added contacts, overlaps and uncertain crossings for the batch; these are geometric observations, not electrical validation. Groups are top-level editing units.", {
  sessionId, expectedRevision, operations: z.array(operation).min(1).max(100), dryRun: z.boolean().default(false),
  analyze: z.boolean().default(true).describe("Report preserved/removed/added geometric contacts, overlaps and crossings for the whole batch, matched by stable component/pin ids. Does not approve electrical correctness or automatically reject reported overlaps."),
  diagnosticLimit: z.number().int().min(1).max(2000).default(200),
  includePreview: z.boolean().default(true).describe("For dryRun, include the proposed-state PNG as an MCP image. The live model is restored before asynchronous rendering. Does not attach an image for committed edits."),
  previewMaxDimension: z.number().int().min(128).max(2048).default(1400),
}, "apply", false)
register("designer_history", "Undo or redo one complete user or agent edit. Requires the current revision.", {
  sessionId, expectedRevision, action: z.enum(["undo", "redo"]),
}, "history", false)
register("designer_export", "Export current TikZ (default), standalone SVG, native editable JSON, or source for the archived import plus its preamble. TikZ regenerates the current model including manual edits; source remains the original import snapshot. Without outputPath, return content, revision and sourceStatus. With an absolute outputPath, write UTF-8, create missing parent directories, and return file metadata. Existing files require overwrite=true. Leaves the drawing and undo history unchanged.", {
  sessionId, expectedRevision: expectedRevision.optional(), format: z.enum(["tikz", "svg", "json", "source"]).default("tikz"),
  outputPath: z.string().min(1).refine(value => isAbsolute(value) && !value.includes("\0"), "outputPath must be an absolute file path without NUL characters.").optional().describe("Absolute destination file path on the machine running the MCP server. Omit to return text. Parent directories are created; the path is used as supplied without changing its extension."),
  overwrite: z.boolean().default(false).describe("Allow replacing an existing output file. Defaults to false; only used with outputPath."),
}, "export", false)
register("designer_preview", "Return a PNG of the complete drawing with a faint coordinate grid by default. Grid lines align with the canvas origin and grid spacing. Includes the drawing viewBox and visible grid spacing in SVG px, so the agent can judge layout, labels and connections. Set showGrid=false for a plain white background.", {
  sessionId, maxDimension: z.number().int().min(128).max(2048).default(1400),
  showGrid: z.boolean().default(true),
  showDiagnostics: z.boolean().default(false).describe("Overlay current potential overlaps (amber) and uncertain wire crossings (purple); include layout diagnostics. Does not mark crossings as electrical connections."),
  annotate: z.boolean().default(false).describe("Add temporary numbered badges and return their stable-id mapping. Does not edit the drawing or exports."),
  highlightIds: z.array(z.string().min(1)).max(200).default([]).describe("Highlight these top-level components in the preview only; rejects unknown ids."),
}, "preview")
register("designer_fit_view", "Fit the live browser viewport around the whole drawing, or explicit top-level component ids for focused inspection. Does not edit the document or change preview/export content.", { sessionId, ids: ids.optional() }, "fit")

server.registerTool("designer_compile", {
  description: "Compile the current drawing or the preserved import source with a real local TeX engine. Returns revision, compiler diagnostics, and a first-page PNG when Poppler is available. Does not edit the browser or undo history. representation=source compiles the archived import, which can differ from subsequent canvas edits; canvas regenerates the current drawing. Optional resourceDirectory supplies project dependencies. Optional absolute .pdf outputPath saves the PDF; existing files require overwrite=true. Requires a local TeX installation; browser preview alone does not use TeX.",
  inputSchema: {
    sessionId, expectedRevision: expectedRevision.optional(), representation: z.enum(["canvas", "source"]).default("canvas"),
    engine: z.enum(["xelatex", "lualatex", "pdflatex"]).default("xelatex"),
    includePreview: z.boolean().default(true), maxDimension: z.number().int().min(128).max(2048).default(1600),
    resourceDirectory: z.string().min(1).optional(), outputPath: z.string().min(1).optional(), overwrite: z.boolean().default(false),
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
}, async (args, extra) => {
  try {
    const exported = await bridge.request(args.sessionId, "export", { format: args.representation === "source" ? "source" : "tikz", expectedRevision: args.expectedRevision })
    const { result: compiled, queueWaitMs } = await scheduleCompile(() => compileTikz({ ...args, source: exported.content, signal: extra.signal }), extra.signal)
    const { preview, ...result } = compiled
    return { isError: !compiled.success, content: [
      { type: "text", text: JSON.stringify({ ...result, queueWaitMs, representation: args.representation, revision: exported.revision, sourceStatus: exported.sourceStatus }) },
      ...(preview ? [{ type: "image", data: preview, mimeType: "image/png" }] : []),
    ] }
  } catch (error) { return { isError: true, content: [{ type: "text", text: JSON.stringify({ success: false, errorCode: extra.signal.aborted ? "cancelled" : error.code || "compile_request_failed", diagnostics: String(error.message || error) }) }] } }
})
return server
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
const port = Number(process.env.MCP_BRIDGE_PORT ?? 3210)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Invalid MCP_BRIDGE_PORT.")
const bridge = await createBridge({ port, appUrl: process.env.MCP_APP_URL || "http://localhost:1234/" })
const server = createDesignerServer(bridge)
console.error(`CircuiTikZ MCP browser connection: ${bridge.connectUrl}`)
let stopping = false
async function stop() {
  if (stopping) return
  stopping = true
  await bridge.close()
  await server.close()
}
process.once("SIGINT", () => { void stop() })
process.once("SIGTERM", () => { void stop() })
process.stdin.once("end", () => { void stop() })
await server.connect(new StdioServerTransport())
}
