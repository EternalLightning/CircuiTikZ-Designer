import { Modal, Tooltip } from "bootstrap"
import {
	SelectionController,
	MainController,
	defaultStroke,
	defaultFill,
	TextProperty,
	EnvironmentVariableController,
} from "../internal"
import FileSaver from "file-saver"
import * as prettier from "prettier"
import * as SVG from "@svgdotjs/svg.js"
import parserXML from "@prettier/plugin-xml"

/**
 * Contains export functions and controls the "exportModal" (~dialog).
 * @class
 */
export class ExportController {
	private static _instance: ExportController
	public static get instance(): ExportController {
		if (!ExportController._instance) {
			ExportController._instance = new ExportController()
		}
		return ExportController._instance
	}

	private modalElement: HTMLDivElement
	private modal: Modal
	private heading: HTMLHeadingElement
	private exportedContent: HTMLTextAreaElement
	private fileBasename: HTMLInputElement
	private fileExtension: HTMLInputElement
	private fileExtensionDropdown: HTMLUListElement
	private copyButton: HTMLDivElement
	private saveButton: HTMLButtonElement

	private copyTooltip: Tooltip

	private defaultDisplay: string

	private usedIDs: Map<string, number>
	public createExportID(prefix = "N"): string {
		let currentID: number
		if (this.usedIDs.has(prefix)) {
			currentID = this.usedIDs.get(prefix)
			currentID++
		} else {
			currentID = 1
		}
		while (this.isIDUsed(prefix + currentID)) currentID++
		this.usedIDs.set(prefix, currentID)
		return prefix + currentID
	}

	private isIDUsed(id: string): boolean {
		for (const component of MainController.instance.circuitComponents) {
			// check if another component with the same name already exists
			if ("name" in component) {
				let name = component.name as TextProperty
				if (name.value == id) {
					return true
				}
			}
		}
		return false
	}

	/**
	 * Init the ExportController
	 */
	private constructor() {
		this.modalElement = document.getElementById("exportModal") as HTMLDivElement
		this.modal = new Modal(this.modalElement)
		this.heading = document.getElementById("exportModalLabel") as HTMLHeadingElement
		this.exportedContent = document.getElementById("exportedContent") as HTMLTextAreaElement
		this.fileBasename = document.getElementById("exportModalFileBasename") as HTMLInputElement
		this.fileExtension = document.getElementById("exportModalFileExtension") as HTMLInputElement
		this.fileExtensionDropdown = document.getElementById("exportModalFileExtensionDropdown") as HTMLUListElement
		this.copyButton = document.getElementById("copyExportedContent") as HTMLDivElement
		this.saveButton = document.getElementById("exportModalSave") as HTMLButtonElement
		document.getElementById("exportSourceButton")?.addEventListener("click", () => {
			try {
				this.heading.textContent = "导出保留源码（上次导入）"
				this.exportedContent.value = EnvironmentVariableController.instance.getOriginalSource()
				this.exportedContent.rows = Math.min(30, this.exportedContent.value.split("\n").length)
				this.export([".tex", ".tikz"])
			} catch (error) { alert(String(error)) }
		})

		this.defaultDisplay = this.exportedContent.parentElement.style.display

		let copyButtonDefaultTooltipText = "复制到剪贴板！"
		this.copyButton.addEventListener("hidden.bs.tooltip", (evt) => {
			this.copyButton.setAttribute("data-bs-title", copyButtonDefaultTooltipText)
			this.copyTooltip.dispose()
			this.copyTooltip = new Tooltip(this.copyButton)
		})
		this.copyButton.setAttribute("data-bs-toggle", "tooltip")
		this.copyButton.setAttribute("data-bs-title", copyButtonDefaultTooltipText)
		this.copyTooltip = new Tooltip(this.copyButton)

		this.usedIDs = new Map<string, number>()
	}

	exportJSON(text: string) {
		this.heading.textContent = "保存 JSON"

		// create extension select list
		const extensions = [".json", ".txt"]

		this.exportedContent.rows = Math.max(text.split("\n").length, 2)
		this.exportedContent.value = text

		this.export(extensions)
	}

	/**
	 * Build code without opening a dialog, for both UI and agent exports.
	 */
	public getTikzString(): string {
		try {
			const context = EnvironmentVariableController.instance.documentContext
			if (context?.sourceOnly && MainController.instance.circuitComponents.length === 0) throw Error("这是保留源码的文档，请导出原始源码或使用真实 TeX 编译。")
			const libraries = new Set<string>()
			const elements = MainController.instance.circuitComponents.map(component => {
				component.requiredTikzLibraries().forEach(library => libraries.add(library))
				return "\t" + component.toTikzString()
			})
			const settings = EnvironmentVariableController.instance.getTikzSettings()
			const circuitObject = (save: any): boolean => ["path", "node", "short", "open"].includes(save.type) || (save.type === "group" && save.components.some(circuitObject))
			const needsCircuit = MainController.instance.circuitComponents.some(component => circuitObject(component.toJson()))
			return [
				...(context?.preamble ? [context.preamble] : []),
				...(libraries.size ? ["\\usetikzlibrary{" + [...libraries].join(", ") + "}"] : []),
				"\\begin{tikzpicture}[" + ["transform shape", ...(needsCircuit ? settings.environment : [])].join(", ") + "]",
				...(needsCircuit ? settings.ctikzset.map(setting => "\t\\ctikzset{" + setting + "}") : []),
				"\t% Paths, nodes and wires:", ...elements, "\\end{tikzpicture}",
			].join("\n")
		} finally { this.usedIDs.clear() }
	}

	/** Standalone SVG with the same symbols and colors as the normal export. */
	public getSVGString(): string {
		const main = MainController.instance
		const theme = main.darkMode
		const selected = main.circuitComponents.filter(component => component.isSelected)
		try {
			for (const component of selected) component.viewSelected(false)
			main.darkMode = false
			main.updateTheme()
			const svg = new SVG.Svg()
			svg.node.style.fontSize = "10pt"
			svg.node.style.overflow = "visible"
			const definitions = new Map<string, SVG.Element>()
			const components = main.circuitComponents.map(component => component.toSVG(definitions))
			const defs = new SVG.Defs()
			for (const element of definitions.values()) defs.add(element)
			if (definitions.size) svg.add(defs)
			for (const component of components) svg.add(component)
			for (const element of svg.find(".draggable")) element.removeClass("draggable")
			const box = svg.bbox()
			svg.viewbox(box.x - 4, box.y - 4, Math.max(8, box.width + 8), Math.max(8, box.height + 8))
			svg.attr({ xmlns: "http://www.w3.org/2000/svg", "xmlns:xlink": "http://www.w3.org/1999/xlink" })
			return svg.svg().replaceAll(defaultStroke, "#000").replaceAll(defaultFill, "#fff").replaceAll("<br>", "<br/>")
		} finally {
			main.darkMode = theme
			main.updateTheme()
			for (const component of selected) component.viewSelected(true)
		}
	}

	/**
	 * Shows the exportModal with the CitcuiTikZ code.
	 */
	exportCircuiTikZ() {
		this.heading.textContent = "导出当前图形的 TikZ 代码"
		this.exportedContent.parentElement.style.display = this.defaultDisplay
		// create extension select list
		const extensions = [".tikz", ".tex", ".pgf"]

		const text = this.getTikzString()
		this.exportedContent.rows = text.split("\n").length
		this.exportedContent.value = text
		this.export(extensions)
	}

	/**
	 * Shows the exportModal with the SVG code.
	 */
	exportSVG() {
		this.heading.textContent = "导出 SVG"
		this.exportedContent.parentElement.style.display = this.defaultDisplay
		// prepare selection and bounding box
		SelectionController.instance.selectAll()
		SelectionController.instance.deactivateSelection()

		let colorTheme = MainController.instance.darkMode
		MainController.instance.darkMode = false
		MainController.instance.updateTheme()

		//Get the canvas
		let svgObj = new SVG.Svg()
		svgObj.node.style.fontSize = "10pt"
		svgObj.node.style.overflow = "visible"

		// get all used node/symbol names
		let defsMap: Map<string, SVG.Element> = new Map<string, SVG.Element>()
		let components: SVG.Element[] = []
		for (const instance of MainController.instance.circuitComponents) {
			components.push(instance.toSVG(defsMap))
		}

		// add to defs
		if (defsMap.size > 0) {
			const defs = new SVG.Defs()
			for (const element of defsMap) {
				defs.add(element[1])
			}
			svgObj.add(defs)
		}

		for (const component of components) {
			svgObj.add(component)
		}

		//basic cleanup of invisible components (fill and stroke both need to be invisible)
		for (const removeElement of svgObj.find(
			':is([fill-opacity="0"],[fill="none"],[fill="transparent"]):is([stroke-opacity="0"],[stroke="none"],[stroke-width="0"],[stroke="transparent"])'
		)) {
			removeElement.remove()
		}
		//basic draggable class
		for (const removeClass of svgObj.find(".draggable")) {
			removeClass.removeClass("draggable")
		}

		// bounding box to include all elements
		let bbox = svgObj.bbox()
		if (bbox) {
			//make bbox 2px larger in every direction to not cut of tiny bits of some objects
			bbox.x -= 2
			bbox.y -= 2
			bbox.width += 4
			bbox.height += 4
			svgObj.viewbox(bbox)
		}

		// convert to text and make pretty
		let tempDiv = document.createElement("div")
		tempDiv.appendChild(svgObj.node)
		tempDiv.innerHTML = tempDiv.innerHTML.replaceAll(defaultStroke, "#000").replaceAll(defaultFill, "#fff")
		prettier
			.format(tempDiv.innerHTML.replaceAll("<br>", "<br/>"), {
				parser: "xml",
				plugins: [parserXML],
				tabWidth: 4,
				singleAttributePerLine: true,
				xmlWhitespaceSensitivity: "preserve",
			})
			.then((textContent) => {
				this.exportedContent.rows = textContent.split("\n").length
				this.exportedContent.value = textContent
				const extensions = [".svg", ".txt"]
				this.export(extensions)
				SelectionController.instance.activateSelection()
				tempDiv.remove()
			})
		MainController.instance.darkMode = colorTheme
		MainController.instance.updateTheme()
	}

	private export(extensions: string[]) {
		// copy text and adjust tooltip for feedback
		const copyText = () => {
			navigator.clipboard.writeText(this.exportedContent.value).then(() => {
				this.copyButton.setAttribute("data-bs-title", "已复制！")
				this.copyTooltip.dispose()
				this.copyTooltip = new Tooltip(this.copyButton)
				this.copyTooltip.show()
			})
		}
		// create listeners
		const saveFile = (() => {
			const filename =
				(this.fileBasename.value.trim() || MainController.instance.designName.value).replace(
					/[^a-z0-9]/gi,
					"_"
				) || "电路"
			FileSaver.saveAs(
				new Blob([this.exportedContent.value], { type: "text/x-tex;charset=utf-8" }),
				filename + this.fileExtension.value
			)
		}).bind(this)
		const hideListener = (() => {
			this.exportedContent.value = "" // free memory
			this.copyButton.removeEventListener("click", copyText)
			this.saveButton.removeEventListener("click", saveFile)
			this.fileExtensionDropdown.replaceChildren()
			// "once" is not always supported:
			this.modalElement.removeEventListener("hidden.bs.modal", hideListener)
		}).bind(this)

		this.modalElement.addEventListener("hidden.bs.modal", hideListener, {
			passive: true,
			once: true,
		})

		// create extension select list
		this.fileExtension.value = extensions[0]
		this.fileExtensionDropdown.replaceChildren(
			...extensions.map((ext) => {
				const link = document.createElement("a")
				link.textContent = ext
				link.classList.add("dropdown-item")
				link.addEventListener("click", () => (this.fileExtension.value = ext), {
					passive: true,
				})
				const listElement = document.createElement("li")
				listElement.appendChild(link)
				return listElement
			})
		)

		// add listeners & show modal
		this.copyButton.addEventListener("click", copyText, { passive: true })
		this.saveButton.addEventListener("click", saveFile, { passive: true })

		this.modal.show()
	}
}
