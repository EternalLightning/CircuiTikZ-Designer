import { Modal } from "bootstrap"
import { CircuitComponent, MainController, SaveController, SelectionController, SelectionMode, Undo, EnvironmentVariableController } from "../internal"
import { parseCircuiTikz } from "../utils/tikzImporter"
import { alignComponentsToGrid } from "../utils/gridAlignment"
import * as SVG from "@svgdotjs/svg.js"

/**
 * Controls the "Import CircuiTikZ code" dialog.
 */
export class ImportController {
	private static _instance: ImportController
	public static get instance(): ImportController {
		if (!ImportController._instance) {
			ImportController._instance = new ImportController()
		}
		return ImportController._instance
	}

	private modalElement: HTMLDivElement
	private modal: Modal
	private textarea: HTMLTextAreaElement
	private fileInput: HTMLInputElement
	private importButton: HTMLButtonElement
	private removeCheckbox: HTMLInputElement
	private statusElement: HTMLDivElement
	private exampleButton: HTMLButtonElement

	private importSucceeded = false

	private constructor() {
		this.modalElement = document.getElementById("importModal") as HTMLDivElement
		this.modal = new Modal(this.modalElement)
		this.textarea = document.getElementById("importTikzContent") as HTMLTextAreaElement
		this.fileInput = document.getElementById("importFileInput") as HTMLInputElement
		this.importButton = document.getElementById("importTikzButton") as HTMLButtonElement
		this.removeCheckbox = document.getElementById("importCheckRemove") as HTMLInputElement
		this.statusElement = document.getElementById("importStatus") as HTMLDivElement
		this.exampleButton = document.getElementById("importExampleButton") as HTMLButtonElement

		this.importButton.addEventListener("click", () => this.import(), { passive: true })
		this.exampleButton.addEventListener("click", () => this.insertExample(), { passive: true })
		this.fileInput.addEventListener("change", () => this.readFile(), { passive: true })
		this.modalElement.addEventListener("hidden.bs.modal", () => this.resetDialog(), { passive: true })

		const openButton = document.getElementById("importButton") as HTMLButtonElement
		openButton?.addEventListener("click", () => this.show(), { passive: true })
	}

	public show() {
		const context = EnvironmentVariableController.instance.documentContext
		if (context && !this.textarea.value) {
			this.textarea.value = context.source
			;(document.getElementById("importTikzPreamble") as HTMLTextAreaElement).value = context.preamble
		}
		this.modal.show()
	}

	private readFile() {
		const file = this.fileInput.files?.[0]
		if (!file) return
		const reader = new FileReader()
		reader.onload = () => {
			this.textarea.value = typeof reader.result == "string" ? reader.result : ""
			this.setStatus("", "info")
		}
		reader.onerror = () => this.setStatus("无法读取所选文件。", "danger")
		reader.readAsText(file, "UTF-8")
	}

	private insertExample() {
		this.textarea.value = String.raw`\begin{circuitikz}[american voltages]
  \draw (0,0) to[R, l=$R_1$, *-*] (2,0)
              to[C, v=$U_C$] (4,0)
              -- (4,2) -| (0,2);
  \draw[->] (1,1) to[bend left=45] (3,2);
  \node[ground] at (0,0) {};
\end{circuitikz}`
		this.setStatus("", "info")
	}

	private import() {
		const source = this.textarea.value
		const preamble = (document.getElementById("importTikzPreamble") as HTMLTextAreaElement).value
		const sourceOnly = (document.getElementById("importSourceOnly") as HTMLInputElement).checked
		if (!source.trim()) {
			this.setStatus("请先粘贴 CircuiTikZ 代码或载入文件。", "warning")
			return
		}

		let result: ReturnType<typeof parseCircuiTikz>
		try {
			if (sourceOnly && MainController.instance.circuitComponents.length && !this.removeCheckbox.checked) throw Error("保留源码模式需要空画布，或勾选移除现有元件。")
			result = sourceOnly ? { components: [], warnings: [] } : parseCircuiTikz(preamble + "\n" + source)
		} catch (error) {
			console.error(error)
			this.setStatus(
				"解析失败：" + this.escapeHtml(error instanceof Error ? error.message : String(error)),
				"danger"
			)
			return
		}

		if (!sourceOnly && result.components.length == 0) {
			this.setStatus("未找到可导入的元件。<br>" + this.warningsToHtml(result.warnings), "warning")
			return
		}

		const previousComponents = MainController.instance.circuitComponents.slice()
		const imported: CircuitComponent[] = []
		const failures: string[] = []
		for (const saveObject of result.components) {
			const existingComponents = new Set(MainController.instance.circuitComponents)
			try {
				const component = SaveController.fromJson(saveObject)
				if (!component) throw new Error("元件类型或符号不存在。")
				imported.push(component)
			} catch (error) {
				for (const component of MainController.instance.circuitComponents.slice()) {
					if (!existingComponents.has(component)) {
						MainController.instance.removeComponent(component)
					}
				}
				const message = error instanceof Error ? error.message : String(error)
				failures.push("无法创建类型为 “" + saveObject.type + "” 的元件：" + message)
			}
		}

		if (!sourceOnly && imported.length == 0) {
			this.setStatus(
				"无法创建任何已解析的元件。" + this.warningsToHtml(failures.concat(result.warnings)),
				"danger"
			)
			return
		}

		if ((document.getElementById("importCheckGrid") as HTMLInputElement).checked) {
			const canvas = MainController.instance.canvasController
			const spacing = new SVG.Number(canvas.majorGridSizecm / canvas.majorGridSubdivisions, "cm").convertToUnit(
				"px"
			).value
			alignComponentsToGrid(imported, spacing)
		}

		if (this.removeCheckbox.checked && failures.length == 0) {
			for (const component of previousComponents) {
				MainController.instance.removeComponent(component)
			}
		} else if (this.removeCheckbox.checked) {
			failures.push("部分元件创建失败，已保留现有图纸。")
		}

		SelectionController.instance.deactivateSelection()
		SelectionController.instance.activateSelection()
		SelectionController.instance.selectComponents(imported, SelectionMode.RESET)
		EnvironmentVariableController.instance.captureSource(source, preamble, result.warnings.concat(failures), sourceOnly || (!(document.getElementById("importCheckGrid") as HTMLInputElement).checked && (!previousComponents.length || this.removeCheckbox.checked)), sourceOnly)
		Undo.addState()

		const warnings = result.warnings.concat(failures)
		const summary = "已导入 " + imported.length + " 个元件。"
		if (warnings.length == 0) {
			this.importSucceeded = true
			this.modal.hide()
			return
		}
		this.importSucceeded = true
		this.importButton.disabled = true
		this.setStatus(summary + this.warningsToHtml(warnings), "success")
	}

	private warningsToHtml(warnings: string[]): string {
		if (warnings.length == 0) return ""
		return (
			'<div class="mt-2 fw-semibold">警告</div><ul class="mb-0">' +
			warnings.map((warning) => "<li>" + this.escapeHtml(warning) + "</li>").join("") +
			"</ul>"
		)
	}

	private escapeHtml(text: string): string {
		return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
	}

	private setStatus(html: string, type: "info" | "success" | "warning" | "danger") {
		this.statusElement.className = "small mt-2"
		if (!html) {
			this.statusElement.innerHTML = ""
			return
		}
		this.statusElement.classList.add("text-" + type)
		this.statusElement.innerHTML = html
	}

	private resetDialog() {
		this.fileInput.value = ""
		this.statusElement.innerHTML = ""
		this.importButton.disabled = false
		if (this.importSucceeded) {
			this.textarea.value = ""
			this.importSucceeded = false
		}
		MainController.instance.updateTooltips()
	}
}
