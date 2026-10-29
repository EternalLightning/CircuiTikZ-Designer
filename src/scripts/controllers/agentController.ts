import * as SVG from "@svgdotjs/svg.js"
import { Modal } from "bootstrap"
import {
	MainController, CircuitComponent, ComponentSaveObject, SaveController, SaveFileFormat,
	currentSaveVersion, EnvironmentVariableController, SelectionController, SelectionMode,
	Undo, ExportController, PropertyController, GroupComponent,
} from "../internal"
import { parseCircuiTikz } from "../utils/tikzImporter"
import { alignComponentsToGrid, checkComponentsOnGrid } from "../utils/gridAlignment"
import { AgentEditing, describeComponent, editableProperties } from "../utils/agentEditing"
import { captureLayout, compareLayouts, layoutReport, changeMarkers, DiagnosticMarker } from "../utils/agentDiagnostics"

const storageKey = "circuitikz-mcp-connection"
const pxPerCm = 96 / 2.54
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value))
type Connection = { port: number; token: string }

/** An opt-in, typed command boundary. No arbitrary JavaScript or file access. */
export class AgentController {
	private socket: WebSocket
	private connection: Connection
	private sessionId = ""
	private serialized = ""
	private revisionCounter = 0
	private queue = Promise.resolve()
	private button: HTMLButtonElement
	private status: HTMLElement
	private input: HTMLInputElement
	private modal: Modal
	private editing: AgentEditing

	public constructor(private main: MainController) {
		this.editing = new AgentEditing(main, save => this.create(save))
		this.buildDialog()
		let connection: Connection
		try {
			const url = new URL(location.href)
			const token = new URLSearchParams(url.hash.slice(1)).get("mcpToken")
			if (token) {
				connection = this.parseConnection(url.href)
				url.searchParams.delete("mcpPort")
				url.hash = ""
				history.replaceState(null, "", url)
			} else {
				const saved = sessionStorage.getItem(storageKey)
				if (saved) connection = JSON.parse(saved)
			}
			if (connection) this.connect(connection)
		} catch (error) { this.setStatus(String(error)) }
	}

	private buildDialog() {
		this.button = document.createElement("button")
		this.button.id = "mcpButton"
		this.button.type = "button"
		this.button.className = "btn btn-sm btn-outline-secondary text-nowrap"
		this.button.textContent = "MCP"
		this.button.title = "连接本地 Agent / MCP 服务器"
		document.getElementById("helpButton").before(this.button)
		const element = document.createElement("div")
		element.id = "mcpModal"
		element.className = "modal fade"
		element.tabIndex = -1
		element.setAttribute("aria-labelledby", "mcpModalLabel")
		element.innerHTML = `<div class="modal-dialog"><div class="modal-content">
			<div class="modal-header"><h5 class="modal-title" id="mcpModalLabel">Agent / MCP 连接</h5><button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="关闭"></button></div>
			<div class="modal-body"><p>在 agent 中配置本项目的 MCP 服务器，调用 designer_status，然后将连接链接粘贴到下方。连接后，agent 可以读取、修改及导出当前画布。</p>
			<label for="mcpConnectionUrl" class="form-label">本地连接链接（含私密令牌）</label>
			<input id="mcpConnectionUrl" type="password" autocomplete="off" class="form-control" placeholder="http://localhost:1234/?mcpPort=…#mcpToken=…" />
			<div id="mcpStatus" class="small mt-3" role="status" aria-live="polite">未连接</div></div>
			<div class="modal-footer"><button type="button" id="mcpDisconnect" class="btn btn-outline-secondary">断开</button><button type="button" id="mcpConnect" class="btn btn-primary">连接</button></div>
		</div></div>`
		document.body.append(element)
		this.status = element.querySelector("#mcpStatus")
		this.input = element.querySelector("#mcpConnectionUrl")
		this.modal = new Modal(element)
		this.button.addEventListener("click", () => this.modal.show())
		element.querySelector("#mcpConnect").addEventListener("click", () => {
			try { this.connect(this.parseConnection(this.input.value)); this.input.value = "" }
			catch (error) { this.setStatus(String(error)) }
		})
		element.querySelector("#mcpDisconnect").addEventListener("click", () => this.disconnect())
	}

	private parseConnection(value: string): Connection {
		const url = new URL(value)
		if (url.origin !== location.origin) throw new Error("连接链接必须属于当前应用地址。请检查 MCP_APP_URL。")
		return this.validateConnection({ port: Number(url.searchParams.get("mcpPort")), token: new URLSearchParams(url.hash.slice(1)).get("mcpToken") })
	}
	private validateConnection(connection: Connection): Connection {
		if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname) || location.protocol !== "http:") throw new Error("MCP 连接仅支持本地 HTTP 浏览器版。")
		if (!Number.isInteger(connection.port) || connection.port < 1 || connection.port > 65535 || !/^[a-f0-9]{64}$/.test(connection.token)) throw new Error("无效的 MCP 连接链接。")
		return connection
	}
	private setStatus(message: string, connected = false) {
		this.status.textContent = message
		this.button.textContent = connected ? "MCP · 已连接" : "MCP"
		this.button.classList.toggle("btn-outline-success", connected)
		this.button.classList.toggle("btn-outline-secondary", !connected)
		this.button.title = message
	}
	private disconnect() {
		sessionStorage.removeItem(storageKey)
		const previous = this.socket
		this.socket = null
		previous?.close()
		this.sessionId = ""
		this.setStatus("已断开，agent 无法访问当前画布。")
	}
	private connect(connection: Connection) {
		this.validateConnection(connection)
		this.disconnect()
		this.connection = connection
		sessionStorage.setItem(storageKey, JSON.stringify(connection))
		this.setStatus("正在连接本地 MCP 服务器…")
		const socket = new WebSocket(`ws://127.0.0.1:${connection.port}/bridge`, ["circuitikz", connection.token])
		this.socket = socket
		socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "hello", version: 1, title: this.main.designName.value || document.title })))
		socket.addEventListener("close", () => {
			if (this.socket === socket) { this.sessionId = ""; this.setStatus("连接已关闭；可在此重新连接。请先确认服务器正在运行。") }
		})
		socket.addEventListener("error", () => { if (this.socket === socket) this.setStatus("无法连接。请检查服务器、端口与连接链接。") })
		socket.addEventListener("message", event => {
			if (this.socket !== socket) return
			let message
			try { message = JSON.parse(event.data) } catch { socket.close(); return }
			if (!message || typeof message !== "object" || Array.isArray(message)) { socket.close(); return }
			if (message.type === "welcome") {
				this.sessionId = message.sessionId
				this.serialized = ""
				this.revisionCounter = 0
				this.setStatus("已连接；当前画布可由 agent 操作。会话：" + this.sessionId, true)
				return
			}
			if (message.type !== "request" || typeof message.id !== "string") return
			this.queue = this.queue.then(async () => {
				if (this.socket !== socket || socket.readyState !== WebSocket.OPEN) return
				let response: object
				try { response = { result: await this.execute(message.method, message.args ?? {}) } }
				catch (error) { response = { error: error instanceof Error ? error.message : String(error) } }
				if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "result", id: message.id, title: this.main.designName.value || document.title, ...response }))
			}).catch(error => { console.error("MCP command failed", error) })
		})
	}

	private saveFile(includeSelection = false): SaveFileFormat {
		return clone({
			version: currentSaveVersion,
			tikzSettings: EnvironmentVariableController.instance.toJson(),
			components: this.main.circuitComponents.map(component => ({ ...component.toJson(), ...(includeSelection ? { selected: component.isSelected } : {}) })),
		})
	}
	private revision(snapshot = this.saveFile(true)): string {
		// A mouse selection change must invalidate edits targeting selected:true.
		const current = JSON.stringify(snapshot)
		if (current !== this.serialized) { this.serialized = current; this.revisionCounter++ }
		return `${this.sessionId}:${this.revisionCounter}`
	}
	private document(options: { includeSaveFile?: boolean; includeComponents?: boolean } = {}) {
		const snapshot = this.saveFile(true)
		const describe = (component: CircuitComponent, parentIds: string[] = []): object => ({
			...describeComponent(component, parentIds),
			...(component instanceof GroupComponent ? { children: component.groupedComponents.map(child => describe(child, [...parentIds, component.automationId])) } : {}),
		})
		return {
			revision: this.revision(snapshot), name: this.main.designName.value,
			sourceStatus: EnvironmentVariableController.instance.sourceStatus(),
			coordinates: { unit: "px", xDirection: "right", yDirection: "down", pxPerCm, tikz: "cm, y up" },
			componentCount: snapshot.components.length,
			...(options.includeComponents !== false ? { components: this.main.circuitComponents.map(component => describe(component)) } : {}),
			...(options.includeSaveFile !== false ? { saveFile: { ...snapshot, components: snapshot.components.map(({ selected, ...component }) => component) } } : {}),
			selectedIds: this.main.circuitComponents.filter(c => c.isSelected).map(c => c.automationId),
		}
	}
	private find(id: string): CircuitComponent {
		const component = this.main.circuitComponents.find(component => component.automationId === id)
		if (!component) throw new Error(`Unknown top-level component id: ${id}. Read the document again; edit grouped children through their parent group's save object.`)
		return component
	}
	private gridSpacing(): number {
		return pxPerCm * this.main.canvasController.majorGridSizecm / this.main.canvasController.majorGridSubdivisions
	}
	private validate(save: any, depth = 0) {
		if (depth > 12 || !save || typeof save !== "object" || Array.isArray(save)) throw new Error("Invalid component save object.")
		const point = (value: any) => value && Number.isFinite(value.x) && Number.isFinite(value.y) && Math.abs(value.x) < 1e7 && Math.abs(value.y) < 1e7
		const pathTypes = ["path", "wire", "short", "open", "polygon", "arc", "bezier", "plot"]
		const nodeTypes = ["node", "rect", "ellipse", "simpleText"]
		if (save.type === "group") {
			if (!Array.isArray(save.components) || !save.components.length || save.components.length > 500) throw new Error("A group requires 1–500 components.")
			for (const child of save.components) this.validate(child, depth + 1)
		} else if (pathTypes.includes(save.type)) {
			if (!Array.isArray(save.points) || save.points.length < 2 || save.points.length > 500 || !save.points.every(point)) throw new Error("Paths require 2–500 finite points in SVG px.")
			if (save.type === "path" && save.points.length !== 2) throw new Error("A bipole requires exactly two endpoints.")
			if (save.type === "bezier" && save.points.length !== 4) throw new Error("A Bezier requires two endpoints followed by two controls.")
		} else if (nodeTypes.includes(save.type)) {
			if (!point(save.position)) throw new Error("Nodes require a finite position in SVG px.")
			if (["rect", "ellipse"].includes(save.type) && (!point(save.size) || save.size.x <= 0 || save.size.y <= 0)) throw new Error("Shapes require a positive size {x,y} in SVG px.")
		} else throw new Error(`Unsupported component type: ${save.type}`)
		if (save.type === "simpleText" && typeof save.text !== "string") throw new Error("Simple text requires a text string.")
		if (["node", "path"].includes(save.type) && !this.main.symbols.some(symbol => symbol.tikzName === save.id && symbol.isNodeSymbol === (save.type === "node"))) throw new Error(`Unknown ${save.type} symbol: ${save.id}`)
		const inspect = (value: any, nesting = 0) => {
			if (nesting > 30) throw new Error("Component data is too deeply nested.")
			if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Component contains a non-finite number.")
			if (value && typeof value === "object") for (const key of Object.keys(value)) {
				if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("Invalid component field.")
				inspect(value[key], nesting + 1)
			}
		}
		inspect(save)
	}
	private create(save: any, preserveId = false): CircuitComponent {
		this.validate(save)
		const data = clone(save)
		const resetIds = (value: any) => { delete value.automationId; if (value.type === "group") value.components.forEach(resetIds) }
		if (!preserveId) resetIds(data)
		const component = SaveController.fromJson(data)
		if (!component) throw new Error("Unable to create component.")
		return component
	}
	private clear() {
		SelectionController.instance.selectComponents([], SelectionMode.RESET)
		for (const component of this.main.circuitComponents.slice()) {
			try { this.main.removeComponent(component) }
			catch { component.visualization?.remove(); component.selectionElement?.remove() }
		}
	}
	private restore(save: SaveFileFormat) {
		this.clear()
		EnvironmentVariableController.instance.fromJson(save.tikzSettings)
		for (const component of save.components) this.create(component, true)
		SelectionController.instance.selectComponents(this.main.circuitComponents.filter((_, index) => save.components[index].selected), SelectionMode.RESET)
	}
	private async persist() {
		try { await this.main.persistDocument(); return {} }
		catch (error) { return { persistenceWarning: "The canvas and undo history were updated, but browser storage failed: " + String(error) } }
	}

	private async execute(method: string, args: any): Promise<any> {
		if (!this.main.isDocumentReady) throw new Error("Document is still loading; retry after initialization.")
		if (method === "document") return this.document(args)
		if (method === "find_components") return { revision: this.revision(), ...this.editing.query(args) }
		if (method === "component") {
			const { component, parentIds } = this.editing.find(args.id, true)
			return { revision: this.revision(), ...describeComponent(component, parentIds), editableProperties: editableProperties(component) }
		}
		if (method === "connections") return { revision: this.revision(), ...this.editing.connections(args.ids, args.tolerancePx) }
		if (method === "check_layout") {
			if (args.ids) args.ids.forEach(id => this.editing.find(id, true))
			return { revision: this.revision(), ...layoutReport(captureLayout(this.main.circuitComponents, args.tolerancePx ?? .05, args.ids), args.limit ?? 200) }
		}
		if (method === "check_grid") return { revision: this.revision(), ...checkComponentsOnGrid(this.main.circuitComponents, this.gridSpacing(), args.tolerancePx ?? 1e-4, args.limit ?? 200) }
		if (method === "symbols") {
			const query = String(args.query || "").toLowerCase()
			const matches = this.main.symbols.filter(symbol => [symbol.tikzName, symbol.displayName, symbol.groupName].some(value => value?.toLowerCase().includes(query)))
			return {
				total: matches.length,
				symbols: matches.slice(0, Math.max(1, Math.min(100, args.limit ?? 30))).map(symbol => ({
					id: symbol.tikzName, name: symbol.displayName, group: symbol.groupName, type: symbol.isNodeSymbol ? "node" : "path",
					options: symbol.possibleOptions, enumOptions: symbol.possibleEnumOptions,
					pins: [...symbol._mapping.values()][0]?.pins.map(pin => ({ name: pin.name, isDefault: pin.isDefault })),
					example: symbol.isNodeSymbol ? { type: "node", id: symbol.tikzName, position: { x: 0, y: 0 } } : { type: "path", id: symbol.tikzName, points: [{ x: 0, y: 0 }, { x: 2 * pxPerCm, y: 0 }] },
				})),
				shapeExamples: [
					{ type: "wire", points: [{ x: 0, y: 0 }, { x: 80, y: 40 }], directions: ["-|"] },
					{ type: "rect", position: { x: 0, y: 0 }, size: { x: 100, y: 50 }, text: { text: "Block" } },
					{ type: "simpleText", position: { x: 0, y: -40 }, text: "Voltage $U_1$" },
					{ type: "arc", points: [{ x: 0, y: 0 }, { x: 80, y: 0 }], bend: 30, endArrow: "stealthMeta" },
					{ type: "bezier", points: [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 30, y: -60 }, { x: 90, y: -60 }] },
					{ type: "plot", points: [{ x: 0, y: 0 }, { x: pxPerCm, y: -pxPerCm }, { x: 2 * pxPerCm, y: -4 * pxPerCm }], directions: ["--", "--"],
						plot: { x: "\\x", y: "\\x^2", domain: [0, 2], samples: 3 } },
				],
			}
		}
		if (method === "fit") {
			const components = args.ids ? args.ids.map(id => this.editing.find(id).component) : this.main.circuitComponents
			this.main.canvasController.fitView(components)
			return { revision: this.revision() }
		}
		if (method === "export") {
			if (args.expectedRevision != null && args.expectedRevision !== this.revision()) throw Error("Revision conflict: reread the document before exporting or compiling.")
			const content = args.format === "json" ? JSON.stringify(this.saveFile(), null, 2) : args.format === "tikz" ? ExportController.instance.getTikzString() : args.format === "source" ? EnvironmentVariableController.instance.getOriginalSource() : args.format === "svg" ? ExportController.instance.getSVGString() : null
			if (content == null) throw new Error("Unknown export format.")
			return { revision: this.revision(), format: args.format, content, sourceStatus: EnvironmentVariableController.instance.sourceStatus() }
		}
		if (method === "preview") return this.preview(args.maxDimension ?? 1400, args.showGrid !== false, args.annotate, args.highlightIds ?? [], args.showDiagnostics)
		if (!["import", "apply", "history", "select"].includes(method)) throw new Error("Unknown agent command.")
		// Finish font waiting before touching a dry-run model; validate the revision
		// afterwards in case the user edited while fonts were loading.
		if (method === "apply" && args.dryRun && args.includePreview !== false)
			await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))])
		if (args.expectedRevision !== this.revision()) throw new Error("Revision conflict: the document changed. Read designer_get_document before editing again.")
		if (method === "select") {
			const components = [...new Set<string>(args.ids)].map(id => this.editing.find(id).component)
			SelectionController.instance.selectComponents(components, SelectionMode.RESET)
			PropertyController.instance.update()
			return this.document()
		}
		if (method === "history") {
			// A newly opened blank tab has no undo state until its first edit.
			if (!Undo.getCurrentState()) Undo.addState(this.saveFile(true))
			if (args.action === "undo") Undo.undo()
			else if (args.action === "redo") Undo.redo()
			else throw new Error("Unknown history action.")
			SelectionController.instance.selectComponents(this.main.circuitComponents.filter(component => component.isSelected), SelectionMode.RESET)
			return { ...this.document(), ...await this.persist() }
		}
		const before = this.saveFile(true)
		const beforeLayout = method === "apply" && args.analyze !== false ? captureLayout(this.main.circuitComponents) : null
		let diagnostics: ReturnType<typeof compareLayouts>
		const previousRevisionCounter = this.revisionCounter, previousSerialized = this.serialized
		const operationResults: object[] = []
		let warnings: string[] = []
		let gridAlignment: ReturnType<typeof checkComponentsOnGrid>
		try {
			if (method === "import") {
				if (typeof args.source !== "string" || args.source.length > 1024 * 1024) throw new Error("Invalid TikZ source.")
				if (args.preamble != null && (typeof args.preamble !== "string" || args.preamble.length > 128 * 1024)) throw Error("Invalid TikZ preamble.")
				const sourceOnly = args.mode === "source"
				if (sourceOnly && !args.replace && this.main.circuitComponents.length) throw Error("Source mode requires replace=true or an empty canvas.")
				const parsed = sourceOnly ? { components: [], warnings: [] } : parseCircuiTikz((args.preamble || "") + "\n" + args.source)
				warnings = parsed.warnings
				if (!sourceOnly && !parsed.components.length) throw new Error("No importable components. " + warnings.join("; ") + ". Use mode=source to preserve this document without converting it.")
				if (warnings.length && !args.allowWarnings) throw new Error("Import warnings (document unchanged): " + warnings.join("; ") + ". Use allowWarnings only after reviewing these limitations.")
				const previous = this.main.circuitComponents.slice()
				const imported = parsed.components.map(save => this.create(save))
				if (args.snapToGrid !== false) alignComponentsToGrid(imported, this.gridSpacing())
				gridAlignment = checkComponentsOnGrid(imported, this.gridSpacing())
				if (args.replace) for (const component of previous) this.main.removeComponent(component)
				EnvironmentVariableController.instance.captureSource(args.source, args.preamble || "", warnings, sourceOnly || (args.snapToGrid === false && (!previous.length || !!args.replace)), sourceOnly)
			} else {
				if (!Array.isArray(args.operations) || !args.operations.length || args.operations.length > 100) throw new Error("Supply 1–100 operations.")
				for (const operation of args.operations) {
					if (operation.op === "create") this.create(operation.component)
					else if (operation.op === "update") {
						const component = this.find(operation.id)
						const save = { ...component.toJson(), ...operation.patch }
						if (save.type !== component.toJson().type || save.automationId !== component.automationId) throw new Error("type and automationId cannot be changed.")
						for (const key of Object.keys(save)) if (save[key] === null) delete save[key]
						this.validate(save)
						const index = this.main.circuitComponents.indexOf(component)
						const previousSibling = component.visualization.node.previousSibling
						this.main.removeComponent(component)
						const replacement = this.create(save, true)
						this.main.circuitComponents.splice(this.main.circuitComponents.indexOf(replacement), 1)
						this.main.circuitComponents.splice(index, 0, replacement)
						const parent = replacement.visualization.node.parentNode
						if (previousSibling?.parentNode === parent) parent.insertBefore(replacement.visualization.node, previousSibling.nextSibling)
					} else if (operation.op === "delete") {
						for (const component of this.editing.targets(operation)) this.main.removeComponent(component)
					} else operationResults.push({ op: operation.op, result: this.editing.apply(operation) })
				}
			}
			for (const component of this.main.circuitComponents) {
				this.validate(component.toJson())
				const box = component.bbox
				if (!box || ![box.x, box.y, box.width, box.height].every(Number.isFinite)) throw new Error("Edit produced invalid drawing geometry.")
			}
			if (beforeLayout) diagnostics = compareLayouts(beforeLayout, captureLayout(this.main.circuitComponents), args.diagnosticLimit ?? 200)
		} catch (error) { this.restore(before); PropertyController.instance.update(); throw error }
		const selectedIds = new Set(before.components.filter(c => c.selected).map(c => c.automationId))
		SelectionController.instance.selectComponents(this.main.circuitComponents.filter(c => selectedIds.has(c.automationId)), SelectionMode.RESET)
		PropertyController.instance.update()
		const after = this.saveFile()
		const original = new Map(before.components.map(c => { const save = { ...c }; delete save.selected; return [c.automationId, JSON.stringify(save)] }))
		const current = new Map(after.components.map(c => [c.automationId, JSON.stringify(c)]))
		const changes = { createdIds: [...current.keys()].filter(id => !original.has(id)), deletedIds: [...original.keys()].filter(id => !current.has(id)),
			modifiedIds: [...current.keys()].filter(id => original.has(id) && current.get(id) !== original.get(id)) }
		if (args.dryRun && method === "apply") {
			const proposed = { ...this.document(), revision: undefined }
			let snapshot: ReturnType<AgentController["capturePreview"]>, previewWarning: string
			try {
				if (args.includePreview !== false) {
					const markerTotal = diagnostics?.complete ? diagnostics.connections.counts.removed + diagnostics.connections.counts.added + diagnostics.overlaps.counts.added + diagnostics.crossings.counts.added : 0
					snapshot = this.capturePreview(args.previewMaxDimension ?? 1400, false, false, [], diagnostics ? changeMarkers(diagnostics) : [], markerTotal)
				}
			} catch (error) { previewWarning = String(error) }
			finally {
				// Capture SVG synchronously, then restore BEFORE awaiting image decode.
				// Concurrent mouse edits during rendering must never be overwritten.
				this.restore(before)
				PropertyController.instance.update()
				this.revisionCounter = previousRevisionCounter; this.serialized = previousSerialized
			}
			const revision = this.revision()
			let preview: any
			if (snapshot) {
				try { preview = { ...await this.renderPreview(snapshot), revision: undefined, state: "proposed", baseRevision: revision } }
				catch (error) { previewWarning = String(error) }
			}
			return { revision, dryRun: true, proposed, preview, previewWarning, diagnostics, changes, operationResults }
		}
		Undo.addState(before)
		Undo.addState()
		return { ...this.document(), diagnostics, changes, operationResults, warnings, ...(gridAlignment ? { gridAlignment } : {}), ...await this.persist() }
	}

	/** Draw a faint coordinate grid behind the circuit, aligned with the canvas origin. */
	private previewGrid(context: CanvasRenderingContext2D, viewbox: number[], width: number, height: number, major: number, subdivisions: number) {
		const scale = Math.min(width / viewbox[2], height / viewbox[3])
		const offsetX = (width - viewbox[2] * scale) / 2
		const offsetY = (height - viewbox[3] * scale) / 2
		const minor = major / subdivisions
		// Keep distant grids legible by displaying a subset of the original grid lines.
		const majorSpacingPx = major * Math.max(1, Math.ceil(12 / (major * scale)))
		const minorSpacingPx = minor * scale >= 8 ? minor : null
		const draw = (spacing: number, color: string) => {
			context.beginPath()
			context.strokeStyle = color
			for (let x = Math.ceil(viewbox[0] / spacing) * spacing; x <= viewbox[0] + viewbox[2]; x += spacing) {
				const pixel = Math.round(offsetX + (x - viewbox[0]) * scale) + 0.5
				context.moveTo(pixel, 0); context.lineTo(pixel, height)
			}
			for (let y = Math.ceil(viewbox[1] / spacing) * spacing; y <= viewbox[1] + viewbox[3]; y += spacing) {
				const pixel = Math.round(offsetY + (y - viewbox[1]) * scale) + 0.5
				context.moveTo(0, pixel); context.lineTo(width, pixel)
			}
			context.stroke()
		}
		context.save()
		context.lineWidth = 1
		if (minorSpacingPx) draw(minorSpacingPx, "#eef1f4")
		draw(majorSpacingPx, "#dde3e9")
		context.restore()
		return { majorSpacingPx, minorSpacingPx }
	}

	private capturePreview(maxDimension: number, showGrid: boolean, annotate = false, highlightIds: string[] = [], markers: DiagnosticMarker[] = [], markerTotal = markers.length) {
		markers = markers.slice(0, 200)
		maxDimension = Math.max(128, Math.min(2048, maxDimension))
		const revision = this.revision()
		const highlighted = new Set(highlightIds.map(id => this.editing.find(id).component.automationId))
		const components = this.main.circuitComponents.map(c => describeComponent(c))
		const source = ExportController.instance.getSVGString()
		const svg = new DOMParser().parseFromString(source, "image/svg+xml").documentElement
		if (svg.nodeName === "parsererror" || svg.querySelector("parsererror")) throw new Error("Unable to parse preview SVG.")
		const viewbox = svg.getAttribute("viewBox").split(/[ ,]+/).map(Number)
		if (markers.length) {
			const points = markers.flatMap(marker => [marker.point, ...(marker.areas?.flat() ?? []), ...(marker.segments?.flat() ?? [])])
			const x = Math.min(viewbox[0], ...points.map(p => p.x)), y = Math.min(viewbox[1], ...points.map(p => p.y))
			const right = Math.max(viewbox[0] + viewbox[2], ...points.map(p => p.x)), bottom = Math.max(viewbox[1] + viewbox[3], ...points.map(p => p.y))
			// Markers have screen-pixel radii; a fixed world padding clips them
			// when a very large drawing is scaled down.
			const padding = 8 / Math.min(2, maxDimension / Math.max(right - x, bottom - y, 1))
			viewbox.splice(0, 4, x - padding, y - padding, right - x + 2 * padding, bottom - y + 2 * padding)
			svg.setAttribute("viewBox", viewbox.join(" "))
		}
		const scale = Math.min(2, maxDimension / Math.max(viewbox[2], viewbox[3]))
		const width = Math.max(1, Math.ceil(viewbox[2] * scale))
		const height = Math.max(1, Math.ceil(viewbox[3] * scale))
		svg.setAttribute("width", String(width)); svg.setAttribute("height", String(height))
		return { revision, highlighted, components, svg, viewbox, width, height, showGrid, annotate, markers, markerTotal,
			major: pxPerCm * this.main.canvasController.majorGridSizecm, subdivisions: this.main.canvasController.majorGridSubdivisions }
	}
	private async preview(maxDimension: number, showGrid: boolean, annotate = false, highlightIds: string[] = [], showDiagnostics = false) {
		await Promise.race([document.fonts.ready, new Promise(resolve => setTimeout(resolve, 3000))])
		const layout = showDiagnostics ? captureLayout(this.main.circuitComponents) : null
		const markers: DiagnosticMarker[] = layout ? [...layout.overlaps.map(item => ({ ...item, kind: "overlap-current" })), ...layout.crossings.map(item => ({ ...item, kind: "crossing-current" }))] : []
		return { ...await this.renderPreview(this.capturePreview(maxDimension, showGrid, annotate, highlightIds, markers)), ...(layout ? { diagnostics: layoutReport(layout) } : {}) }
	}
	private async renderPreview(snapshot: ReturnType<AgentController["capturePreview"]>) {
		const { revision, highlighted, components, svg, viewbox, width, height, showGrid, annotate, markers, markerTotal, major, subdivisions } = snapshot
		const image = new Image()
		const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }))
		try {
			await new Promise<void>((resolve, reject) => {
				image.onload = () => resolve()
				image.onerror = () => reject(new Error("Unable to render drawing preview."))
				image.src = url
			})
			const canvas = document.createElement("canvas")
			canvas.width = width; canvas.height = height
			const context = canvas.getContext("2d")
			context.fillStyle = "white"; context.fillRect(0, 0, width, height)
			const grid = { visible: showGrid, ...(showGrid ? this.previewGrid(context, viewbox, width, height, major, subdivisions) : {}) }
			context.drawImage(image, 0, 0)
			const project = (p: { x: number; y: number }) => ({ x: (p.x - viewbox[0]) * width / viewbox[2], y: (p.y - viewbox[1]) * height / viewbox[3] })
			context.save()
			for (const marker of markers) {
				const color = marker.kind.startsWith("overlap") ? "#bc7700" : marker.kind.startsWith("crossing") ? "#8b39bf" : marker.kind === "connection-removed" ? "#d43b20" : "#16814a"
				context.strokeStyle = color; context.fillStyle = color; context.lineWidth = 2
				for (const area of marker.areas ?? []) {
					context.beginPath(); area.map(project).forEach((p, i) => i ? context.lineTo(p.x, p.y) : context.moveTo(p.x, p.y)); context.closePath()
					context.globalAlpha = .18; context.fill(); context.globalAlpha = 1; context.stroke()
				}
				for (const [from, to] of marker.segments ?? []) {
					const a = project(from), b = project(to); context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(b.x, b.y); context.stroke()
				}
				const p = project(marker.point)
				context.beginPath(); context.arc(p.x, p.y, 6, 0, Math.PI * 2); context.stroke()
				if (marker.kind.startsWith("crossing")) { context.beginPath(); context.moveTo(p.x - 4, p.y - 4); context.lineTo(p.x + 4, p.y + 4); context.moveTo(p.x + 4, p.y - 4); context.lineTo(p.x - 4, p.y + 4); context.stroke() }
			}
			context.restore()
			const annotations: object[] = []
			if (annotate || highlighted.size) {
				const boxes: { x: number; y: number }[] = []
				for (const [index, component] of components.entries()) {
					const box = component.bounds
					if (!box) continue
					const x = (box.x - viewbox[0]) * width / viewbox[2], y = (box.y - viewbox[1]) * height / viewbox[3]
					if (highlighted.has(component.id)) {
						context.strokeStyle = "#d43b20"; context.lineWidth = 2
						context.strokeRect(x, y, box.width * width / viewbox[2], box.height * height / viewbox[3])
					}
					if (!annotate || index >= 200) continue
					const radius = Math.min(12, width / 4, height / 4)
					let bx = Math.max(radius, Math.min(width - radius, x)), by = Math.max(radius, Math.min(height - radius, y))
					for (let attempt = 0; attempt < 100 && boxes.some(b => Math.hypot(b.x - bx, b.y - by) < radius * 2); attempt++) {
						bx += radius * 2
						if (bx > width - radius) { bx = radius; by = Math.min(height - radius, by + radius * 2) }
					}
					boxes.push({ x: bx, y: by })
					context.strokeStyle = "#2463a3"; context.lineWidth = 1; context.beginPath(); context.moveTo(x, y); context.lineTo(bx, by); context.stroke()
					context.fillStyle = "#2463a3"; context.beginPath(); context.arc(bx, by, radius, 0, Math.PI * 2); context.fill()
					context.fillStyle = "white"; context.font = `${radius}px sans-serif`; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(String(index + 1), bx, by)
					annotations.push({ number: index + 1, id: component.id, label: component.label, position: component.position, badgePx: { x: bx, y: by } })
				}
			}
			return {
				revision, width, height, grid, annotations, annotationsTruncated: annotate && components.length > 200,
				diagnosticMarkerCount: markers.length, diagnosticMarkersTruncated: markerTotal > markers.length, diagnosticLegend: markers.length ? { red: "removed contact (previous position)", green: "added contact", amber: "overlap; body bounds require visual confirmation", purple: "wire crossing; electrical connection unknown" } : undefined,
				viewBox: { x: viewbox[0], y: viewbox[1], width: viewbox[2], height: viewbox[3] },
				data: canvas.toDataURL("image/png").split(",")[1],
			}
		} finally { URL.revokeObjectURL(url) }
	}
}

/** Wait for IndexedDB restoration as well as symbol/font initialization. */
export function initializeAgent(main: MainController) {
	const ready = () => {
		if (!main.isDocumentReady) { setTimeout(ready, 100); return }
		new AgentController(main)
	}
	void main.initPromise.then(ready)
}
