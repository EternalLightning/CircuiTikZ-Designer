import { ButtonGridProperty, ChoiceEntry, ChoiceProperty, MainController, SectionHeaderProperty } from "../internal"
import { TikzSourceDocument, sceneSignature, validateSourceDocument } from "../utils/tikzDocument"

export type StylePreset = "default" | "american" | "european"

type TikzSetting = {
	environment: string[]
	ctikzset: string[]
}

export type GlobalTikzSettings = Record<OptionsChoice, string> & { document?: TikzSourceDocument }

// export type GlobalSettings = {
// 	voltageStyle?: "american" | "european" | "straight" | "raised"
// 	currentStyle?: "american" | "european"
// 	voltageConvention?: "old" |"noold" |"RP" |"EF"
// }

type OptionsChoice =
	| "voltages"
	// | "currents"
	// | "resistors"
	// | "inductors"
	// | "logic"
	| "voltageConvention"
	| "labelOrientation"

type GlobalOption = {
	key: OptionsChoice
	name: string
	tikz: "environment" | "ctikzset"
	choices: { key: string; name: string; tikz: string }[]
}

// const globalSettings:Record<OptionsChoice, GlobalOption> = {} as any

const voltageOption: GlobalOption = {
	key: "voltages",
	name: "电压样式",
	tikz: "environment",
	choices: [
		{ key: "american", name: "美式电压", tikz: "american voltages" },
		{ key: "european", name: "欧式电压", tikz: "european voltages" },
		{ key: "straight", name: "直线电压", tikz: "straight voltages" },
		{ key: "raised", name: "抬升式电压箭头", tikz: "raised voltages" },
	],
}

// const currentOption: GlobalOption = {
// 	key: "currents",
// 	name: "Current Style",
// 	tikz: "environment",
// 	choices: [
// 		{ key: "american", name: "American Currents", tikz: "american currents" },
// 		{ key: "european", name: "European Currents", tikz: "european currents" },
// 	],
// }

// const resistorOption: GlobalOption = {
// 	key: "resistors",
// 	name: "Resistor Style",
// 	tikz: "environment",
// 	choices: [
// 		{ key: "american", name: "American Resistors", tikz: "american resistors" },
// 		{ key: "european", name: "European Resistors", tikz: "european resistors" },
// 	],
// }

// const inductorOption: GlobalOption = {
// 	key: "inductors",
// 	name: "Inductor Style",
// 	tikz: "environment",
// 	choices: [
// 		{ key: "cute", name: "Cute Inductors", tikz: "cute inductors" },
// 		{ key: "american", name: "American Inductors", tikz: "american inductors" },
// 		{ key: "european", name: "European Inductors", tikz: "european inductors" },
// 	],
// }

// const logicOption: GlobalOption = {
// 	key: "logic",
// 	name: "Logic Style",
// 	tikz: "environment",
// 	choices: [
// 		{ key: "american", name: "American Logic Gates", tikz: "american ports" },
// 		{ key: "european", name: "European Logic Gates", tikz: "european ports" },
// 		{ key: "ieeestd", name: "IEEE Std Logic Gates", tikz: "ieeestd ports" },
// 	],
// }

const voltageConventionOption: GlobalOption = {
	key: "voltageConvention",
	name: "电压方向约定",
	tikz: "environment",
	choices: [
		{ key: "old", name: "旧版电压方向约定", tikz: "voltage dir=old" },
		{ key: "RP", name: "RP 电压方向约定", tikz: "voltage dir=RP" },
		{ key: "EF", name: "EF 电压方向约定", tikz: "voltage dir=EF" },
		{ key: "noold", name: "noold 电压方向约定（兼容模式）", tikz: "voltage dir=noold" },
	],
}

const labelOrientationOption: GlobalOption = {
	key: "labelOrientation",
	name: "标注方向",
	tikz: "ctikzset",
	choices: [
		{ key: "smart", name: "智能标注方向", tikz: "label/align=smart" },
		{ key: "rotate", name: "旋转标注方向", tikz: "label/align=rotate" },
		{ key: "straight", name: "水平标注方向", tikz: "label/align=straight" },
	],
}

const STYLE_PRESETS: Record<StylePreset, Partial<Record<OptionsChoice, string>>> = {
	default: {
		voltages: "european",
		// currents: "european",
		// resistors: "american",
		// inductors: "cute",
		// logic: "american",
		voltageConvention: "noold",
		labelOrientation: "smart",
	},
	american: {
		// currents: "american",
		voltages: "american",
		// resistors: "american",
		// inductors: "american",
		// logic: "american",
	},
	european: {
		// currents: "european",
		voltages: "european",
		// resistors: "european",
		// inductors: "european",
		// logic: "european",
	},
}

export class EnvironmentVariableController {
	private static _instance: EnvironmentVariableController

	private globalSettings: GlobalTikzSettings
	private sourceDocument?: TikzSourceDocument
	public get documentContext(): TikzSourceDocument | undefined { return this.sourceDocument ? structuredClone(this.sourceDocument) : undefined }
	public captureSource(source: string, preamble: string, warnings: string[], preserveMatch: boolean, sourceOnly = false) {
		this.sourceDocument = {
			version: 1, source, preamble, importWarnings: [...warnings], sourceOnly,
			mode: /\\begin\{circuitikz\}|\\ctikzset\b|\bto\s*\[\s*(?:R|C|L|V|I|vR|sV|sI)\b/.test(source) ? "circuitikz" : "tikz",
			...(preserveMatch ? { baseline: sceneSignature(MainController.instance.circuitComponents.map(c => c.toJson())), settingsBaseline: JSON.stringify(this.globalSettings) } : {}),
		}
		this.refreshSourceUI()
	}
	private refreshSourceUI() {
		const button = document.getElementById("exportSourceButton") as HTMLButtonElement
		if (button) button.disabled = !this.sourceDocument
		document.getElementById("sourceDocumentBanner")?.remove()
	}

	public sourceStatus() {
		// Version 1 baselines use raw toJson() values; JSON cloning changes SVG.Number objects.
		return this.sourceDocument ? { available: true, mode: this.sourceDocument.mode, sourceOnly: !!this.sourceDocument.sourceOnly,
			matchesCanvas: this.sourceDocument.baseline === sceneSignature(MainController.instance.circuitComponents.map(c => c.toJson())) && this.sourceDocument.settingsBaseline === JSON.stringify(this.globalSettings),
			warnings: this.sourceDocument.importWarnings } : { available: false, matchesCanvas: false }
	}
	public getOriginalSource(): string {
		if (!this.sourceDocument) throw Error("当前图纸没有已保留的导入源码。")
		return (this.sourceDocument.preamble ? this.sourceDocument.preamble + "\n" : "") + this.sourceDocument.source
	}

	private htmlElement: HTMLDivElement

	private propertyMap: Map<OptionsChoice, ChoiceProperty<ChoiceEntry>> = new Map()
	private optionsMap: Map<OptionsChoice, GlobalOption> = new Map()

	public static get instance(): EnvironmentVariableController {
		if (!EnvironmentVariableController._instance) {
			EnvironmentVariableController._instance = new EnvironmentVariableController()
		}
		return EnvironmentVariableController._instance
	}

	private constructor() {
		// Initialization code here

		const allOptions = [
			voltageOption,
			// currentOption,
			// resistorOption,
			// inductorOption,
			// logicOption,
			voltageConventionOption,
			labelOrientationOption,
		]

		let defaults = STYLE_PRESETS["default"]

		this.globalSettings = {} as GlobalTikzSettings

		for (const option of allOptions) {
			let choiceProperty = new ChoiceProperty(
				option.name,
				option.choices,
				option.choices.find((choice) => choice.key === defaults[option.key])
			)
			this.propertyMap.set(option.key, choiceProperty)

			this.globalSettings[option.key] = defaults[option.key]

			choiceProperty.addChangeListener((ev) => {
				this.globalSettings[option.key] = ev.value.key
				this.updateComponents()
			})

			this.optionsMap.set(option.key, option)
		}
	}

	public getGlobalSettings(): GlobalTikzSettings {
		return this.globalSettings
	}

	private updateComponents() {
		for (const key of this.propertyMap.keys()) {
			this.globalSettings[key as OptionsChoice] = this.propertyMap.get(key as OptionsChoice).value.key
		}
		MainController.instance.circuitComponents.forEach((component) => {
			component.update()
		})
	}

	private applyStylePreset = (style: StylePreset) => {
		let preset = STYLE_PRESETS[style]
		for (const key of Object.keys(preset)) {
			const property = this.propertyMap.get(key as OptionsChoice)
			property.updateValue(
				property.entries.find((entry) => entry.key === preset[key as OptionsChoice]),
				true,
				false
			)
		}
		this.updateComponents()
	}

	public getHTML(): HTMLDivElement {
		if (this.htmlElement) return this.htmlElement

		this.htmlElement = document.createElement("div")
		this.htmlElement.id = "envVarView"
		this.htmlElement.classList.add("container-fluid", "w-100", "m-0", "gap-3", "px-0")

		this.htmlElement.appendChild(new SectionHeaderProperty("全局绘图预设").getHTMLElement())
		let presetButtons = new ButtonGridProperty(
			3,
			[
				["默认", "reset_settings"],
				["美式", "attach_money"],
				["欧式", "euro"],
			],
			[
				(ev) => {
					this.applyStylePreset("default")
				},
				(ev) => {
					this.applyStylePreset("american")
				},
				(ev) => {
					this.applyStylePreset("european")
				},
			]
		)

		this.htmlElement.appendChild(presetButtons.getHTMLElement())

		this.htmlElement.appendChild(new SectionHeaderProperty("全局绘图设置").getHTMLElement())
		for (const property of this.propertyMap.values()) {
			this.htmlElement.appendChild(property.getHTMLElement())
		}

		return this.htmlElement
	}

	public getTikzSettings(): TikzSetting {
		let environment: string[] = []
		let ctikzset: string[] = []

		// Export effective settings too: the host document may have different
		// package defaults, and a preview must not change polarity on export.
		for (const key of Object.keys(this.globalSettings)) {
			const option = this.optionsMap.get(key as OptionsChoice)
			if (!option) continue
			const setting = option.choices.find(choice => choice.key === this.globalSettings[key as OptionsChoice])!.tikz
			if (option.tikz === "environment") environment.push(setting)
			else ctikzset.push(setting)
		}

		return { environment, ctikzset }
	}

	public toJson() {
		let saveSettings: GlobalTikzSettings = {} as GlobalTikzSettings
		let defaults = STYLE_PRESETS["default"]
		for (const key of Object.keys(this.globalSettings)) {
			if (this.globalSettings[key as OptionsChoice] !== defaults[key as OptionsChoice]) {
				saveSettings[key as OptionsChoice] = this.globalSettings[key as OptionsChoice]
			}
		}
		if (this.sourceDocument) saveSettings.document = structuredClone(this.sourceDocument)
		return saveSettings
	}

	public fromJson(saveSettings: GlobalTikzSettings) {
		this.sourceDocument = validateSourceDocument(saveSettings?.document)
		this.refreshSourceUI()
		let defaults = STYLE_PRESETS["default"]
		Object.assign(this.globalSettings, defaults)
		for (const key of this.optionsMap.keys()) if (saveSettings?.[key] != null) this.globalSettings[key] = saveSettings[key]
		for (const key of Object.keys(this.globalSettings)) {
			let property = this.propertyMap.get(key as OptionsChoice)
			property.updateValue(
				property.entries.find((entry) => entry.key === this.globalSettings[key as OptionsChoice]),
				true,
				false
			)
		}
	}
}
