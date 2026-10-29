import { Modal } from "bootstrap"
import {
	SelectionController,
	Undo,
	ExportController,
	ComponentSaveObject,
	CircuitComponent,
	SelectionMode,
	MainController,
	GlobalTikzSettings,
	EnvironmentVariableController,
} from "../internal"
import { version } from "../../../package.json"

// bump this if something is removed or adjusted in how the save file is formatted. (No change necessary if something is added)
export let currentSaveVersion = "0.1"

export type SaveFileFormat = {
	version: string
	tikzSettings: GlobalTikzSettings
	components: ComponentSaveObject[]
}

export let emtpySaveState: SaveFileFormat = {
	version: currentSaveVersion,
	tikzSettings: {} as GlobalTikzSettings,
	components: [],
}

/**
 * Controller for saving and loading the progress in json format
 */
export class SaveController {
	private static _instance: SaveController
	public static get instance(): SaveController {
		if (!SaveController._instance) {
			SaveController._instance = new SaveController()
		}
		return SaveController._instance
	}

	private loadModal: Modal
	private modalElement: HTMLDivElement

	private loadInput: HTMLInputElement
	private loadMessage: HTMLSpanElement

	private loadButton: HTMLButtonElement

	private loadArea: HTMLDivElement
	private loadAreaBackground: HTMLDivElement

	public currentlyLoadedSaveVersion: string = currentSaveVersion

	private constructor() {
		this.modalElement = document.getElementById("loadModal") as HTMLDivElement
		this.loadModal = new Modal(this.modalElement)
		this.loadInput = document.getElementById("file-input") as HTMLInputElement
		this.loadMessage = document.getElementById("load-message")
		this.loadButton = document.getElementById("loadJSONButton") as HTMLButtonElement
		this.loadArea = document.getElementById("dragdroparea") as HTMLDivElement
		this.loadAreaBackground = document.getElementById("dragdropbackground") as HTMLDivElement

		const opacity0 = () => {
			this.loadAreaBackground.style.opacity = "0"
		}

		this.loadArea.addEventListener("dragenter", (ev) => {
			this.loadAreaBackground.style.opacity = "0.3"
		})
		this.loadArea.addEventListener("dragleave", opacity0)
		this.loadArea.addEventListener("drop", opacity0)
	}

	save() {
		let componentArray = []
		for (const component of MainController.instance.circuitComponents) {
			componentArray.push(component.toJson())
		}
		let settingsData = EnvironmentVariableController.instance.toJson()
		let data: SaveFileFormat = {
			version: currentSaveVersion,
			tikzSettings: settingsData,
			components: componentArray,
		}

		ExportController.instance.exportJSON(JSON.stringify(data, null, 4))
	}

	load() {
		//open modal for file selection
		this.loadModal.show()

		const changeText = (() => {
			let file = this.loadInput.files[0]
			if (file) {
				this.loadMessage.textContent = this.loadInput.value.split("\\").pop()
			} else {
				this.loadMessage.textContent = "未选择文件"
			}
		}).bind(this)

		const loadFile = (() => {
			let file = this.loadInput.files[0]

			if (file) {
				var reader = new FileReader()
				reader.readAsText(file, "UTF-8")
				reader.onload = (evt) => {
					let inputstring = evt.target.result instanceof ArrayBuffer ? "" : evt.target.result
					const input = JSON.parse(inputstring)
					if (!("version" in input)) {
						alert(
							"你正在使用旧版 JSON 存档格式。请将 CircuiTikz Designer 0.6 及更早版本导出的文件重新导出为 JSON，以更新到最新存档格式（当前版本：" +
								currentSaveVersion +
								"，对应 CircuiTikz Designer 版本 " +
								version +
								"）。旧版本格式可能随时被弃用，因而无法正确载入。"
						)
					}
					this.loadFromJSON(input, true)
					this.loadModal.hide()
				}
				reader.onerror = (evt) => {
					this.loadMessage.textContent = "读取文件出错"
				}
			}
		}).bind(this)

		this.loadInput.addEventListener("change", changeText)

		this.loadButton.addEventListener("click", loadFile)

		const hideListener = (() => {
			this.loadInput.removeEventListener("change", changeText)
			this.loadButton.removeEventListener("click", loadFile)
			// "once" is not always supported:
			this.modalElement.removeEventListener("hidden.bs.modal", hideListener)
		}).bind(this)

		this.modalElement.addEventListener("hidden.bs.modal", hideListener, {
			passive: true,
			once: true,
		})
	}

	loadFromJSON(saveFile: SaveFileFormat, selectComponents = false) {
		//delete current state if necessary
		if ((document.getElementById("loadCheckRemove") as HTMLInputElement).checked) {
			SelectionController.instance.selectAll()
			SelectionController.instance.removeSelection()
		}

		let components = []

		if (!("version" in saveFile)) {
			// old file format
			this.currentlyLoadedSaveVersion = ""
			//@ts-ignore
			for (const component of saveFile) {
				let c = SaveController.fromJson(component)
				if (c) {
					components.push(c)
				}
			}
		} else {
			this.currentlyLoadedSaveVersion = saveFile.version

			if (saveFile.tikzSettings) {
				// check if tikzSettings are present and load them
				EnvironmentVariableController.instance.fromJson(saveFile.tikzSettings)
			}

			for (const component of saveFile.components) {
				let c = SaveController.fromJson(component)
				if (c) {
					components.push(c)
				}
			}
		}

		if (selectComponents) {
			SelectionController.instance.deactivateSelection()
			SelectionController.instance.activateSelection()
			SelectionController.instance.selectComponents(components, SelectionMode.RESET)
		}
		Undo.addState()
		this.currentlyLoadedSaveVersion = currentSaveVersion
	}

	static fromJson(saveJson: ComponentSaveObject): CircuitComponent {
		return CircuitComponent.fromJson(saveJson)
	}
}
