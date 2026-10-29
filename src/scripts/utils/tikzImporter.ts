import * as SVG from "@svgdotjs/svg.js"
import { evaluateTikzMath, readTikzGroup, splitTikzOptions } from "./tikzMath"
import { prepareTikz } from "./tikzPreprocessor"
import { collectTikzColors, resolveTikzColor } from "./tikzColors"
import { TikzStyles } from "./tikzStyles"
import {
	ArrowTip,
	arrowTips,
	ComponentSaveObject,
	ComponentSymbol,
	EnvironmentVariableController,
	MainController,
	PathLabel,
	strokeStyleChoices,
	TextAlign,
	TextJustify,
	VoltageLabel,
	WireDirection,
	samplePlot,
	PlotDefinition,
} from "../internal"

type StyleHints = {
	voltageConvention: string
	americanVoltages: boolean
	europeanVoltages: boolean
	americanResistors: boolean
	europeanResistors: boolean
	cuteInductors: boolean
	americanInductors: boolean
	europeanInductors: boolean
}

type ParsedCommand = {
	kind: "draw" | "path" | "node" | "filldraw" | "fill" | "coordinate"
	options: string[]
	body: string
	offset: SVG.Point
	matrix: SVG.Matrix
	xUnit: number
	yUnit: number
	transformShape: boolean
	styles: TikzStyles
}

type NamedCoordinates = Map<string, SVG.Point>

type NodeSpec = {
	options: string[]
	content: string
	at?: SVG.Point
	atInvalid?: boolean
	claimed?: boolean
}

type ParsedTo = {
	bipoleThickness?: number
	componentName: string | null
	symbol: ComponentSymbol | null
	isShort: boolean
	isOpen: boolean
	optionCandidates: string[]
	poles: { start?: string; end?: string }
	label?: PathLabel
	voltage?: VoltageLabel
	current?: any
	scale?: number
	mirror: boolean
	invert: boolean
	name?: string
	bend?: number
	arrows: { start?: string; end?: string }
	unknownName?: string
}

type Segment = {
	kind: "line" | "component" | "arc" | "rect" | "circle" | "bezier"
	start: SVG.Point
	end: SVG.Point
	direction?: WireDirection
	startNodes: NodeSpec[]
	endNodes: NodeSpec[]
	midNodes: NodeSpec[]
	to?: ParsedTo
	bend?: number
	radius?: number
	sampled?: boolean
	radiusY?: number
	controls?: SVG.Point[]
	positionOnPath?: (factor: number) => SVG.Point
}

type CommandArrows = {
	start?: string
	end?: string
	middle?: string
	middlePosition?: number
	defaultTip: string
}

type CommandStroke = {
	width?: SVG.Number
	color?: string
	opacity?: number
	style?: string
}

type PathParseResult = {
	segments: Segment[]
	looseNodes: NodeSpec[]
}

export type TikzImportResult = {
	components: ComponentSaveObject[]
	warnings: string[]
}

let importedBipoleThickness: number | undefined

let importContext = { colors: new Map<string, string>(), warnings: [] as string[], xUnit: 1, yUnit: 1, styles: new TikzStyles(), nodeOptions: [] as string[], fontSizePt: 10 }

const PX_PER_CM = new SVG.Number(1, "cm").convertToUnit("px").value
const poleShortcuts: Record<string, string> = {
	"*": "circ",
	"o": "ocirc",
	"d": "diamondpole",
}
const poleNodeKeys = ["circ", "ocirc", "diamondpole", "odiamondpole", "squarepole", "osquarepole"]
const defaultArrowKey = "to"

function normalizeName(name: string): string {
	return name.replaceAll(/[\s_-]+/g, "").toLowerCase()
}

function normalizeOptionKey(key: string): string {
	return key.replaceAll(/\s+/g, "").toLowerCase()
}

function pushWarning(warnings: string[], message: string) {
	if (warnings.length < 50) {
		warnings.push(message)
	} else if (warnings.length == 50) {
		warnings.push("更多警告已省略。")
	}
}

function stripOuterBraces(value: string): string {
	let result = value.trim()
	while (result.startsWith("{") && result.endsWith("}")) {
		let depth = 0
		let enclosesAll = true
		for (let index = 0; index < result.length; index++) {
			if (result[index] == "{") depth++
			else if (result[index] == "}") depth--
			if (depth == 0 && index < result.length - 1) {
				enclosesAll = false
				break
			}
		}
		if (!enclosesAll) break
		result = result.slice(1, -1).trim()
	}
	return result
}

function splitTopLevel(input: string, delimiter = ","): string[] {
	return splitTikzOptions(input, delimiter)
}

function splitKeyValue(option: string): { key: string; value?: string } {
	let depth = 0
	for (let index = 0; index < option.length; index++) {
		const char = option[index]
		if (char == "{" || char == "[" || char == "(") depth++
		else if (char == "}" || char == "]" || char == ")") depth--
		else if (char == "=" && depth == 0) {
			return { key: option.slice(0, index).trim(), value: option.slice(index + 1).trim() }
		}
	}
	return { key: option.trim() }
}

function stripTextColor(value: string): string {
	let result = value.trim()
	const textColorMatch = result.match(/^\\textcolor\s*\{[^{}]*\}\s*\{([\s\S]*)\}$/)
	if (textColorMatch) {
		result = textColorMatch[1].trim()
	}
	return result
}

function extractLabelValue(value: string): string {
	let result = stripOuterBraces(stripTextColor(stripOuterBraces(value)))
	if (result.startsWith("$") && result.endsWith("$") && result.length >= 2) {
		result = result.slice(1, -1)
	} else if (result.startsWith("\\(") && result.endsWith("\\)") && result.length >= 4) {
		result = result.slice(2, -2)
	} else if (result.startsWith("\\[") && result.endsWith("\\]") && result.length >= 4) {
		result = result.slice(2, -2)
	}
	return result.trim()
}

function hasWordAt(source: string, word: string, index: number): boolean {
	if (!source.startsWith(word, index)) return false
	const before = index == 0 ? "" : source[index - 1]
	const after = source[index + word.length] ?? ""
	return !/[A-Za-z]/.test(before) && !/[A-Za-z]/.test(after)
}

function extractEnvironmentBodies(source: string): {
	bodies: string[]
	options: string[]
	pictures: { body: string; options: string[] }[]
} {
	const bodies: string[] = []
	const options: string[] = []
	const pictures: { body: string; options: string[] }[] = []
	const environmentRegex = /\\begin\{(circuitikz|tikzpicture)\}\s*(\[[^\]]*\])?/g
	let match: RegExpExecArray
	while ((match = environmentRegex.exec(source))) {
		const endTag = "\\end{" + match[1] + "}"
		const endIndex = source.indexOf(endTag, environmentRegex.lastIndex)
		const bodyEnd = endIndex >= 0 ? endIndex : source.length
		bodies.push(source.slice(environmentRegex.lastIndex, bodyEnd))
		pictures.push({ body: bodies.at(-1), options: match[2] ? splitTopLevel(match[2].slice(1, -1)) : [] })
		if (match[2]) {
			options.push(...splitTopLevel(match[2].slice(1, -1)))
		}
		if (endIndex < 0) break
		environmentRegex.lastIndex = endIndex + endTag.length
	}
	return { bodies, options, pictures }
}

function readBalanced(
	source: string,
	index: number,
	open: string,
	close: string
): { content: string; end: number } | null {
	if (source[index] != open) return null
	let depth = 0
	for (let i = index; i < source.length; i++) {
		if (source[i] == open) depth++
		else if (source[i] == close) {
			depth--
			if (depth == 0) {
				return { content: source.slice(index + 1, i), end: i + 1 }
			}
		}
	}
	return null
}

type ImportTransform = { matrix: SVG.Matrix; xUnit: number; yUnit: number; transformShape: boolean }
function transformOptions(options: string[], parent: ImportTransform): ImportTransform {
	let matrix = parent.matrix.clone(), xUnit = parent.xUnit, yUnit = parent.yUnit, transformShape = parent.transformShape
	for (const option of options) {
		const { key, value } = splitKeyValue(option)
		const name = normalizeOptionKey(key)
		if (name === "font" && value) {
			const size = value.match(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/)?.[1]
			importContext.fontSizePt = ({ tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 10, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88 } as Record<string, number>)[size] ?? importContext.fontSizePt
		}
		if (name === "transformshape") { transformShape = value !== "false"; continue }
		if (!value) continue
		if (name === "x" || name === "y") {
			const amount = parseDimension(value)
			if (amount == null || amount === 0) pushWarning(importContext.warnings, "无法恢复坐标单位：" + option)
			else if (name === "x") xUnit = amount
			else yUnit = amount
			continue
		}
		const number = evaluateTikzMath(stripOuterBraces(value))
		if (["scale", "xscale", "yscale", "rotate"].includes(name)) {
			if (number == null || (name !== "rotate" && number === 0)) { pushWarning(importContext.warnings, "无法恢复变换：" + option); continue }
			matrix = matrix.multiply(new SVG.Matrix(name === "rotate" ? { rotate: -number } : { scale: [name === "yscale" ? 1 : number, name === "xscale" ? 1 : number] }))
		} else if (name === "xshift" || name === "yshift") {
			const amount = parseDimension(value)
			if (amount == null) pushWarning(importContext.warnings, "无法恢复平移：" + option)
			else matrix = matrix.multiply(new SVG.Matrix({ translate: [name === "xshift" ? amount * PX_PER_CM : 0, name === "yshift" ? -amount * PX_PER_CM : 0] }))
		} else if (name === "shift") {
			const pair = stripOuterBraces(value).match(/^\((.*)\)$/)
			const parts = pair && splitTopLevel(pair[1])
			const x = parts?.length === 2 ? parseDimension(parts[0]) : null, y = parts?.length === 2 ? parseDimension(parts[1]) : null
			if (x == null || y == null) pushWarning(importContext.warnings, "无法恢复平移：" + option)
			else matrix = matrix.multiply(new SVG.Matrix({ translate: [x * xUnit * PX_PER_CM, -y * yUnit * PX_PER_CM] }))
		} else if (name === "cm") {
			const parts = splitTopLevel(stripOuterBraces(value))
			const numbers = parts.slice(0, 4).map(evaluateArithmetic)
			const position = parts[4]?.match(/^\((.*)\)$/), coordinates = position && splitTopLevel(position[1])
			const tx = coordinates?.length === 2 ? parseDimension(coordinates[0]) : null, ty = coordinates?.length === 2 ? parseDimension(coordinates[1]) : null
			if (parts.length !== 5 || numbers.some(n => n == null) || tx == null || ty == null || Math.abs(numbers[0] * numbers[3] - numbers[1] * numbers[2]) < 1e-10)
				pushWarning(importContext.warnings, "无法恢复变换矩阵：" + option)
			else matrix = matrix.multiply(new SVG.Matrix(numbers[0], -numbers[1], -numbers[2], numbers[3], tx * PX_PER_CM, -ty * PX_PER_CM))
		} else if (["xslant", "yslant", "rotatearound", "scalearound"].includes(name)) {
			pushWarning(importContext.warnings, "此变换仅保留在原始源码中：" + option)
		}
	}
	return { matrix, xUnit, yUnit, transformShape }
}

function extractCommands(source: string, environmentOptions: string[], initialStyles: TikzStyles): ParsedCommand[] {
	const commands: ParsedCommand[] = []
	const rootOptions = initialStyles.expand(environmentOptions)
	const scopes = [{ ...transformOptions(rootOptions, { matrix: new SVG.Matrix(), xUnit: 1, yUnit: 1, transformShape: false }), options: rootOptions, styles: new TikzStyles(initialStyles) }]
	let index = 0
	while (index < source.length) {
		const scope = source.slice(index).match(/^\\(begin|end)\s*\{scope\}/)
		if (scope) {
			index += scope[0].length
			if (scope[1] == "end") {
				if (scopes.length > 1) scopes.pop()
			} else {
				while (/\s/.test(source[index] ?? "")) index++
				const bracket = readBalanced(source, index, "[", "]")
				const options = scopes.at(-1).styles.expand(bracket ? splitTopLevel(bracket.content) : [])
				if (bracket) index = bracket.end
				scopes.push({
					...transformOptions(options, scopes.at(-1)),
					options: scopes.at(-1).options.concat(options),
					styles: new TikzStyles(scopes.at(-1).styles),
				})
			}
			continue
		}
		const styleDefinition = source.slice(index).match(/^\\tikzset\s*/)
		if (styleDefinition) {
			const group = readTikzGroup(source, index + styleDefinition[0].length)
			if (group) { scopes.at(-1).styles.define(group.content); index = group.end; continue }
		}
		const commandMatch = source.slice(index).match(/^\\(draw|path|node|filldraw|fill|coordinate)\b/)
		if (!commandMatch) {
			const unknown = source.slice(index).match(/^\\([A-Za-z]+)/)
			if (unknown && !["begin", "end", "ctikzset", "definecolor", "providecolor", "colorlet", "usetikzlibrary", "usepackage", "documentclass"].includes(unknown[1]))
				pushWarning(importContext.warnings, "未转换的顶层指令已保留在原始源码中：" + unknown[0])
			index++
			continue
		}
		const kind = commandMatch[1] as ParsedCommand["kind"]
		let cursor = index + commandMatch[0].length
		while (/\s/.test(source[cursor] ?? "")) cursor++

		let options: string[] = []
		if (source[cursor] == "[") {
			const bracket = readBalanced(source, cursor, "[", "]")
			if (bracket) {
				options = splitTopLevel(bracket.content)
				cursor = bracket.end
			}
		}

		let depth = 0
		let end = -1
		for (let i = cursor; i < source.length; i++) {
			const char = source[i]
			if (char == "{" || char == "[" || char == "(") depth++
			else if (char == "}" || char == "]" || char == ")") depth--
			else if (char == ";" && depth == 0) {
				end = i
				break
			}
		}
		if (end < 0) {
			index = cursor
			continue
		}
		options = scopes.at(-1).styles.expand(options)
		const transform = transformOptions(kind === "node" ? options.filter(option => !/^\s*(?:rotate|scale|xscale|yscale|xshift|yshift)\s*=/.test(option)) : options, scopes.at(-1))
		commands.push({
			kind,
			options: scopes.at(-1).options.filter(option => !(kind === "node" && normalizeOptionKey(splitKeyValue(option).key) === "fill")).filter(option => !/^\s*(?:scale|xscale|yscale|rotate|shift|xshift|yshift|x|y|transform shape)\s*(?:=|$)/.test(option)).concat(options),
			body: source.slice(cursor, end).trim(),
			offset: new SVG.Point(),
			...transform,
			styles: new TikzStyles(scopes.at(-1).styles),
		})
		index = end + 1
	}
	return commands
}

function defaultStyleHints(): StyleHints {
	const settings = EnvironmentVariableController.instance.getGlobalSettings()
	return {
		voltageConvention: settings.voltageConvention,
		americanVoltages: settings.voltages == "american",
		europeanVoltages: settings.voltages == "european",
		americanResistors: true,
		europeanResistors: false,
		cuteInductors: true,
		americanInductors: false,
		europeanInductors: false,
	}
}

function applyStyleTokens(tokens: string[], hints: StyleHints): StyleHints {
	const result = { ...hints }
	for (const token of tokens) {
		const { key, value } = splitKeyValue(token)
		if (normalizeOptionKey(key) == "voltagedir" && ["old", "noold", "RP", "EF"].includes(value?.trim()))
			result.voltageConvention = value.trim()
		switch (normalizeName(token)) {
			case "american":
			case "americanvoltages":
				result.americanVoltages = true
				result.europeanVoltages = false
				break
			case "european":
			case "europeanvoltages":
				result.europeanVoltages = true
				result.americanVoltages = false
				break
			case "americanresistor":
			case "americanresistors":
				result.americanResistors = true
				result.europeanResistors = false
				break
			case "europeanresistor":
			case "europeanresistors":
				result.europeanResistors = true
				result.americanResistors = false
				break
			case "cuteinductor":
			case "cuteinductors":
				result.cuteInductors = true
				result.americanInductors = false
				result.europeanInductors = false
				break
			case "americaninductor":
			case "americaninductors":
				result.americanInductors = true
				result.cuteInductors = false
				result.europeanInductors = false
				break
			case "europeaninductor":
			case "europeaninductors":
				result.europeanInductors = true
				result.cuteInductors = false
				result.americanInductors = false
				break
		}
	}
	return result
}

function findSymbol(name: string, isNode: boolean): ComponentSymbol | null {
	const normalized = normalizeName(name)
	return (
		MainController.instance.symbols.find(
			(symbol) => symbol.isNodeSymbol == isNode && normalizeName(symbol.tikzName) == normalized
		) ?? null
	)
}

function resolvePathSymbol(name: string, hints: StyleHints): ComponentSymbol | null {
	const normalized = normalizeName(name)
	const direct = findSymbol(name, false)
	if (direct) return direct

	let alias: string | null = null
	switch (normalized) {
		case "r":
			alias = hints.europeanResistors ? "european resistor" : "american resistor"
			break
		case "er":
		case "europeanresistor":
			alias = "european resistor"
			break
		case "vr":
			alias = "variable american resistor"
			break
		case "pr":
		case "potentiometer":
			alias = "american potentiometer"
			break
		case "c":
			alias = "capacitor"
			break
		case "cc":
		case "polarcapacitor":
			alias = "curved capacitor"
			break
		case "ec":
			alias = "ecapacitor"
			break
		case "vc":
			alias = "variable capacitor"
			break
		case "l":
			alias =
				hints.europeanInductors ? "european inductor"
				: hints.americanInductors ? "american inductor"
				: "cute inductor"
			break
		case "el":
			alias = "european inductor"
			break
		case "al":
			alias = "american inductor"
			break
		case "vl":
			alias = "variable cute inductor"
			break
		case "d":
			alias = "empty diode"
			break
		case "d*":
			alias = "full diode"
			break
		case "zd":
			alias = "empty Zener diode"
			break
		case "zd*":
			alias = "full Zener diode"
			break
		case "zzd":
			alias = "empty ZZener diode"
			break
		case "zzd*":
			alias = "full ZZener diode"
			break
		case "sd":
			alias = "empty Schottky diode"
			break
		case "sd*":
			alias = "full Schottky diode"
			break
		case "td":
			alias = "empty tunnel diode"
			break
		case "td*":
			alias = "full tunnel diode"
			break
		case "pd":
			alias = "empty photodiode"
			break
		case "pd*":
			alias = "full photodiode"
			break
		case "led":
			alias = "empty led"
			break
		case "led*":
			alias = "full led"
			break
		case "laserd":
			alias = "empty laser diode"
			break
		case "laserd*":
			alias = "full laser diode"
			break
		case "tvsd":
			alias = "empty TVS diode"
			break
		case "tvsd*":
			alias = "full TVS diode"
			break
		case "v":
			alias = hints.americanVoltages ? "american voltage source" : "european voltage source"
			break
		case "i":
			alias = hints.americanVoltages ? "american current source" : "european current source"
			break
		case "sv":
			alias = "european controlled voltage source"
			break
		case "si":
			alias = "european controlled current source"
			break
		case "cv":
		case "cvsourceeu":
			alias = "european controlled voltage source"
			break
		case "ci":
		case "cisourceeu":
			alias = "european controlled current source"
			break
		case "nos":
			alias = "normal open switch"
			break
		case "ncs":
			alias = "normal closed switch"
			break
	}
	if (alias) {
		return MainController.instance.symbols.find(
			(symbol) => !symbol.isNodeSymbol && normalizeName(symbol.tikzName) == normalizeName(alias)
		)
	}
	return null
}

function resolveNodeSymbol(name: string): ComponentSymbol | null {
	return findSymbol(name, true)
}

function evaluateArithmetic(text: string): number | null {
	return evaluateTikzMath(text)
}

function parseDimension(value: string): number | null {
	const inner = stripOuterBraces(value.trim())
	const match = inner.match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(cm|mm|pt|in|px|pc|em|ex)?$/)
	if (match) {
		if (match[2] === "em" || match[2] === "ex") {
			if (match[2] === "ex" && !importContext.warnings.some(w => w.startsWith("ex 单位"))) pushWarning(importContext.warnings, "ex 单位在画布中按半个 em 近似；真实字体尺寸请用 TeX 校样。")
			return new SVG.Number(Number(match[1]) * importContext.fontSizePt * (match[2] === "ex" ? .5 : 1), "pt").convertToUnit("cm").value
		}
		const unit = (match[2] ?? "cm") as "cm" | "mm" | "pt" | "in" | "px" | "pc"
		return new SVG.Number(Number.parseFloat(match[1]), unit).convertToUnit("cm").value
	}
	// Expanded \foreach values can leave small expressions such as 0+2.2 in coordinates.
	return evaluateArithmetic(inner)
}

function parseCoordinateInner(inner: string): { x: number; y: number } | null {
	const polar = splitTopLevel(inner, ":")
	if (polar.length == 2) {
		const angle = evaluateArithmetic(stripOuterBraces(polar[0]))
		const radius = parseDimension(polar[1])
		if (angle != null && radius != null) {
			const rad = (angle * Math.PI) / 180
			const dimensional = /(?:cm|mm|pt|in|px|pc)\s*\}?$/.test(polar[1])
			return { x: radius * Math.cos(rad) * (dimensional ? 1 : importContext.xUnit), y: radius * Math.sin(rad) * (dimensional ? 1 : importContext.yUnit) }
		}
		return null
	}
	const parts = splitTopLevel(inner, ",")
	if (parts.length != 2) return null
	const x = parseDimension(parts[0])
	const y = parseDimension(parts[1])
	if (x == null || y == null) return null
	return { x: x * (/(?:cm|mm|pt|in|px|pc)\s*\}?$/.test(parts[0]) ? 1 : importContext.xUnit), y: y * (/(?:cm|mm|pt|in|px|pc)\s*\}?$/.test(parts[1]) ? 1 : importContext.yUnit) }
}

function cmToWorld(x: number, y: number): SVG.Point {
	return new SVG.Point(x * PX_PER_CM, -y * PX_PER_CM)
}

function resolveNamedPoint(expression: string, named: NamedCoordinates): SVG.Point | null {
	const name = expression.trim()
	if (name == "") return null
	return named.get(name)?.clone() ?? null
}

function resolveSimplePointText(text: string, named: NamedCoordinates): SVG.Point | null {
	const trimmed = text.trim()
	if (trimmed == "") return null
	const numeric = parseCoordinateInner(trimmed)
	if (numeric) return cmToWorld(numeric.x, numeric.y)
	const namedPoint = resolveNamedPoint(trimmed, named)
	if (namedPoint) return namedPoint
	if (trimmed.startsWith("[")) return parseCoordinateModifier(trimmed, named)
	return null
}

function parseCoordinateModifier(text: string, named: NamedCoordinates): SVG.Point | null {
	const bracket = readBalanced(text, 0, "[", "]")
	if (!bracket) return null
	const rest = text.slice(bracket.end).trim()
	const base = parseNamedCoordinateInner(rest, named)
	if (!base) return null

	let shiftX = 0
	let shiftY = 0
	let scale = 1
	for (const option of splitTopLevel(bracket.content)) {
		const { key, value } = splitKeyValue(option)
		const normalizedKey = normalizeOptionKey(key)
		if (normalizedKey == "xshift" && value) {
			const parsed = parseDimension(stripOuterBraces(value))
			if (parsed != null) shiftX += parsed * PX_PER_CM
		} else if (normalizedKey == "yshift" && value) {
			const parsed = parseDimension(stripOuterBraces(value))
			if (parsed != null) shiftY -= parsed * PX_PER_CM
		} else if (normalizedKey == "shift" && value) {
			let shiftValue = stripOuterBraces(value)
			if (shiftValue.startsWith("(") && shiftValue.endsWith(")")) {
				shiftValue = shiftValue.slice(1, -1)
			}
			const parsed = parseCoordinateInner(shiftValue)
			if (parsed) {
				shiftX += parsed.x * PX_PER_CM
				shiftY -= parsed.y * PX_PER_CM
			}
		} else if (normalizedKey == "scale" && value) {
			const parsed = Number.parseFloat(value)
			if (!isNaN(parsed)) scale = parsed
		}
	}
	return new SVG.Point(base.x * scale + shiftX, base.y * scale + shiftY)
}

function readCalcPointGroup(
	text: string,
	index: number,
	named: NamedCoordinates
): { point: SVG.Point; end: number } | null {
	let cursor = index
	while (/\s/.test(text[cursor] ?? "")) cursor++
	if (text[cursor] != "(") return null
	let depth = 0
	for (let i = cursor; i < text.length; i++) {
		if (text[i] == "(") depth++
		else if (text[i] == ")") {
			depth--
			if (depth == 0) {
				const point = parseNamedCoordinateInner(text.slice(cursor + 1, i), named)
				if (!point) return null
				return { point, end: i + 1 }
			}
		}
	}
	return null
}

function findCalcOffset(expression: string): { index: number; operator: "+" | "-" } | null {
	let depth = 0
	let result: { index: number; operator: "+" | "-" } | null = null
	for (let index = 0; index < expression.length; index++) {
		const char = expression[index]
		if (char == "(" || char == "{" || char == "[") depth++
		else if (char == ")" || char == "}" || char == "]") depth--
		else if ((char == "+" || char == "-") && depth == 0 && index > 0) {
			let previous = index - 1
			while (previous >= 0 && /\s/.test(expression[previous])) previous--
			if (expression[previous] == ")") {
				result = { index, operator: char }
			}
		}
	}
	return result
}

function parseCalcBase(expression: string, named: NamedCoordinates): SVG.Point | null {
	let cursor = 0
	const first = readCalcPointGroup(expression, cursor, named)
	if (!first) return null
	let point = first.point
	cursor = first.end

	while (true) {
		while (/\s/.test(expression[cursor] ?? "")) cursor++
		if (expression[cursor] != "!") break
		cursor++
		const factorStart = cursor
		while (cursor < expression.length && expression[cursor] != "!" && expression[cursor] != ":") {
			cursor++
		}
		const factor = Number.parseFloat(expression.slice(factorStart, cursor).trim())
		if (isNaN(factor) || expression[cursor] != "!") return null
		cursor++
		while (/\s/.test(expression[cursor] ?? "")) cursor++

		let angle: number | null = null
		if (expression[cursor] != "(") {
			const angleStart = cursor
			while (cursor < expression.length && expression[cursor] != ":") cursor++
			if (expression[cursor] != ":") return null
			const parsedAngle = Number.parseFloat(expression.slice(angleStart, cursor).trim())
			if (isNaN(parsedAngle)) return null
			angle = parsedAngle
			cursor++
		}

		const next = readCalcPointGroup(expression, cursor, named)
		if (!next) return null
		let delta = next.point.sub(point)
		if (angle != null) {
			const radians = (-angle * Math.PI) / 180
			delta = new SVG.Point(
				delta.x * Math.cos(radians) - delta.y * Math.sin(radians),
				delta.x * Math.sin(radians) + delta.y * Math.cos(radians)
			)
		}
		point = point.add(delta.mul(factor))
		cursor = next.end
	}
	return point
}

function parseCalcCoordinate(raw: string, named: NamedCoordinates): SVG.Point | null {
	let expression = raw.trim()
	if (expression.startsWith("$") && expression.endsWith("$")) {
		expression = expression.slice(1, -1).trim()
	}
	const offset = findCalcOffset(expression)
	if (offset) {
		const base = parseCalcBase(expression.slice(0, offset.index).trim(), named)
		if (!base) return null
		const delta = readCalcPointGroup(expression, offset.index + 1, named)
		if (!delta) return null
		return offset.operator == "+" ? base.add(delta.point) : base.sub(delta.point)
	}
	return parseCalcBase(expression, named)
}

function parseNamedCoordinateInner(inner: string, named: NamedCoordinates): SVG.Point | null {
	const trimmed = inner.trim()
	if (trimmed == "") return null
	if (trimmed.startsWith("[")) return parseCoordinateModifier(trimmed, named)
	if (trimmed.startsWith("$") && trimmed.endsWith("$")) {
		return parseCalcCoordinate(trimmed, named)
	}
	const horizontalThenVertical = trimmed.indexOf("-|")
	const verticalThenHorizontal = trimmed.indexOf("|-")
	const operatorIndex = horizontalThenVertical >= 0 ? horizontalThenVertical : verticalThenHorizontal
	if (operatorIndex > 0) {
		const operator = horizontalThenVertical >= 0 ? "-|" : "|-"
		const first = resolveSimplePointText(trimmed.slice(0, operatorIndex), named)
		const second = resolveSimplePointText(trimmed.slice(operatorIndex + 2), named)
		if (!first || !second) return null
		// (A -| B) takes x from B and y from A, (A |- B) the other way around
		return operator == "-|" ? new SVG.Point(second.x, first.y) : new SVG.Point(first.x, second.y)
	}
	return resolveSimplePointText(trimmed, named)
}

function readCoordinate(
	source: string,
	index: number,
	base: SVG.Point | null,
	named?: NamedCoordinates,
	warnings?: string[]
): { point: SVG.Point; base: SVG.Point; end: number; relative: boolean } | null {
	let cursor = index
	while (/\s/.test(source[cursor] ?? "")) cursor++
	let relative = false
	let updateBase = false
	if (source.startsWith("++", cursor)) {
		relative = true
		updateBase = true
		cursor += 2
	} else if (source[cursor] == "+") {
		relative = true
		cursor++
	}
	while (/\s/.test(source[cursor] ?? "")) cursor++
	const paren = readBalanced(source, cursor, "(", ")")
	if (!paren) return null
	const parsed = parseCoordinateInner(paren.content)
	let point: SVG.Point | null = null
	if (parsed) {
		point = relative && base ? base.add(cmToWorld(parsed.x, parsed.y)) : cmToWorld(parsed.x, parsed.y)
	} else if (named) {
		point = parseNamedCoordinateInner(paren.content, named)
		if (!point && warnings) {
			const expression = paren.content.trim()
			pushWarning(
				warnings,
				(expression.startsWith("$") ? '无法解析坐标表达式 "' : '未知的命名坐标 "') + expression + '"。'
			)
		}
	}
	if (!point) return null
	return { point, base: updateBase || !relative ? point.clone() : (base ?? point.clone()), end: paren.end, relative }
}

function parsePoleShortcut(token: string): { start?: string; end?: string } | null {
	const match = token.match(/^([*od]?)-([*od]?)$/)
	if (!match) return null
	if (match[1] == "" && match[2] == "") return null
	return {
		start: match[1] ? poleShortcuts[match[1]] : undefined,
		end: match[2] ? poleShortcuts[match[2]] : undefined,
	}
}

function mapArrowTipName(name: string, defaultTip: string): string | null {
	const original = stripOuterBraces(name).trim()
	if (original === "Stealth") return "stealthMeta"
	if (original === "Latex") return "latexMeta"
	const normalized = normalizeName(stripOuterBraces(name))
	if (normalized == "") return null
	if (normalized == ">" || normalized == "<") return defaultTip
	const mapping: Record<string, string> = {
		">": defaultTip,
		"<": defaultTip,
		"to": "to",
		"toreversed": "toR",
		"stealth": "stealth",
		"stealth'": "stealthR",
		"stealthreversed": "stealthR",
		"latex": "latex",
		"latex'": "latexR",
		"latexreversed": "latexR",
		"|": "line",
	}
	return Object.hasOwn(mapping, normalized) ? mapping[normalized] : null
}

function parseArrowOption(token: string, defaultTip: string): { start?: string; end?: string } | null {
	if (token.includes("=") || token.length < 2) return null
	if (token.startsWith("<") && token.endsWith(">") && token.indexOf("-", 1) < 0) {
		return { start: mapArrowTipName("<", defaultTip), end: mapArrowTipName(">", defaultTip) }
	}
	const dashIndex = token.indexOf("-")
	if (dashIndex < 0) return null
	const left = token.slice(0, dashIndex)
	const right = token.slice(dashIndex + 1)
	if (token.lastIndexOf("-") != dashIndex) return null

	const start = left == "" ? undefined : mapArrowTipName(left, defaultTip)
	const end = right == "" ? undefined : mapArrowTipName(right, defaultTip)
	if ((left && start == null) || (right && end == null)) return null
	if (start == null && end == null) return null
	return { start, end }
}

function parseArrowOptions(tokens: string[]): CommandArrows {
	const result: CommandArrows = { defaultTip: defaultArrowKey }

	// >= must be applied before parsing -> and <-, because it defines their tip
	for (const token of tokens) {
		const keyValue = splitKeyValue(token)
		if (keyValue.key == ">") {
			const mapped = mapArrowTipName(keyValue.value ?? "", result.defaultTip)
			if (mapped) {
				result.defaultTip = mapped
			}
		}
	}
	for (const token of tokens) {
		const parsed = parseArrowOption(token, result.defaultTip)
		if (parsed) {
			if (parsed.start) result.start = parsed.start
			if (parsed.end) result.end = parsed.end
		}
	}

	for (const token of tokens) {
		if (token.startsWith("decoration=") && token.includes("mark=at position")) {
			const positionMatch = token.match(/mark=at position\s+([0-9.]+)/)
			const tipMatch = token.match(/\\arrow\s*\{\s*([^}]+)\s*\}/)
			if (positionMatch) {
				result.middlePosition = Number.parseFloat(positionMatch[1])
			}
			if (tipMatch) {
				const tipName = mapArrowTipName(tipMatch[1], result.defaultTip)
				if (tipName) result.middle = tipName
			}
			if (!result.middle && result.defaultTip) {
				result.middle = result.defaultTip
			}
		}
	}
	for (const token of tokens) {
		const { key, value } = splitKeyValue(token)
		if (normalizeOptionKey(key) != "arr" || !value) continue
		const position = Number.parseFloat(value)
		if (!isNaN(position)) {
			result.middlePosition = position
			if (!result.middle) result.middle = "stealth"
		}
	}
	return result
}

function tikzColorToCss(value: string): string {
	const resolved = resolveTikzColor(value, importContext.colors)
	if (resolved) return resolved
	if (value.trim() === "none") return "none"
	const message = "无法解析颜色，画布暂用黑色；原始源码已保留：" + value
	if (!importContext.warnings.includes(message)) pushWarning(importContext.warnings, message)
	return "#000000"
}

function inferDashStyle(pattern: string, width?: SVG.Number): string | undefined {
	const widthPt = (width ?? new SVG.Number("0.4pt")).convertToUnit("pt").value
	if (widthPt <= 0) return undefined
	const lengths: number[] = []
	for (const match of pattern.matchAll(/(on|off)\s+([\d.]+)\s*(pt|cm|mm|in|px)?/g)) {
		const unit = (match[3] ?? "pt") as "pt" | "cm" | "mm" | "in" | "px"
		lengths.push(new SVG.Number(Number.parseFloat(match[2]), unit).convertToUnit("pt").value / widthPt)
	}
	if (lengths.length == 0) return undefined
	let bestKey: string | undefined
	let bestError = Number.POSITIVE_INFINITY
	for (const style of strokeStyleChoices) {
		if (style.dasharray.length != lengths.length) continue
		let error = 0
		for (let index = 0; index < lengths.length; index++) {
			error += Math.abs(lengths[index] - style.dasharray[index])
		}
		if (error < bestError) {
			bestError = error
			bestKey = style.key
		}
	}
	return bestError < 2 ? bestKey : undefined
}

function parseStrokeOptions(tokens: string[]): CommandStroke {
	const stroke: CommandStroke = {}
	let dashPattern: string | undefined
	for (const token of tokens) {
		const { key, value } = splitKeyValue(token)
		const normalizedKey = normalizeOptionKey(key)
		if (normalizedKey == "linewidth" && value) {
			const match = value.trim().match(/^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*(pt|cm|mm|in|px|pc)?$/)
			if (match) {
				const unit = (match[2] ?? "pt") as "pt" | "cm" | "mm" | "in" | "px" | "pc"
				stroke.width = new SVG.Number(Number.parseFloat(match[1]), unit)
			}
		} else if (normalizedKey == "thick") {
			stroke.width = new SVG.Number("0.8pt")
		} else if (normalizedKey == "verythick") {
			stroke.width = new SVG.Number("1.2pt")
		} else if (normalizedKey == "ultrathick") {
			stroke.width = new SVG.Number("1.6pt")
		} else if (normalizedKey == "thin") {
			stroke.width = new SVG.Number("0.4pt")
		} else if (normalizedKey == "verythin") {
			stroke.width = new SVG.Number("0.2pt")
		} else if (normalizedKey == "drawopacity" && value) {
			const opacity = Number.parseFloat(value)
			if (!isNaN(opacity)) stroke.opacity = opacity
		} else if (normalizedKey == "draw" && value) {
			const color = tikzColorToCss(stripOuterBraces(value))
			if (normalizeName(color) != "none") stroke.color = color
		} else if (normalizedKey == "dashpattern" && value) {
			dashPattern = stripOuterBraces(value)
		} else if (normalizedKey == "dashed") {
			stroke.style = "dashed"
		} else if (normalizedKey == "denselydashed") {
			stroke.style = "denselydashed"
		} else if (normalizedKey == "looselydashed") {
			stroke.style = "looselydashed"
		} else if (normalizedKey == "dotted") {
			stroke.style = "dotted"
		} else if (normalizedKey == "denselydotted") {
			stroke.style = "denselydotted"
		} else if (normalizedKey == "looselydotted") {
			stroke.style = "looselydotted"
		} else if (normalizedKey == "dashdot") {
			stroke.style = "dashdot"
		} else if ((normalizedKey === "color" && value) || (value === undefined && resolveTikzColor(key, importContext.colors))) {
			stroke.color = tikzColorToCss(value ?? key)
		}
	}
	if (dashPattern) {
		stroke.style = inferDashStyle(dashPattern, stroke.width)
	}
	return stroke
}

function parseToAngleOption(optionTokens: string[], name: string): number | null {
	for (const token of optionTokens) {
		const { key, value } = splitKeyValue(token)
		if (normalizeOptionKey(key) != name || !value) continue
		const parsed = Number.parseFloat(stripOuterBraces(value))
		if (!isNaN(parsed)) return parsed
	}
	return null
}

function parseToOptions(
	optionTokens: string[],
	commandArrows: CommandArrows,
	hints: StyleHints,
	warnings: string[]
): ParsedTo {
	const result: ParsedTo = {
		componentName: null,
		symbol: null,
		isShort: false,
		isOpen: false,
		optionCandidates: [],
		poles: {},
		mirror: false,
		invert: false,
		arrows: {},
	}
	hints = applyStyleTokens(optionTokens, hints)
	const nameCandidates: string[] = []
	let currentModifiers: string | undefined
	let pendingLabelDistance: SVG.Number | undefined
	const structuralKeys = new Set([
		"l",
		"labeldistance",
		"name",
		"scale",
		"bipolenodes",
		"bipoles/length",
		"voltage/distancefromnode",
		"voltage/bumpb",
		"voltage/shift",
		"voltage",
		"voltagedir",
		"current/distance",
		"american",
		"european",
		"mirror",
		"invert",
		"bendleft",
		"bendright",
		"looseness",
		"relative",
	])

	for (const token of optionTokens) {
		if (token == "") continue
		const { key, value } = splitKeyValue(token)
		const normalizedKey = normalizeOptionKey(key)

		const poleShortcut = parsePoleShortcut(token.replaceAll(/\s+/g, ""))
		if (poleShortcut) {
			result.poles = poleShortcut
			continue
		}

		const arrowToken = parseArrowOption(token, commandArrows.defaultTip)
		if (arrowToken) {
			if (arrowToken.start) result.arrows.start = arrowToken.start
			if (arrowToken.end) result.arrows.end = arrowToken.end
			continue
		}

		if (value == undefined) {
			switch (normalizedKey) {
				case "mirror":
					result.mirror = true
					continue
				case "invert":
					result.invert = true
					continue
				case "american":
					Object.assign(hints, applyStyleTokens(["american"], hints))
					continue
				case "european":
					Object.assign(hints, applyStyleTokens(["european"], hints))
					continue
				case "cute":
					Object.assign(hints, applyStyleTokens(["cute inductors"], hints))
					continue
				case "short":
					result.isShort = true
					result.componentName = "short"
					continue
				case "open":
					result.isOpen = true
					result.componentName = "open"
					continue
				case "bendleft":
					result.bend = 30
					continue
				case "bendright":
					result.bend = -30
					continue
			}
			nameCandidates.push(key)
			continue
		}

		if (normalizedKey == "l" || normalizedKey == "l_" || normalizedKey == "l^") {
			result.label = {
				value: extractLabelValue(value),
				otherSide: key.includes("_") ? true : undefined,
			}
			continue
		}
		if (normalizedKey == "labeldistance") {
			pendingLabelDistance = new SVG.Number(value)
			if (result.label) result.label.distance = pendingLabelDistance
			continue
		}
		if (/^v[_^]?[<>]?$/.test(normalizedKey) || normalizedKey == "v") {
			const pos =
				key.includes("_") ? "_"
				: key.includes("^") ? "^"
				: undefined
			const dir =
				key.includes(">") ? ">"
				: key.includes("<") ? "<"
				: undefined
			result.voltage = {
				convention: hints.voltageConvention,
				label: extractLabelValue(value),
				pos,
				dir,
				style:
					hints.americanVoltages ? "american"
					: hints.europeanVoltages ? "european"
					: undefined,
			}
			continue
		}
		if (/^i[<>_^]{0,2}$/.test(normalizedKey)) {
			const modifiers = normalizedKey.slice(1)
			currentModifiers = modifiers
			const pos =
				modifiers.includes("_") ? "_"
				: modifiers.includes("^") ? "^"
				: undefined
			const dir =
				modifiers.includes(">") ? ">"
				: modifiers.includes("<") ? "<"
				: undefined
			const start = dir && pos ? modifiers.indexOf(dir) < modifiers.indexOf(pos) : undefined
			result.current = {
				label: extractLabelValue(value),
				below: pos ? pos == "_" : undefined,
				// Explicit '>' must override the voltage-source default reversal too.
				backwards: dir ? dir == "<" : undefined,
				start,
			}
			continue
		}
		if (normalizedKey == "name") {
			result.name = stripOuterBraces(value)
			continue
		}
		if (normalizedKey == "bipolenodes") {
			const nodes = stripOuterBraces(value)
			const matches = [...nodes.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1].trim())
			if (matches.length >= 2) {
				result.poles = {
					start: matches[0] && matches[0] != "none" ? matches[0] : undefined,
					end: matches[1] && matches[1] != "none" ? matches[1] : undefined,
				}
			}
			continue
		}
		if (["bipoles/thickness", "/tikz/circuitikz/bipoles/thickness"].includes(normalizedKey) && value) {
			const thickness = evaluateArithmetic(value)
			if (thickness != null && thickness >= 0) result.bipoleThickness = thickness
			else pushWarning(warnings, "无法解析元件粗细：" + value)
			continue
		}
		if (normalizedKey == "scale" && value) {
			const scale = Number.parseFloat(value)
			if (!isNaN(scale)) result.scale = Math.abs(scale)
			continue
		}
		if ((normalizedKey == "bipoles/length" || normalizedKey == "/tikz/circuitikz/bipoles/length") && value) {
			const lengthCm = parseDimension(value)
			if (lengthCm != null) {
				result.scale = lengthCm / 1.4
			}
			continue
		}
		if (normalizedKey == "bendleft" || normalizedKey == "bendright") {
			const angle = value ? Number.parseFloat(value) : 30
			if (!isNaN(angle)) {
				result.bend = normalizedKey == "bendleft" ? Math.abs(angle) : -Math.abs(angle)
			}
			continue
		}
		if (normalizedKey == "voltage") {
			if (result.voltage) result.voltage.style = stripOuterBraces(value)
			continue
		}
		if (normalizedKey == "voltage/distancefromnode" && result.voltage) {
			const num = Number.parseFloat(value)
			if (!isNaN(num)) result.voltage.dist = num
			continue
		}
		if (normalizedKey == "voltage/bumpb" && result.voltage) {
			const num = Number.parseFloat(value)
			if (!isNaN(num)) result.voltage.bump = num
			continue
		}
		if (normalizedKey == "voltage/shift" && result.voltage) {
			const num = Number.parseFloat(value)
			if (!isNaN(num)) result.voltage.shift = num
			continue
		}
		if (normalizedKey == "current/distance" && result.current) {
			const num = Number.parseFloat(value)
			if (!isNaN(num)) result.current.dist = num
			continue
		}

		if (!structuralKeys.has(normalizedKey) && !normalizedKey.startsWith("voltage/")) {
			if (value) {
				result.optionCandidates.push(stripOuterBraces(value))
			}
			nameCandidates.push(key)
		}
	}

	let unknownName: string | undefined
	for (const candidate of nameCandidates) {
		const normalized = normalizeName(candidate)
		if (["american", "european", "cute"].includes(normalized)) continue
		if (normalized == "short" || normalized == "open") {
			result.componentName = normalized
			result.isShort = normalized == "short"
			result.isOpen = normalized == "open"
			if (result.isShort) result.isOpen = false
			break
		}
		const symbol = resolvePathSymbol(candidate, hints)
		if (symbol) {
			result.componentName = candidate
			result.symbol = symbol
			break
		}
		if (!unknownName) unknownName = candidate
	}
	result.unknownName = unknownName
	if (unknownName && !result.symbol && !result.isShort && !result.isOpen) {
		pushWarning(warnings, '不支持的元件 "' + unknownName + '"，将以普通导线形式导入。')
	}
	if (pendingLabelDistance && result.label && !result.label.distance) {
		result.label.distance = pendingLabelDistance
	}
	// Internal signs on American sources depend on the convention even when
	// no external voltage label was supplied.
	if (!result.voltage && result.symbol?.source == "isVoltage")
		result.voltage = { label: "", convention: hints.voltageConvention }
	if (result.current && currentModifiers != undefined) {
		const modern = hints.voltageConvention == "noold" || hints.voltageConvention == "EF"
		const voltageSource = result.symbol?.source == "isVoltage"
		const reversedVoltage = result.voltage?.dir == "<"
		const defaultReverse = modern && voltageSource && !reversedVoltage
		const defaultBelow = modern && voltageSource && reversedVoltage
		result.current.backwards ??= defaultReverse
		result.current.below ??= defaultBelow
		result.current.start ??= currentModifiers == "<" && modern ? true : defaultReverse
	}
	const selectedName = result.componentName ? normalizeName(result.componentName) : null
	for (const candidate of nameCandidates) {
		const normalized = normalizeName(candidate)
		if (["american", "european", "cute", "short", "open"].includes(normalized)) continue
		if (selectedName && normalized == selectedName) continue
		result.optionCandidates.push(candidate)
	}
	return result
}

function poleKeyFromNodeSpec(spec: NodeSpec): string | null {
	for (const token of spec.options) {
		const key = normalizeName(token)
		if (poleNodeKeys.some((poleKey) => normalizeName(poleKey) == key)) {
			return poleNodeKeys.find((poleKey) => normalizeName(poleKey) == key)
		}
	}
	return null
}

function nodeSpecName(spec: NodeSpec): string | undefined {
	for (const option of spec.options) {
		const { key, value } = splitKeyValue(option)
		if (normalizeName(key) == "name" && value) {
			return stripOuterBraces(value)
		}
	}
	return undefined
}

function isCoordinateNodeSpec(spec: NodeSpec): boolean {
	if (spec.content != "") return false
	return spec.options.some((option) => {
		const { key, value } = splitKeyValue(option)
		if (normalizeOptionKey(key) == "coordinate") return true
		return (
			normalizeOptionKey(key) == "shape" &&
			value != undefined &&
			["coordinate", "point"].includes(normalizeName(stripOuterBraces(value)))
		)
	})
}

type NodeOutline = {
	center: SVG.Point
	halfWidth: number
	halfHeight: number
	kind: "rect" | "ellipse"
	rotation: number
}

type NodeGeometry = {
	center: SVG.Point
	anchors: Map<string, SVG.Point>
	outline?: NodeOutline
}

type NodeOutlines = Map<string, NodeOutline>

function rotateScaledPoint(point: SVG.Point, scaleX: number, scaleY: number, rotationDeg: number): SVG.Point {
	const x = point.x * scaleX
	const y = point.y * scaleY
	if (!rotationDeg) return new SVG.Point(x, y)
	const radians = (-rotationDeg * Math.PI) / 180
	return new SVG.Point(x * Math.cos(radians) - y * Math.sin(radians), x * Math.sin(radians) + y * Math.cos(radians))
}

function addCompassAnchors(
	anchors: Map<string, SVG.Point>,
	center: SVG.Point,
	leftOffset: SVG.Point,
	rightOffset: SVG.Point,
	topOffset: SVG.Point,
	bottomOffset: SVG.Point,
	scaleX: number,
	scaleY: number,
	rotationDeg: number
) {
	const toWorld = (point: SVG.Point) => center.add(rotateScaledPoint(point, scaleX, scaleY, rotationDeg))
	anchors.set("center", toWorld(new SVG.Point(0, 0)))
	anchors.set("west", toWorld(leftOffset))
	anchors.set("east", toWorld(rightOffset))
	anchors.set("north", toWorld(topOffset))
	anchors.set("south", toWorld(bottomOffset))
	anchors.set("north west", toWorld(new SVG.Point(leftOffset.x, topOffset.y)))
	anchors.set("north east", toWorld(new SVG.Point(rightOffset.x, topOffset.y)))
	anchors.set("south west", toWorld(new SVG.Point(leftOffset.x, bottomOffset.y)))
	anchors.set("south east", toWorld(new SVG.Point(rightOffset.x, bottomOffset.y)))
}

function nodeSymbolFromSpec(spec: NodeSpec): ComponentSymbol | null {
	return (
		spec.options
			.filter((option) => !option.includes("="))
			.map((option) => resolveNodeSymbol(option))
			.find((symbol) => symbol != null) ?? null
	)
}

function nodeSymbolVariant(spec: NodeSpec, symbol: ComponentSymbol) {
	const optionNames: string[] = []
	for (const option of spec.options) {
		const { key, value } = splitKeyValue(option)
		const normalizedKey = normalizeName(key)
		if (["rotate", "xscale", "yscale", "scale", "name", "anchor"].includes(normalizedKey)) continue
		if (option.includes("=")) {
			if (value) optionNames.push(stripOuterBraces(value))
		} else if (symbol != resolveNodeSymbol(key)) {
			optionNames.push(key)
		}
	}
	const options = symbol.getOptionsFromOptionNames(optionNames)
	return symbol.getVariant(options) ?? symbol._mapping.values().toArray()[0]
}

function getNodeGeometry(spec: NodeSpec, at: SVG.Point): NodeGeometry | null {
	let scaleX = 1
	let scaleY = 1
	let rotation = 0
	let anchorName: string | undefined
	let width = 0
	let height = 0
	let hasShape = false
	let shapeName: string | undefined
	let hasExplicitSize = false
	let innerSepCm = 10 / 3 * 2.54 / 72.27

	for (const option of spec.options) {
		const { key, value } = splitKeyValue(option)
		const normalizedKey = normalizeOptionKey(key)
		if (normalizedKey == "scale" && value) {
			const scale = Number.parseFloat(value)
			if (!isNaN(scale)) scaleX = scaleY = scale
		} else if (normalizedKey == "xscale" && value) {
			const scale = Number.parseFloat(value)
			if (!isNaN(scale)) scaleX = scale
		} else if (normalizedKey == "yscale" && value) {
			const scale = Number.parseFloat(value)
			if (!isNaN(scale)) scaleY = scale
		} else if (normalizedKey == "rotate" && value) {
			const angle = Number.parseFloat(value)
			if (!isNaN(angle)) rotation = angle
		} else if (normalizedKey == "anchor" && value) {
			anchorName = stripOuterBraces(value)
		} else if (normalizedKey == "minimumwidth" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) {
				width = parsed * PX_PER_CM
				hasShape = true
				hasExplicitSize = true
			}
		} else if (normalizedKey == "minimumheight" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) {
				height = parsed * PX_PER_CM
				hasShape = true
				hasExplicitSize = true
			}
		} else if (normalizedKey == "minimumsize" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) {
				width = height = parsed * PX_PER_CM
				hasShape = true
				hasExplicitSize = true
			}
		} else if (normalizedKey == "innersep" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) innerSepCm = parsed
		} else if (normalizedKey == "shape" && value) {
			shapeName = normalizeName(stripOuterBraces(value))
			hasShape = true
		} else if (normalizedKey == "draw") {
			hasShape = true
		} else if (
			value == undefined &&
			(normalizedKey == "rectangle" || normalizedKey == "ellipse" || normalizedKey == "circle")
		) {
			shapeName = normalizedKey
			hasShape = true
		}
	}

	const symbol = nodeSymbolFromSpec(spec)
	if (symbol) {
		const variant = nodeSymbolVariant(spec, symbol)
		const anchors = new Map<string, SVG.Point>()
		const localPins = new Map<string, SVG.Point>()
		for (const pin of variant.pins) {
			if (pin.name) localPins.set(pin.name, pin.point)
		}
		const anchorOffset = anchorName ? localPins.get(anchorName) : undefined
		const center = anchorOffset ? at.sub(rotateScaledPoint(anchorOffset, scaleX, scaleY, rotation)) : at.clone()
		for (const [pinName, pinPoint] of localPins) {
			anchors.set(pinName, center.add(rotateScaledPoint(pinPoint, scaleX, scaleY, rotation)))
		}
		const viewCenter = new SVG.Point(variant.viewBox.cx - variant.mid.x, variant.viewBox.cy - variant.mid.y)
		addCompassAnchors(
			anchors,
			center,
			new SVG.Point(variant.viewBox.x - variant.mid.x, viewCenter.y),
			new SVG.Point(variant.viewBox.x2 - variant.mid.x, viewCenter.y),
			new SVG.Point(viewCenter.x, variant.viewBox.y - variant.mid.y),
			new SVG.Point(viewCenter.x, variant.viewBox.y2 - variant.mid.y),
			scaleX,
			scaleY,
			rotation
		)
		anchors.set("text", center.add(rotateScaledPoint(variant.textPosition.point, scaleX, scaleY, rotation)))
		return { center, anchors }
	}

	if (!hasShape && shapeName == undefined) return null

	if (!hasExplicitSize && spec.content) {
		const textWidth = plainTextWidthCm(spec.content)
		const lineCount = spec.content.split(/\\\\/).length
		const textHeight = 0.32 + (lineCount - 1) * 0.3
		if (shapeName == "circle" || shapeName == "ellipse") {
			const diameter = Math.max(textWidth, textHeight) + 2 * innerSepCm + 0.1
			width = height = diameter * PX_PER_CM
		} else {
			width = (textWidth + 2 * innerSepCm + 0.06) * PX_PER_CM
			height = (textHeight + 2 * innerSepCm + 0.04) * PX_PER_CM
		}
	}

	if (!spec.content) {
		const padding = 2 * innerSepCm * PX_PER_CM * (shapeName === "circle" || shapeName === "ellipse" ? Math.SQRT2 : 1)
		width = Math.max(width, padding)
		height = Math.max(height, padding)
	}
	if (shapeName === "circle") width = height = Math.max(width, height)

	const halfWidth = width / 2
	const halfHeight = shapeName == "circle" ? halfWidth : height / 2
	const outlineKind = shapeName == "circle" || shapeName == "ellipse" ? "ellipse" : "rect"
	const localAnchors: Record<string, SVG.Point> = {
		"center": new SVG.Point(0, 0),
		"west": new SVG.Point(-halfWidth, 0),
		"east": new SVG.Point(halfWidth, 0),
		"north": new SVG.Point(0, -halfHeight),
		"south": new SVG.Point(0, halfHeight),
		"north west": new SVG.Point(-halfWidth, -halfHeight),
		"north east": new SVG.Point(halfWidth, -halfHeight),
		"south west": new SVG.Point(-halfWidth, halfHeight),
		"south east": new SVG.Point(halfWidth, halfHeight),
	}
	const center =
		anchorName && localAnchors[anchorName] ?
			at.sub(rotateScaledPoint(localAnchors[anchorName], scaleX, scaleY, rotation))
		:	at.clone()
	const anchors = new Map<string, SVG.Point>()
	for (const [name, offset] of Object.entries(localAnchors)) {
		anchors.set(name, center.add(rotateScaledPoint(offset, scaleX, scaleY, rotation)))
	}
	return {
		center,
		anchors,
		outline: {
			center,
			halfWidth: halfWidth * Math.abs(scaleX),
			halfHeight: halfHeight * Math.abs(scaleY),
			kind: outlineKind,
			rotation,
		},
	}
}

function registerNodeCoordinates(
	named: NamedCoordinates,
	outlines: NodeOutlines,
	spec: NodeSpec,
	at: SVG.Point
): { center: SVG.Point; geometry: NodeGeometry | null } {
	const geometry = getNodeGeometry(spec, at)
	const center = geometry?.center ?? at
	const name = nodeSpecName(spec)
	if (name) {
		named.set(name, center.clone())
		if (geometry) {
			for (const [anchorName, anchorPoint] of geometry.anchors) {
				named.set(name + "." + anchorName, anchorPoint.clone())
			}
			if (geometry.outline) outlines.set(name, geometry.outline)
		}
	}
	return { center, geometry }
}

function readNodeSpec(
	source: string,
	index: number,
	named?: NamedCoordinates,
	warnings?: string[]
): { spec: NodeSpec; end: number } | null {
	let cursor = index
	if (!hasWordAt(source, "node", cursor)) return null
	cursor += 4
	while (/\s/.test(source[cursor] ?? "")) cursor++

	let options: string[] = []
	if (source[cursor] == "[") {
		const bracket = readBalanced(source, cursor, "[", "]")
		if (bracket) {
			options = splitTopLevel(bracket.content)
			cursor = bracket.end
		}
	}
	while (/\s/.test(source[cursor] ?? "")) cursor++

	if (source[cursor] == "(") {
		const name = readBalanced(source, cursor, "(", ")")
		if (name) {
			options.push("name=" + name.content.trim())
			cursor = name.end
		}
	}
	while (/\s/.test(source[cursor] ?? "")) cursor++

	let at: SVG.Point | undefined
	let atInvalid = false
	if (hasWordAt(source, "at", cursor)) {
		cursor += 2
		while (/\s/.test(source[cursor] ?? "")) cursor++
		const coordinate = readCoordinate(source, cursor, null, named, warnings)
		if (coordinate) {
			at = coordinate.point
			cursor = coordinate.end
		} else {
			atInvalid = true
			if (source[cursor] == "(") {
				const namedCoordinate = readBalanced(source, cursor, "(", ")")
				if (namedCoordinate) cursor = namedCoordinate.end
			}
		}
	}
	while (/\s/.test(source[cursor] ?? "")) cursor++

	let content = ""
	if (source[cursor] == "{") {
		const brace = readBalanced(source, cursor, "{", "}")
		if (brace) {
			content = brace.content.trim()
			cursor = brace.end
		}
	}
	return { spec: { options: importContext.nodeOptions.concat(importContext.styles.expand(options)), content, at, atInvalid }, end: cursor }
}

function readCoordinateOperation(
	source: string,
	index: number,
	named: NamedCoordinates,
	warnings: string[]
): { name?: string; at?: SVG.Point; invalidAt: boolean; end: number } | null {
	let cursor = index
	if (!hasWordAt(source, "coordinate", cursor)) return null
	cursor += "coordinate".length
	while (/\s/.test(source[cursor] ?? "")) cursor++
	if (source[cursor] == "[") {
		const bracket = readBalanced(source, cursor, "[", "]")
		if (!bracket) return null
		cursor = bracket.end
	}
	while (/\s/.test(source[cursor] ?? "")) cursor++
	let name: string | undefined
	if (source[cursor] == "(") {
		const paren = readBalanced(source, cursor, "(", ")")
		if (paren) {
			name = paren.content.trim()
			cursor = paren.end
		}
	}
	while (/\s/.test(source[cursor] ?? "")) cursor++
	let at: SVG.Point | undefined
	let invalidAt = false
	if (hasWordAt(source, "at", cursor)) {
		cursor += 2
		while (/\s/.test(source[cursor] ?? "")) cursor++
		const coordinate = readCoordinate(source, cursor, null, named, warnings)
		if (coordinate) {
			at = coordinate.point
			cursor = coordinate.end
		} else {
			invalidAt = true
		}
	}
	return { name, at, invalidAt, end: cursor }
}

function consumePathSpecs(
	source: string,
	index: number,
	warnings: string[],
	named: NamedCoordinates,
	currentPoint: SVG.Point
): { nodes: NodeSpec[]; end: number } {
	const nodes: NodeSpec[] = []
	let cursor = index
	while (true) {
		while (/\s/.test(source[cursor] ?? "")) cursor++
		if (hasWordAt(source, "node", cursor)) {
			const parsed = readNodeSpec(source, cursor, named, warnings)
			if (!parsed) break
			const name = nodeSpecName(parsed.spec)
			if (isCoordinateNodeSpec(parsed.spec)) {
				if (name) {
					if (parsed.spec.atInvalid) {
						pushWarning(warnings, '无法解析坐标 "' + name + '" 的位置定义，已跳过。')
					} else {
						named.set(name, parsed.spec.at?.clone() ?? currentPoint.clone())
					}
				}
			} else {
				nodes.push(parsed.spec)
			}
			cursor = parsed.end
			continue
		}
		if (hasWordAt(source, "coordinate", cursor)) {
			const operation = readCoordinateOperation(source, cursor, named, warnings)
			if (!operation) break
			if (operation.name) {
				if (operation.invalidAt) {
					pushWarning(warnings, '无法解析坐标 "' + operation.name + '" 的位置定义，已跳过。')
				} else {
					named.set(operation.name, operation.at?.clone() ?? currentPoint.clone())
				}
			}
			cursor = operation.end
			continue
		}
		break
	}
	return { nodes, end: cursor }
}

function parseArcSpec(
	source: string,
	index: number,
	start: SVG.Point,
	warnings: string[]
): {
	end: SVG.Point
	bend: number
	endIndex: number
	startAngle: number
	endAngle: number
	radiusX: number
	radiusY: number
} | null {
	let cursor = index
	if (!hasWordAt(source, "arc", cursor)) return null
	cursor += 3
	while (/\s/.test(source[cursor] ?? "")) cursor++

	let startAngle: number | null = null
	let endAngle: number | null = null
	let radiusX: number | null = null
	let radiusY: number | null = null
	let dimensionX = false, dimensionY = false

	if (source[cursor] == "[") {
		const bracket = readBalanced(source, cursor, "[", "]")
		if (!bracket) return null
		cursor = bracket.end
		for (const option of splitTopLevel(bracket.content)) {
			const { key, value } = splitKeyValue(option)
			const normalizedKey = normalizeName(key)
			if (normalizedKey == "startangle") {
				startAngle = Number.parseFloat(value)
			} else if (normalizedKey == "endangle") {
				endAngle = Number.parseFloat(value)
			} else if (normalizedKey == "radius") {
				radiusX = radiusY = parseDimension(value)
				dimensionX = dimensionY = /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(value)
			} else if (normalizedKey == "xradius") {
				radiusX = parseDimension(value)
				dimensionX = /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(value)
			} else if (normalizedKey == "yradius") {
				radiusY = parseDimension(value)
				dimensionY = /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(value)
			}
		}
	} else if (source[cursor] == "(") {
		const paren = readBalanced(source, cursor, "(", ")")
		if (!paren) return null
		cursor = paren.end
		const parts = splitTopLevel(paren.content, ":")
		if (parts.length >= 3) {
			startAngle = Number.parseFloat(parts[0])
			endAngle = Number.parseFloat(parts[1])
			const radiusParts = parts[2].split(/\s+and\s+/)
			radiusX = parseDimension(radiusParts[0])
			radiusY = radiusParts[1] ? parseDimension(radiusParts[1]) : radiusX
			dimensionX = /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(radiusParts[0])
			dimensionY = radiusParts[1] ? /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(radiusParts[1]) : dimensionX
		}
	}

	if (startAngle == null || endAngle == null || radiusX == null || radiusY == null) {
		pushWarning(warnings, "不支持的弧线语法，已跳过。")
		return null
	}

	const startRad = (startAngle * Math.PI) / 180
	const endRad = (endAngle * Math.PI) / 180
	radiusX *= dimensionX ? 1 : importContext.xUnit
	radiusY *= dimensionY ? 1 : importContext.yUnit
	const dxCm = radiusX * (Math.cos(endRad) - Math.cos(startRad))
	const dyCm = radiusY * (Math.sin(endRad) - Math.sin(startRad))
	const end = start.add(cmToWorld(dxCm, dyCm))
	// A counterclockwise circular sweep bulges to the right of its start-to-end chord.
	const bend = (startAngle - endAngle) / 2
	return { end, bend, endIndex: cursor, startAngle, endAngle, radiusX, radiusY }
}

function cubicBezierPoint(p0: SVG.Point, p1: SVG.Point, p2: SVG.Point, p3: SVG.Point, t: number): SVG.Point {
	const u = 1 - t
	const a = u * u * u
	const b = 3 * u * u * t
	const c = 3 * u * t * t
	const d = t * t * t
	return new SVG.Point(a * p0.x + b * p1.x + c * p2.x + d * p3.x, a * p0.y + b * p1.y + c * p2.y + d * p3.y)
}

function nodePositionFactor(spec: NodeSpec): number {
	for (const option of spec.options) {
		const { key, value } = splitKeyValue(option)
		if (normalizeOptionKey(key) == "pos" && value) {
			const parsed = Number.parseFloat(value)
			if (!isNaN(parsed)) return Math.min(1, Math.max(0, parsed))
		}
		const positions: Record<string, number> = { nearstart: .25, nearend: .75, verynearstart: .125, verynearend: .875 }
		if (Object.hasOwn(positions, normalizeOptionKey(key))) return positions[normalizeOptionKey(key)]
	}
	return 0.5
}

function clipPointToOutline(point: SVG.Point, toward: SVG.Point, outlines: NodeOutlines): SVG.Point | null {
	for (const outline of outlines.values()) {
		if (Math.abs(point.x - outline.center.x) > 1e-4 || Math.abs(point.y - outline.center.y) > 1e-4) {
			continue
		}
		const dx = toward.x - point.x
		const dy = toward.y - point.y
		if (dx == 0 && dy == 0) return null
		const radians = (outline.rotation * Math.PI) / 180
		const localX = dx * Math.cos(radians) - dy * Math.sin(radians)
		const localY = dx * Math.sin(radians) + dy * Math.cos(radians)
		let factor = Number.POSITIVE_INFINITY
		if (outline.kind == "ellipse") {
			const a = outline.halfWidth
			const b = outline.halfHeight
			if (a == 0 || b == 0) return null
			factor = 1 / Math.sqrt((localX / a) ** 2 + (localY / b) ** 2)
		} else {
			if (localX != 0) factor = Math.min(factor, outline.halfWidth / Math.abs(localX))
			if (localY != 0) factor = Math.min(factor, outline.halfHeight / Math.abs(localY))
		}
		if (!Number.isFinite(factor) || factor <= 0) return null
		return new SVG.Point(point.x + dx * factor, point.y + dy * factor)
	}
	return null
}

function clipSegmentsToOutlines(segments: Segment[], outlines: NodeOutlines) {
	for (const segment of segments) {
		if (segment.kind == "rect" || segment.kind == "circle") continue
		const start = segment.start.clone()
		const end = segment.end.clone()
		segment.start = clipPointToOutline(start, end, outlines) ?? start
		segment.end = clipPointToOutline(end, start, outlines) ?? end
	}
}

function parsePath(
	body: string,
	commandArrows: CommandArrows,
	hints: StyleHints,
	warnings: string[],
	named: NamedCoordinates,
	outlines: NodeOutlines,
	pathOptions: string[] = []
): PathParseResult {
	const segments: Segment[] = []
	const looseNodes: NodeSpec[] = []
	let cursor = 0
	const first = readCoordinate(body, cursor, null, named, warnings)
	if (!first) {
		// \draw node[rground] at (0,4) {}; (a path that only places nodes)
		if (hasWordAt(body, "node", 0)) {
			const specs = consumePathSpecs(body, 0, warnings, named, new SVG.Point(0, 0))
			let end = specs.end
			while (/\s/.test(body[end] ?? "")) end++
			if (specs.nodes.length > 0 && end >= body.length) {
				for (const node of specs.nodes) {
					if (isCoordinateNodeSpec(node)) continue
					looseNodes.push(node.at ? node : { ...node, at: new SVG.Point(0, 0) })
				}
				return { segments, looseNodes }
			}
		}
		// \path coordinate (A) at (1,2); (coordinates without any drawn path)
		if (hasWordAt(body, "coordinate", 0)) {
			const specs = consumePathSpecs(body, 0, warnings, named, new SVG.Point(0, 0))
			let end = specs.end
			while (/\s/.test(body[end] ?? "")) end++
			if (specs.nodes.length == 0 && end >= body.length) {
				return { segments, looseNodes }
			}
		}
		if (body.trim() != "") pushWarning(warnings, "无法解析路径：" + body.slice(0, 80))
		return { segments, looseNodes }
	}
	let current = first.point
	let subpathStart = first.point
	let base = first.base
	cursor = first.end
	let currentNodesResult = consumePathSpecs(body, cursor, warnings, named, current)
	cursor = currentNodesResult.end
	let currentNodes = currentNodesResult.nodes

	const routeAbsoluteNodes = (nodes: NodeSpec[]) => {
		for (const node of nodes) {
			if (node.at) looseNodes.push(node)
		}
		return nodes.filter((node) => !node.at)
	}
	currentNodes = routeAbsoluteNodes(currentNodes)

	while (cursor < body.length) {
		while (/\s/.test(body[cursor] ?? "")) cursor++
		if (cursor >= body.length) break

		if (hasWordAt(body, "node", cursor)) {
			const spec = readNodeSpec(body, cursor, named, warnings)
			if (!spec) break
			cursor = spec.end
			if (isCoordinateNodeSpec(spec.spec)) {
				const name = nodeSpecName(spec.spec)
				if (name) {
					if (spec.spec.atInvalid) {
						pushWarning(warnings, '无法解析坐标 "' + name + '" 的位置定义，已跳过。')
					} else {
						named.set(name, spec.spec.at?.clone() ?? current.clone())
					}
				}
			} else if (spec.spec.at) {
				looseNodes.push(spec.spec)
			} else {
				currentNodes.push(spec.spec)
			}
			continue
		}

		if (body[cursor] == "+" || body[cursor] == "(") {
			// bare move, e.g. \path (A) ++(0,2) coordinate (C); or \path (A) (B) node ...;
			const move = readCoordinate(body, cursor, base, named, warnings)
			if (!move) break
			cursor = move.end
			current = move.point
			subpathStart = move.point
			base = move.base
			const moveSpecs = consumePathSpecs(body, cursor, warnings, named, current)
			cursor = moveSpecs.end
			currentNodes = routeAbsoluteNodes(moveSpecs.nodes)
			continue
		}

		if (hasWordAt(body, "to", cursor)) {
			const start = current
			const startNodes = currentNodes
			cursor += 2
			while (/\s/.test(body[cursor] ?? "")) cursor++
			let toTokens: string[] = []
			if (body[cursor] == "[") {
				const bracket = readBalanced(body, cursor, "[", "]")
				if (!bracket) break
				toTokens = splitTopLevel(bracket.content)
				cursor = bracket.end
			}
			let afterTo = consumePathSpecs(body, cursor, warnings, named, start)
			cursor = afterTo.end
			const midNodes = routeAbsoluteNodes(afterTo.nodes)
			const next = readCoordinate(body, cursor, base, named, warnings)
			if (!next) {
				pushWarning(warnings, "to[] 后缺少终点坐标，路径其余部分已跳过。")
				break
			}
			cursor = next.end
			const endNodesResult = consumePathSpecs(body, cursor, warnings, named, next.point)
			cursor = endNodesResult.end
			const endNodes = routeAbsoluteNodes(endNodesResult.nodes)
			base = next.base

			let relativeBend: number | undefined
			const outAngle = parseToAngleOption(toTokens, "out")
			const inAngle = parseToAngleOption(toTokens, "in")
			if (outAngle != null && inAngle != null) {
				const dx = next.point.x - start.x
				const dy = -(next.point.y - start.y)
				const lineAngle = (Math.atan2(dy, dx) * 180) / Math.PI
				const normalize = (angle: number) => ((angle + 540) % 360) - 180
				relativeBend = (normalize(outAngle - lineAngle) + normalize(inAngle - 180 - lineAngle)) / 2
				toTokens = toTokens.filter((token) => {
					const key = normalizeOptionKey(splitKeyValue(token).key)
					return key != "out" && key != "in"
				})
			}

			const parsedTo = parseToOptions(toTokens, commandArrows, hints, warnings)
			if (parsedTo.symbol || parsedTo.isShort || parsedTo.isOpen) {
				segments.push({
					kind: "component",
					start,
					end: next.point,
					startNodes,
					endNodes,
					midNodes,
					to: parsedTo,
				})
			} else if (outAngle != null && inAngle != null) {
                // TikZ topaths uses cubic controls, not a circular arc.
                const length = start.sub(next.point).abs() * 0.3915
                const direction = (angle: number) => new SVG.Point(Math.cos(angle * Math.PI / 180), -Math.sin(angle * Math.PI / 180))
                let curve = [start, start.add(direction(outAngle).mul(length)), next.point.add(direction(inAngle).mul(length)), next.point]
                const split = (p: SVG.Point[], t: number) => {
                    const mix = (a: SVG.Point,b: SVG.Point) => a.mul(1-t).add(b.mul(t))
                    const a=mix(p[0],p[1]), b=mix(p[1],p[2]), c=mix(p[2],p[3]), d=mix(a,b), e=mix(b,c), f=mix(d,e)
                    return [[p[0],a,d,f],[f,e,c,p[3]]]
                }
                for (const end of [false,true]) {
                    const token = pathOptions.concat(toTokens).findLast(token => normalizeOptionKey(splitKeyValue(token).key) === (end ? 'shorten>' : 'shorten<'))
                    const distance = token ? parseDimension(splitKeyValue(token).value) : null
                    if (distance == null || distance <= 0) continue
                    const p = end ? [...curve].reverse() : curve
                    let accumulated=0, previous=p[0], t=0
                    for(let i=1;i<=400;i++) {
                        const point=split(p,i/400)[0][3], step=point.sub(previous).abs()
                        if(accumulated+step >= distance*PX_PER_CM) {t=(i-1+(distance*PX_PER_CM-accumulated)/step)/400;break}
                        accumulated+=step;previous=point
                    }
                    curve=split(p,t)[1]
                    if(end) curve.reverse()
                }
                segments.push({kind:'bezier',start:curve[0],end:curve[3],controls:[curve[1],curve[2]],startNodes,endNodes,midNodes,to:parsedTo})
            } else if (
				(relativeBend != undefined && Math.abs(relativeBend) > 0.001) ||
				(parsedTo.bend != undefined && Math.abs(parsedTo.bend) > 0.001)
			) {
				segments.push({
					kind: "arc",
					start,
					end: next.point,
					startNodes,
					endNodes,
					midNodes,
					bend: relativeBend ?? parsedTo.bend,
					to: parsedTo,
				})
			} else {
				segments.push({
					kind: "line",
					start,
					end: next.point,
					direction: WireDirection.Straight,
					startNodes,
					endNodes,
					midNodes,
					to: parsedTo,
				})
			}
			current = next.point
			currentNodes = endNodes
			continue
		}

		if (hasWordAt(body, "arc", cursor)) {
			const start = current
			const startNodes = currentNodes
			const arc = parseArcSpec(body, cursor, current, warnings)
			if (!arc) break
			cursor = arc.endIndex
			let endNodesResult = consumePathSpecs(body, cursor, warnings, named, arc.end)
			cursor = endNodesResult.end
			const endNodes = routeAbsoluteNodes(endNodesResult.nodes)
			const geometry = arc
			const arcPoint = (factor: number) => {
				const angle = (geometry.startAngle + (geometry.endAngle - geometry.startAngle) * factor) * Math.PI / 180
				const initial = geometry.startAngle * Math.PI / 180
				return start.add(cmToWorld(geometry.radiusX * (Math.cos(angle) - Math.cos(initial)), geometry.radiusY * (Math.sin(angle) - Math.sin(initial))))
			}
			for (const node of endNodes) {
				if (node.content && node.options.some(option => /^(?:pos\s*=|midway$|(?:very\s*)?near\s*(?:start|end)$)/.test(option.trim()))) {
					node.at = arcPoint(nodePositionFactor(node)); looseNodes.push(node)
				}
			}
			if (Math.abs(arc.bend) > 89 || Math.abs(geometry.radiusX - geometry.radiusY) > 1e-8) {
				// Keep large and elliptical arcs as editable sampled wires instead of changing their sweep.
				const count = Math.max(2, Math.ceil(Math.abs(geometry.endAngle - geometry.startAngle) / 5))
				const initial = (geometry.startAngle * Math.PI) / 180
				let previous = start
				for (let sample = 1; sample <= count; sample++) {
					const angle =
						((geometry.startAngle + ((geometry.endAngle - geometry.startAngle) * sample) / count) *
							Math.PI) /
						180
					const point =
						sample == count ?
							arc.end
						:	start.add(
								cmToWorld(
									geometry.radiusX * (Math.cos(angle) - Math.cos(initial)),
									geometry.radiusY * (Math.sin(angle) - Math.sin(initial))
								)
							)
					segments.push({
						kind: "line",
						start: previous,
						sampled: true,
						end: point,
						direction: WireDirection.Straight,
						startNodes: sample == 1 ? startNodes : [],
						endNodes: sample == count ? endNodes : [],
						midNodes: [],
					})
					previous = point
				}
			} else
				segments.push({
					kind: "arc",
					start,
					end: arc.end,
					startNodes,
					endNodes,
					midNodes: [],
					bend: arc.bend,
				})
			current = arc.end
			currentNodes = endNodes
			continue
		}

		const direction =
			body.startsWith("--", cursor) ? WireDirection.Straight
			: body.startsWith("-|", cursor) ? WireDirection.HV
			: body.startsWith("|-", cursor) ? WireDirection.VH
			: null
		if (direction) {
			const start = current
			const startNodes = currentNodes
			cursor += 2
			let midResult = consumePathSpecs(body, cursor, warnings, named, start)
			cursor = midResult.end
			const midNodes = routeAbsoluteNodes(midResult.nodes)
			if (hasWordAt(body, "cycle", cursor)) {
				segments.push({
					kind: "line",
					start,
					end: subpathStart.clone(),
					direction: WireDirection.Straight,
					startNodes,
					endNodes: [],
					midNodes,
				})
				current = subpathStart.clone()
				base = current.clone()
				cursor += 5
				continue
			}
			const next = readCoordinate(body, cursor, base, named, warnings)
			if (!next) {
				pushWarning(warnings, "路径连接符后缺少坐标，路径其余部分已跳过。")
				break
			}
			cursor = next.end
			base = next.base
			let endNodesResult = consumePathSpecs(body, cursor, warnings, named, next.point)
			cursor = endNodesResult.end
			const endNodes = routeAbsoluteNodes(endNodesResult.nodes)
			segments.push({
				kind: "line",
				start,
				end: next.point,
				direction,
				startNodes,
				endNodes,
				midNodes,
			})
			current = next.point
			currentNodes = endNodes
			continue
		}

		if (hasWordAt(body, "rectangle", cursor)) {
			const start = current
			const startNodes = currentNodes
			cursor += "rectangle".length
			const next = readCoordinate(body, cursor, base, named, warnings)
			if (!next) {
				pushWarning(warnings, "rectangle 后缺少终点坐标，路径其余部分已跳过。")
				break
			}
			cursor = next.end
			base = next.base
			const shapeSpecs = consumePathSpecs(body, cursor, warnings, named, next.point)
			cursor = shapeSpecs.end
			const endNodes = routeAbsoluteNodes(shapeSpecs.nodes)
			segments.push({
				kind: "rect",
				start,
				end: next.point,
				startNodes,
				endNodes,
				midNodes: [],
			})
			current = next.point
			currentNodes = endNodes
			continue
		}

		if (hasWordAt(body, "circle", cursor) || hasWordAt(body, "ellipse", cursor)) {
			const isEllipse = hasWordAt(body, "ellipse", cursor)
			const start = current
			const startNodes = currentNodes
			cursor += isEllipse ? "ellipse".length : "circle".length
			while (/\s/.test(body[cursor] ?? "")) cursor++
			let radiusCm: number | null = null
			let radiusYCm: number | null = null
			let dimensionX = false, dimensionY = false
			if (body[cursor] == "(") {
				const paren = readBalanced(body, cursor, "(", ")")
				if (paren) {
					const radii = paren.content.split(/\s+and\s+/)
					radiusCm = parseDimension(radii[0])
					radiusYCm = radii[1] ? parseDimension(radii[1]) : radiusCm
					dimensionX = /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(radii[0])
					dimensionY = radii[1] ? /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(radii[1]) : dimensionX
					cursor = paren.end
				}
			} else if (body[cursor] == "[") {
				const bracket = readBalanced(body, cursor, "[", "]")
				if (bracket) {
					for (const option of splitTopLevel(bracket.content)) {
						const { key, value } = splitKeyValue(option)
						if (normalizeOptionKey(key) == "radius" && value) {
							radiusCm = parseDimension(value)
							dimensionX = dimensionY = /(?:cm|mm|pt|in|px|pc|em|ex)\s*$/.test(value)
						}
						if (normalizeOptionKey(key) == "xradius" && value) radiusCm = parseDimension(value)
						if (normalizeOptionKey(key) == "yradius" && value) radiusYCm = parseDimension(value)
					}
					cursor = bracket.end
				}
			}
			if (radiusCm == null) {
				pushWarning(warnings, "无法解析 circle 的半径，路径其余部分已跳过。")
				break
			}
			const shapeSpecs = consumePathSpecs(body, cursor, warnings, named, start)
			cursor = shapeSpecs.end
			const endNodes = routeAbsoluteNodes(shapeSpecs.nodes)
			segments.push({
				kind: "circle",
				start,
				end: start.clone(),
				startNodes,
				endNodes,
				midNodes: [],
				radius: radiusCm * PX_PER_CM * (dimensionX ? 1 : importContext.xUnit),
				radiusY: (radiusYCm ?? radiusCm) * PX_PER_CM * (dimensionY ? 1 : importContext.yUnit),
			})
			currentNodes = endNodes
			continue
		}

		if (body.startsWith("..", cursor)) {
			const start = current
			const startNodes = currentNodes
			cursor += 2
			while (/\s/.test(body[cursor] ?? "")) cursor++
			if (!hasWordAt(body, "controls", cursor)) {
				pushWarning(warnings, "无法解析贝塞尔曲线路径，路径在此处被截断。")
				break
			}
			cursor += "controls".length
			const firstControl = readCoordinate(body, cursor, current, named, warnings)
			if (!firstControl) {
				pushWarning(warnings, "无法解析贝塞尔曲线的控制点，路径在此处被截断。")
				break
			}
			cursor = firstControl.end
			while (/\s/.test(body[cursor] ?? "")) cursor++
			if (!hasWordAt(body, "and", cursor)) {
				pushWarning(warnings, "无法解析贝塞尔曲线的控制点，路径在此处被截断。")
				break
			}
			cursor += 3
			const secondControl = readCoordinate(body, cursor, current, named, warnings)
			if (!secondControl) {
				pushWarning(warnings, "无法解析贝塞尔曲线的控制点，路径在此处被截断。")
				break
			}
			cursor = secondControl.end
			while (/\s/.test(body[cursor] ?? "")) cursor++
			if (!body.startsWith("..", cursor)) {
				pushWarning(warnings, "无法解析贝塞尔曲线的终点，路径在此处被截断。")
				break
			}
			cursor += 2
			let midResult = consumePathSpecs(body, cursor, warnings, named, start)
			cursor = midResult.end
			const next = readCoordinate(body, cursor, base, named, warnings)
			if (!next) {
				pushWarning(warnings, "贝塞尔曲线后缺少终点坐标，路径其余部分已跳过。")
				break
			}
			cursor = next.end
			base = next.base
			let endNodesResult = consumePathSpecs(body, cursor, warnings, named, next.point)
			cursor = endNodesResult.end
			const endNodes = routeAbsoluteNodes(endNodesResult.nodes)

			const pointAt = (factor: number) =>
				cubicBezierPoint(start, firstControl.point, secondControl.point, next.point, factor)
			let poleNodes: NodeSpec[] = []
			for (const node of midResult.nodes) {
				if (node.content) {
					looseNodes.push({ ...node, at: pointAt(nodePositionFactor(node)) })
				} else if (node.at) {
					looseNodes.push(node)
				} else {
					poleNodes.push(node)
				}
			}
			segments.push({ kind: "bezier", start, end: next.point, controls: [firstControl.point, secondControl.point], startNodes, endNodes, midNodes: poleNodes, positionOnPath: pointAt })
			current = next.point
			currentNodes = endNodes
			continue
		}

		pushWarning(warnings, '不支持的路径语法，位置在 "' + body.slice(cursor, cursor + 20) + '" 附近。')
		break
	}

	clipSegmentsToOutlines(segments, outlines)

	const placedPathNodes = new Set<NodeSpec>()
	const placePathNode = (node: NodeSpec, point: SVG.Point) => {
		if (node.at || placedPathNodes.has(node)) return
		const isLabel = !!node.content
		const isSymbolNode = !poleKeyFromNodeSpec(node) && nodeSymbolFromSpec(node) != null
		if (!isLabel && !isSymbolNode) return
		placedPathNodes.add(node)
		looseNodes.push({ ...node, at: point.clone() })
	}
	for (const segment of segments) {
		for (const node of segment.startNodes) placePathNode(node, segment.start)
		for (const node of segment.endNodes) {
			const explicit = node.options.some(option => /^(?:pos\s*=|midway$|(?:very\s*)?near\s*(?:start|end)$)/.test(option.trim()))
			const factor = nodePositionFactor(node)
			const point = !explicit ? segment.end : segment.positionOnPath ? segment.positionOnPath(factor) : segment.start.add(segment.end.sub(segment.start).mul(factor))
			placePathNode(node, point)
		}
		for (const node of segment.midNodes) {
			const factor = nodePositionFactor(node)
			placePathNode(
				node,
				new SVG.Point(
					segment.start.x + (segment.end.x - segment.start.x) * factor,
					segment.start.y + (segment.end.y - segment.start.y) * factor
				)
			)
		}
	}

	if (segments.length == 0) {
		for (const node of currentNodes) {
			if (node.at) looseNodes.push(node)
			else looseNodes.push({ ...node, at: first.point.clone() })
		}
	}
	return { segments, looseNodes }
}

function shapeNodeSave(spec: NodeSpec, position: SVG.Point): ComponentSaveObject | null {
	let shape: "rect" | "ellipse" | null = null
	let isCircle = false
	let width = 0
	let height = 0
	let rotation: number | undefined
	let name: string | undefined
	let strokeWidth: SVG.Number | undefined
	let hasDraw = false
	let fillColor: string | undefined
	let hasExplicitSize = false
	let innerSepCm = 10 / 3 * 2.54 / 72.27

	for (const option of spec.options) {
		const { key, value } = splitKeyValue(option)
		const normalizedKey = normalizeOptionKey(key)
		if (normalizedKey == "shape" && value) {
			const normalizedValue = normalizeName(value)
			if (normalizedValue == "rectangle") shape = "rect"
			if (normalizedValue == "ellipse" || normalizedValue == "circle") shape = "ellipse"
			isCircle = normalizedValue === "circle"
		} else if (value == undefined && normalizedKey == "rectangle") {
			shape = "rect"
			isCircle = false
		} else if (value == undefined && (normalizedKey == "ellipse" || normalizedKey == "circle")) {
			shape = "ellipse"
			isCircle = normalizedKey === "circle"
		} else if (normalizedKey == "minimumwidth" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) {
				width = parsed * PX_PER_CM
				hasExplicitSize = true
			}
		} else if (normalizedKey == "minimumheight" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) {
				height = parsed * PX_PER_CM
				hasExplicitSize = true
			}
		} else if (normalizedKey == "minimumsize" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) {
				width = parsed * PX_PER_CM
				height = width
				hasExplicitSize = true
			}
		} else if (normalizedKey == "innersep" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) innerSepCm = parsed
		} else if (normalizedKey == "linewidth" && value) {
			const parsed = parseDimension(value)
			if (parsed != null) strokeWidth = new SVG.Number(parsed, "cm")
		} else if (normalizedKey == "rotate" && value) {
			rotation = Number.parseFloat(value)
		} else if (normalizedKey == "name" && value) {
			name = stripOuterBraces(value)
		} else if (normalizedKey == "draw") {
			hasDraw = true
		} else if (normalizedKey == "fill" && value) {
			fillColor = tikzColorToCss(stripOuterBraces(value))
		}
	}

	if (!shape) return null
	if (!hasExplicitSize && spec.content) {
		const textWidth = plainTextWidthCm(spec.content)
		const lineCount = spec.content.split(/\\\\/).length
		const textHeight = 0.32 + (lineCount - 1) * 0.3
		if (shape == "ellipse") {
			const diameter = Math.max(textWidth, textHeight) + 2 * innerSepCm + 0.1
			width = diameter * PX_PER_CM
			height = width
		} else {
			width = (textWidth + 2 * innerSepCm + 0.06) * PX_PER_CM
			height = (textHeight + 2 * innerSepCm + 0.04) * PX_PER_CM
		}
	}
	if (!spec.content) {
		const padding = 2 * innerSepCm * PX_PER_CM * (shape === "ellipse" ? Math.SQRT2 : 1)
		width = Math.max(width, padding)
		height = Math.max(height, padding)
	}
	if (isCircle) width = height = Math.max(width, height)
	const borderWidth = (strokeWidth ?? new SVG.Number("0.4pt")).convertToUnit("px").value
	width += borderWidth
	height += borderWidth
	const save: any = {
		type: shape,
		position: { x: position.x, y: position.y },
		size: { x: width, y: height },
		stroke: { width: strokeWidth ?? new SVG.Number("0.4pt") },
	}
	if (!hasDraw) save.stroke.opacity = 0
	if (fillColor) save.fill = { color: fillColor }
	if (rotation) save.rotation = rotation
	if (name) save.name = name
	if (spec.content) {
		const labelValue = extractLabelValue(spec.content)
		if (labelValue) save.label = { value: labelValue, relativeToComponent: true }
	}
	return save
}

const latexSymbolText: Record<string, string> = {
	Omega: "Ω",
	Delta: "Δ",
	alpha: "α",
	approx: "≈",
	beta: "β",
	cdot: "·",
	delta: "δ",
	ge: "≥",
	geq: "≥",
	in: "∈",
	infty: "∞",
	le: "≤",
	leq: "≤",
	mu: "μ",
	omega: "ω",
	phi: "φ",
	pi: "π",
	pm: "±",
	rightarrow: "→",
	theta: "θ",
	times: "×",
	varphi: "φ",
}

function toPlainText(content: string): string {
	let text = content
	for (const [command, replacement] of Object.entries(latexSymbolText)) {
		text = text.replaceAll(new RegExp("\\\\" + command + "(?![A-Za-z])", "g"), replacement)
	}
	return text
		.replaceAll(/\\[,;:!> ]/g, "")
		.replaceAll(/\\[()[\]]/g, "")
		.replaceAll(/\\(?:mathrm|text|mathbf|mathit|mathsf|mathtt|operatorname|left|right|displaystyle)\s*/g, "")
		.replaceAll(/\\[A-Za-z]+\s*/g, "")
		.replaceAll(/[${}()[\]]/g, "")
		.replaceAll(/\s+/g, " ")
		.trim()
}

function measurePlainText(content: string): number {
	let width = 0
	for (const char of toPlainText(content)) {
		width += /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 12 : 7
	}
	return Math.max(30, Math.min(600, width + 16))
}

function plainTextWidthCm(content: string): number {
	let width = 0
	for (const char of toPlainText(content)) {
		width += /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 0.35 : 0.18
	}
	return width
}

function textNodeSave(spec: NodeSpec, position: SVG.Point): ComponentSaveObject | null {
	const content = spec.content
	if (!content) return null
	// Ordinary positioned labels have natural width in TikZ. A rectangle
	// imposes a text width and can silently wrap an otherwise single-line label.
	const plain = spec.options.every(option => {
		const { key, value } = splitKeyValue(option)
		const normalized = normalizeOptionKey(key)
		if (["voltagedir", "americanvoltages", "europeanvoltages", "straightvoltages", "raisedvoltages", "americanresistors", "europeanresistors", "americaninductors", "europeaninductors", "cuteinductors", "americancurrents", "europeancurrents"].includes(normalized)) return true
		if (normalized == "fill" && value !== undefined) return value.trim() === "none" || resolveTikzColor(value, importContext.colors) != null
		if (normalized == "align") return /^(left|center|right)$/.test(value?.trim())
		if (normalized == "anchor") return /^(?:center|north|south|east|west|north east|north west|south east|south west)$/.test(value?.trim())
		return ["rotate", "scale", "xscale", "yscale", "innersep", "pos", "midway", "nearstart", "nearend", "verynearstart", "verynearend", "font", "text", "color", "xshift", "yshift", ">", "<", "thick", "verythick", "ultrathick", "thin", "verythin", "name"].includes(normalized) || resolveTikzColor(key, importContext.colors) != null ||
			key.trim().split(/\s+/).every(word => ["above", "below", "left", "right"].includes(word))
	})
	if (plain) {
		const save: any = { type: "simpleText", position: position.clone(), text: content }
		const directions: string[] = []
		let scaleX = 1, scaleY = 1
		for (const option of spec.options) {
			const { key, value } = splitKeyValue(option)
			const normalized = normalizeOptionKey(key)
			if (normalized == "fill" && value && value.trim() !== "none") save.background = tikzColorToCss(value)
			if (normalized == "align") save.align = value.trim()
			if (normalized == "anchor") save.anchor = value.trim()
			if (normalized == "rotate") save.rotation = Number.parseFloat(value)
			if (normalized == "font" && value) save.fontSize = value.match(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/)?.[1]
			if ((["text", "color"].includes(normalized) && value) || (value === undefined && resolveTikzColor(key, importContext.colors))) save.color = tikzColorToCss(value ?? key)
			if (["xshift", "yshift"].includes(normalized) && value) {
				const amount = parseDimension(value)
				if (amount != null) save.position[normalized === "xshift" ? "x" : "y"] += amount * PX_PER_CM * (normalized === "xshift" ? 1 : -1)
			}
			if (normalized == "scale") scaleX = scaleY = Number.parseFloat(value)
			if (normalized == "xscale") scaleX = Number.parseFloat(value)
			if (normalized == "yscale") scaleY = Number.parseFloat(value)
			if (normalized == "innersep") {
				const dimension = parseDimension(value)
				if (dimension != null) save.innerSep = dimension * PX_PER_CM
			}
			for (const word of key.trim().split(/\s+/)) {
				const anchor = ({above: "south", below: "north", left: "east", right: "west"} as Record<string,string>)[word]
				if (!anchor) continue
				directions.push(anchor)
				const distance = value ? parseDimension(value) : null
				if (distance != null) {
					if (word == "above") save.position.y -= distance * PX_PER_CM
					if (word == "below") save.position.y += distance * PX_PER_CM
					if (word == "left") save.position.x -= distance * PX_PER_CM
					if (word == "right") save.position.x += distance * PX_PER_CM
				}
			}
		}
		if (directions.length) save.anchor = directions.join(" ")
		if (scaleX != 1 || scaleY != 1) save.scale = { x: scaleX, y: scaleY }
		return save
	}
	const lines = content.split(/\\\\/).length
	const longestLine = Math.max(...content.split(/\\\\/).map((line) => measurePlainText(line)))
	let width = longestLine
	let height = Math.max(32, 18 + lines * 16)
	const text: any = {
		text: content.replaceAll("\\\\", "\n"),
		align: TextAlign.CENTER,
		justify: TextJustify.CENTER,
		showPlaceholderText: true,
	}

	let anchor = ""
	let rotation: number | undefined
	let hasDraw = false
	let strokeWidth: SVG.Number | undefined
	const anchorOffset = new SVG.Point(0, 0)
	for (const option of spec.options) {
		const { key, value } = splitKeyValue(option)
		const normalizedKey = normalizeOptionKey(key)
		if (value != undefined && ["above", "below", "left", "right"].includes(normalizedKey)) {
			const distance = parseDimension(value)
			anchor +=
				" " +
				(normalizedKey == "above" ? "south"
				: normalizedKey == "below" ? "north"
				: normalizedKey == "left" ? "east"
				: "west")
			if (distance != null) {
				if (normalizedKey == "above") anchorOffset.y -= distance * PX_PER_CM
				if (normalizedKey == "below") anchorOffset.y += distance * PX_PER_CM
				if (normalizedKey == "left") anchorOffset.x -= distance * PX_PER_CM
				if (normalizedKey == "right") anchorOffset.x += distance * PX_PER_CM
			}
			continue
		}
		if (normalizedKey == "font" && value) {
			const fontMatch = value.match(/\\([A-Za-z]+)/)
			if (fontMatch) text.fontSize = fontMatch[1]
		} else if (normalizedKey == "rotate" && value) {
			const parsed = Number.parseFloat(value)
			if (!isNaN(parsed)) rotation = parsed
		} else if (normalizedKey == "anchor" && value) {
			anchor = value
		} else if ((normalizedKey == "minimumwidth" || normalizedKey == "minimumheight") && value) {
			const dimension = parseDimension(value)
			if (dimension != null) {
				if (normalizedKey == "minimumwidth") width = dimension * PX_PER_CM
				else height = dimension * PX_PER_CM
			}
		} else if (normalizedKey == "linewidth" && value) {
			const dimension = parseDimension(value)
			if (dimension != null) strokeWidth = new SVG.Number(dimension, "cm")
		} else if (value == undefined) {
			for (const word of key.trim().toLowerCase().split(/\s+/)) {
				if (["above", "below", "left", "right", "north", "south", "east", "west"].includes(word)) {
					anchor +=
						" " +
						(word == "above" ? "south"
						: word == "below" ? "north"
						: word == "left" ? "east"
						: word == "right" ? "west"
						: word)
				}
			}
			if (normalizedKey == "draw") hasDraw = true
		} else if (normalizedKey == "draw") {
			hasDraw = true
		}
	}

	const borderWidth = (strokeWidth ?? new SVG.Number("0.4pt")).convertToUnit("px").value
	width += borderWidth
	height += borderWidth

	const center = position.clone().add(anchorOffset)
	const normalizedAnchor = normalizeOptionKey(anchor)
	if (!anchor) {
		// default anchoring is the center of the node
	} else {
		if (normalizedAnchor.includes("south")) center.y -= height / 2
		if (normalizedAnchor.includes("north")) center.y += height / 2
		if (normalizedAnchor.includes("east")) center.x -= width / 2
		if (normalizedAnchor.includes("west")) center.x += width / 2
	}

	const save: any = {
		type: "rect",
		position: { x: center.x, y: center.y },
		size: { x: width, y: height },
		text,
	}
	if (!hasDraw) {
		save.stroke = { opacity: 0, width: new SVG.Number("0.4pt") }
	} else if (strokeWidth) {
		save.stroke = { width: strokeWidth }
	}
	if (rotation) save.rotation = rotation
	return save
}

function hasNodeShapeOption(spec: NodeSpec): boolean {
	return spec.options.some((option) => {
		const { key, value } = splitKeyValue(option)
		const normalizedKey = normalizeOptionKey(key)
		if (value == undefined && ["rectangle", "ellipse", "circle"].includes(normalizedKey)) {
			return true
		}
		if (normalizedKey == "shape" && value) {
			const normalizedValue = normalizeName(value)
			return normalizedValue == "rectangle" || normalizedValue == "ellipse" || normalizedValue == "circle"
		}
		return false
	})
}

function nodeSaveFromSpec(spec: NodeSpec, position: SVG.Point, warnings: string[]): ComponentSaveObject | null {
	const nodeSymbol = spec.options
		.filter((option) => !option.includes("="))
		.map((option) => resolveNodeSymbol(option))
		.find((symbol) => symbol != null)
	if (nodeSymbol) {
		const save: any = {
			type: "node",
			id: nodeSymbol.tikzName,
			position: { x: position.x, y: position.y },
		}
		let rotation: number | undefined
		let scaleX: number | undefined
		let scaleY: number | undefined
		let name: string | undefined
		const optionNames: string[] = []
		for (const option of spec.options) {
			const { key, value } = splitKeyValue(option)
			const normalizedKey = normalizeName(key)
			if (normalizedKey == "rotate" && value) {
				rotation = Number.parseFloat(value)
				continue
			}
			if (normalizedKey == "xscale" && value) {
				scaleX = Number.parseFloat(value)
				continue
			}
			if (normalizedKey == "yscale" && value) {
				scaleY = Number.parseFloat(value)
				continue
			}
			if (normalizedKey == "scale" && value) {
				scaleX = scaleY = Number.parseFloat(value)
				continue
			}
			if (normalizedKey == "name" && value) {
				name = stripOuterBraces(value)
				continue
			}
			if (normalizedKey == "anchor") continue
			if (option.includes("=")) {
				if (value) optionNames.push(stripOuterBraces(value))
			} else if (nodeSymbol != resolveNodeSymbol(key)) {
				optionNames.push(key)
			}
		}
		const foundOptions = nodeSymbol.getOptionsFromOptionNames(optionNames)
		if (foundOptions.length > 0) save.options = foundOptions.map((option) => option.name)
		if (rotation) save.rotation = rotation
		if (scaleX != undefined || scaleY != undefined) {
			save.scale = { x: scaleX ?? 1, y: scaleY ?? 1 }
		}
		if (name) save.name = name
		if (spec.content) {
			const labelValue = extractLabelValue(spec.content)
			if (labelValue) save.label = { value: labelValue }
		}
		return save
	}

	if (spec.content && hasNodeShapeOption(spec)) {
		const shapedSave = shapeNodeSave(spec, position)
		if (shapedSave) return shapedSave
	}
	if (spec.content) {
		return textNodeSave(spec, position)
	}
	const shapeSave = shapeNodeSave(spec, position)
	if (shapeSave) {
		return shapeSave
	}
	const labelOption = spec.options
		.map((option) => splitKeyValue(option))
		.find((option) => normalizeOptionKey(option.key) == "label" && option.value)
	if (labelOption?.value) {
		const separator = labelOption.value.indexOf(":")
		const placement = separator >= 0 ? labelOption.value.slice(0, separator).trim() : ""
		const labelText = separator >= 0 ? labelOption.value.slice(separator + 1) : labelOption.value
		const content = extractLabelValue(labelText)
		if (content) {
			const placementOptions = placement
				.split(/[\s,]+/)
				.filter((word) => ["above", "below", "left", "right"].includes(word))
			return textNodeSave({ ...spec, content, options: placementOptions }, position)
		}
	}
	if (spec.options.length > 0) {
		pushWarning(warnings, "不支持的节点：" + spec.options.join(", "))
	}
	return null
}

function addPoleNode(node: NodeSpec, point: SVG.Point, components: any[], warnings: string[]) {
	const poleKey = poleKeyFromNodeSpec(node)
	if (!poleKey) return
	const symbol = resolveNodeSymbol(poleKey)
	if (symbol) {
		components.push({
			type: "node",
			id: symbol.tikzName,
			position: { x: point.x, y: point.y },
		})
	} else {
		pushWarning(warnings, '未知的端子节点 "' + poleKey + '"。')
	}
}

function claimPolesOnComponents(segments: Segment[]) {
	for (const segment of segments) {
		if (segment.kind != "component") continue
		for (const node of segment.startNodes.concat(segment.endNodes)) {
			if (poleKeyFromNodeSpec(node)) node.claimed = true
		}
	}
}

function firstUnclaimedPole(nodes: NodeSpec[]): string | undefined {
	for (const node of nodes) {
		if (node.claimed) continue
		const key = poleKeyFromNodeSpec(node)
		if (key) return key
	}
	return undefined
}

function firstPole(nodes: NodeSpec[]): string | undefined {
	for (const node of nodes) {
		const key = poleKeyFromNodeSpec(node)
		if (key) return key
	}
	return undefined
}

function parseFillColor(options: string[]): string | undefined {
	for (const token of options) {
		const { key, value } = splitKeyValue(token)
		if (normalizeOptionKey(key) == "fill" && value != undefined) {
			const color = stripOuterBraces(value)
			if (color != "" && normalizeName(color) != "none") return tikzColorToCss(color)
		}
	}
	return undefined
}

function buildShapeComponent(
	segment: Segment,
	commandKind: ParsedCommand["kind"],
	commandOptions: string[],
	stroke: CommandStroke
): any | null {
	const strokeWidth = stroke.width ?? new SVG.Number("0.4pt")
	const strokeWidthPx = strokeWidth.convertToUnit("px").value
	const explicitFill = parseFillColor(commandOptions)
	const isFill = commandKind == "fill"
	const isFillDraw = commandKind == "filldraw"
	const shouldFill = isFill || isFillDraw || explicitFill != undefined

	let type: "rect" | "ellipse"
	let position: SVG.Point
	let width: number
	let height: number
	if (segment.kind == "rect") {
		type = "rect"
		position = new SVG.Point((segment.start.x + segment.end.x) / 2, (segment.start.y + segment.end.y) / 2)
		width = Math.abs(segment.end.x - segment.start.x)
		height = Math.abs(segment.end.y - segment.start.y)
	} else if (segment.kind == "circle") {
		const radius = segment.radius ?? 0
		if (radius < 0.3) return null
		type = "ellipse"
		position = segment.start.clone()
		width = radius * 2
		height = (segment.radiusY ?? radius) * 2
	} else {
		return null
	}

	// ShapeComponent subtracts the stored stroke width from its visible size,
	// including filled-only shapes whose stroke opacity is zero.
	const padding = strokeWidthPx
	const save: any = {
		type,
		__pathPrimitive: true,
		position: { x: position.x, y: position.y },
		size: { x: width + padding, y: height + padding },
		stroke: { width: strokeWidth },
	}
	if (isFill) {
		save.stroke.opacity = 0
	} else {
		if (stroke.color) save.stroke.color = stroke.color
		if (stroke.opacity != undefined) save.stroke.opacity = stroke.opacity
		if (stroke.style) save.stroke.style = stroke.style
	}
	if (shouldFill) {
		save.fill = { color: explicitFill ?? stroke.color ?? "#000000" }
	}
	return save
}

function buildPathComponent(segment: Segment, warnings: string[]): any | null {
	const to = segment.to
	if (!to) return null

	const poleFromNodesStart = firstPole(segment.startNodes)
	const poleFromNodesEnd = firstPole(segment.endNodes)
	const startPole = to.poles.start ?? poleFromNodesStart
	const endPole = to.poles.end ?? poleFromNodesEnd
	const poles =
		startPole || endPole ?
			{
				start: startPole,
				end: endPole,
			}
		:	undefined

	if (to.isShort || to.isOpen) {
		const save: any = {
			type: to.isShort ? "short" : "open",
			points: [
				{ x: segment.start.x, y: segment.start.y },
				{ x: segment.end.x, y: segment.end.y },
			],
		}
		if (poles) save.poles = poles
		if (to.scale && to.scale != 1) save.scale = to.scale
		if (to.label?.value) save.label = to.label
		if (to.isShort && to.current?.label) save.current = to.current
		if (to.isOpen && to.voltage?.label) save.voltage = to.voltage
		return save
	}

	const symbol = to.symbol
	if (!symbol) {
		return null
	}
	const optionTokens = to.optionCandidates.concat(to.componentName ? [] : [])
	const foundOptions = symbol.getOptionsFromOptionNames(optionTokens)
	const options: string[] = []
	for (const option of foundOptions) {
		if (!options.includes(option.name)) {
			options.push(option.name)
		}
	}
	const save: any = {
		type: "path",
		id: symbol.tikzName,
		bipoleThickness: to.bipoleThickness ?? importedBipoleThickness,
		points: [
			{ x: segment.start.x, y: segment.start.y },
			{ x: segment.end.x, y: segment.end.y },
		],
		options,
	}
	if (poles) save.poles = poles
	if (to.label?.value) save.label = to.label
	if (to.voltage) save.voltage = to.voltage
	if (to.current?.label) save.current = to.current
	if (to.name) save.name = to.name
	const scale = to.scale ?? 1
	const scaleState = new SVG.Point(scale * (to.invert ? -1 : 1), scale * (to.mirror ? -1 : 1))
	if (scaleState.x != 1 || scaleState.y != 1) {
		save.scale = { x: scaleState.x, y: scaleState.y }
	}
	return save
}

export function parseCircuiTikz(source: string): TikzImportResult {
	const previous = importContext
	const prepared = prepareTikz(source)
	importedBipoleThickness = undefined
	importContext = { colors: collectTikzColors(prepared.source), warnings: prepared.warnings, xUnit: 1, yUnit: 1, styles: new TikzStyles(), nodeOptions: [], fontSizePt: 10 }
	try { return parsePreparedTikz(prepared.source) }
	finally { importContext = previous }
}

function parsePreparedTikz(source: string): TikzImportResult {
	const warnings = importContext.warnings
	const components: any[] = []
	const cleaned = source
	const environment = extractEnvironmentBodies(cleaned)
	if (environment.pictures.length > 1) {
		const preamble = cleaned.slice(0, cleaned.search(/\\begin\{(?:circuitikz|tikzpicture)\}/))
		for (const picture of environment.pictures) {
			const result = parseCircuiTikz(
				preamble + "\\begin{circuitikz}[" + picture.options.join(",") + "]" + picture.body + "\\end{circuitikz}"
			)
			components.push(...result.components)
			for (const warning of result.warnings) pushWarning(warnings, warning)
		}
		pushWarning(warnings, "检测到多个绘图环境，已分别解析并按原坐标叠放；建议每次导入一幅图。")
		return { components, warnings }
	}
	const initialStyles = new TikzStyles()
	const preamble = cleaned.slice(0, Math.max(0, cleaned.search(/\\begin\{(?:tikzpicture|circuitikz)\}/)))
	for (const match of preamble.matchAll(/\\tikzset\s*/g)) {
		const group = readTikzGroup(preamble, match.index + match[0].length)
		if (group) initialStyles.define(group.content)
	}
	let hints = defaultStyleHints()
	for (const match of cleaned.matchAll(/\\usepackage\s*\[([^\]]*)\]\s*\{circuitikz\}/g)) {
		hints = applyStyleTokens(splitTopLevel(match[1]), hints)
	}
	hints = applyStyleTokens(environment.options, hints)
	for (const match of cleaned.matchAll(/\\ctikzset\s*(?=\{)/g)) {
		const group = readBalanced(cleaned, match.index + match[0].length, "{", "}")
		if (!group) continue
		const tokens = splitTopLevel(group.content)
		hints = applyStyleTokens(tokens, hints)
		const unsupported = tokens.filter(token => {
			const { key, value } = splitKeyValue(token)
			if (normalizeOptionKey(key) === "bipoles/thickness") {
				const thickness = value ? evaluateArithmetic(value) : null
				if (thickness != null && thickness >= 0) { importedBipoleThickness = thickness; return false }
			}
			return !(normalizeOptionKey(key) == "voltagedir" && ["old", "noold", "RP", "EF"].includes(value)) &&
				!(normalizeOptionKey(key) == "label/align" && value == "smart")
		})
		if (unsupported.length) pushWarning(warnings, "未恢复全局 \\ctikzset 设置：" + unsupported.join(", "))
	}
	const bodies = environment.bodies.length > 0 ? environment.bodies : [cleaned]
	const commands: ParsedCommand[] = []
	for (const body of bodies) {
		commands.push(...extractCommands(body, environment.options, initialStyles))
	}
	if (commands.length == 0) {
		warnings.push("未找到 \\draw、\\path 或 \\node 命令。")
		return { components, warnings }
	}

	const worldCoordinates: NamedCoordinates = new Map()
	const worldOutlines: NodeOutlines = new Map()

	for (const command of commands) {
		importContext.xUnit = command.xUnit
		importContext.yUnit = command.yUnit
		importContext.styles = command.styles
		importContext.nodeOptions = command.options.filter(option => {
			const { key, value } = splitKeyValue(option)
			return ["font", "text", "color"].includes(normalizeOptionKey(key)) || (value === undefined && resolveTikzColor(key, importContext.colors) != null)
		})
		const inverse = command.matrix.inverse()
		const namedCoordinates: NamedCoordinates = new Map(
			[...worldCoordinates].map(([name, point]) => [name, point.transform(inverse)])
		)
		const nodeOutlines: NodeOutlines = new Map(
			[...worldOutlines].map(([name, outline]) => [
				name,
				{ ...outline, center: outline.center.transform(inverse) },
			])
		)
		const firstComponent = components.length
		try {
			const ar = parseArrowOptions(command.options)
			const stroke = parseStrokeOptions(command.options)
			const commandHints = applyStyleTokens(command.options, hints)
			for (const token of command.options) {
				const { key, value } = splitKeyValue(token)
				if (value !== undefined || /^[-<>|.*o]+$/.test(key.trim()) || parseArrowOption(key.trim(), ar.defaultTip) || resolveTikzColor(key, importContext.colors)) continue
				const known = ["draw", "fill", "thick", "verythick", "ultrathick", "thin", "verythin", "dashed", "denselydashed", "looselydashed", "dotted", "denselydotted", "looselydotted", "dashdot", "solid", "transformshape", "americanvoltages", "europeanvoltages", "americanresistors", "europeanresistors", "americaninductors", "europeaninductors", "cuteinductors", "europeancurrents", "americancurrents", "above", "below", "left", "right", "aboveleft", "aboveright", "belowleft", "belowright", "midway", "nearstart", "nearend", "rectangle", "circle", "ellipse", "invert", "mirror", "noinvinputdown"]
				if (!known.includes(normalizeOptionKey(key)) && !resolveNodeSymbol(key)) {
					const message = "未识别的样式或颜色已保留在原始源码中：" + key
					if (!warnings.includes(message)) pushWarning(warnings, message)
				}
			}

			if (command.kind == "coordinate") {
				const operation = readCoordinateOperation("coordinate " + command.body, 0, namedCoordinates, warnings)
				if (operation?.name) {
					if (operation.invalidAt) {
						pushWarning(warnings, '无法解析坐标 "' + operation.name + '" 的位置定义，已跳过。')
					} else {
						namedCoordinates.set(operation.name, operation.at?.clone() ?? new SVG.Point(0, 0))
					}
				} else {
					pushWarning(warnings, "已跳过没有名称的坐标定义。")
				}
				continue
			}

			if (command.kind == "node") {
				const reconstructed =
					"node" + (command.options.length ? "[" + command.options.join(", ") + "]" : "") + " " + command.body
				let cursor = 0
				let previousPosition: SVG.Point | undefined
				while (hasWordAt(reconstructed, "node", cursor)) {
					const parsed = readNodeSpec(reconstructed, cursor, namedCoordinates, warnings)
					if (!parsed) break
					cursor = parsed.end
					while (/\s/.test(reconstructed[cursor] ?? "")) cursor++
					if (isCoordinateNodeSpec(parsed.spec)) {
						const name = nodeSpecName(parsed.spec)
						if (name) {
							if (parsed.spec.atInvalid) {
								pushWarning(warnings, '无法解析坐标 "' + name + '" 的位置定义，已跳过。')
							} else {
								namedCoordinates.set(name, parsed.spec.at?.clone() ?? new SVG.Point(0, 0))
							}
						}
						continue
					}
					const position = parsed.spec.atInvalid ? undefined : (parsed.spec.at ?? previousPosition)
					if (!position) {
						pushWarning(warnings, "已跳过缺少 at 坐标的节点。")
					} else {
						previousPosition = position
						const registered = registerNodeCoordinates(
							namedCoordinates,
							nodeOutlines,
							parsed.spec,
							position
						)
						const save = nodeSaveFromSpec(parsed.spec, registered.center, warnings)
						if (save) components.push(save)
					}
				}
				continue
			}
			if (/^plot\b/.test(command.body)) {
				let cursor = 4
				while (/\s/.test(command.body[cursor] ?? "")) cursor++
				const plotOptions = command.body[cursor] === "[" ? readTikzGroup(command.body, cursor, "[", "]") : null
				if (plotOptions) { cursor = plotOptions.end; while (/\s/.test(command.body[cursor] ?? "")) cursor++ }
				const coordinates = readBalanced(command.body, cursor, "(", ")")
				const expressions = coordinates && splitTopLevel(coordinates.content)
				if (!expressions || expressions.length !== 2 || command.body.slice(coordinates.end).trim()) {
					pushWarning(warnings, "此 plot 语法未转换，已保留原始源码：" + command.body.slice(0, 100)); continue
				}
				const plot: PlotDefinition = { x: stripOuterBraces(expressions[0]), y: stripOuterBraces(expressions[1]), domain: [-5, 5], samples: 100 }
				for (const option of command.options.concat(plotOptions ? splitTopLevel(plotOptions.content) : [])) {
					const { key, value } = splitKeyValue(option)
					if (key.trim() === "domain" && value) {
						const bounds = splitTopLevel(value, ":").map(evaluateArithmetic)
						if (bounds.length === 2 && bounds.every(n => n != null)) plot.domain = bounds as [number, number]
						else throw Error("无效的 plot 定义域：" + value)
					}
					if (key.trim() === "samples" && value) plot.samples = evaluateArithmetic(value)
				}
				const points = samplePlot(plot).map(point => ({ x: point.x * command.xUnit, y: point.y * command.yUnit }))
				components.push({ type: "plot", plot, points, directions: points.slice(1).map(() => "--"), preserveGeometry: true, stroke,
					...(ar.start ? { startArrow: ar.start } : {}), ...(ar.end ? { endArrow: ar.end } : {}) })
				continue
			}

			const pathResult = parsePath(command.body, ar, commandHints, warnings, namedCoordinates, nodeOutlines, command.options)
			const segments = pathResult.segments
			if (pathResult.looseNodes.length > 0) {
				for (const node of pathResult.looseNodes) {
					if (node.at) {
						const registered = registerNodeCoordinates(namedCoordinates, nodeOutlines, node, node.at)
						const save = nodeSaveFromSpec(node, registered.center, warnings)
						if (save) components.push(save)
					}
				}
			}
			if (segments.length == 0) {
				continue
			}

			if (command.kind == "path") {
				const hasComponent = segments.some((segment) => segment.kind == "component")
				const hasArc = segments.some((segment) => segment.kind == "arc")
				const hasShape = segments.some((segment) => segment.kind == "rect" || segment.kind == "circle")
				if (!hasComponent && !hasArc && !hasShape) {
					continue
				}
			}

			claimPolesOnComponents(segments)

			const builtObjects: { object: any; first: number; last: number; kind: string }[] = []
			let lineGroup: Segment[] = []
			let lineGroupStart = 0

			const flushLineGroup = () => {
				if (lineGroup.length == 0) return
				const points = [lineGroup[0].start, ...lineGroup.map((segment) => segment.end)]
				const directions = lineGroup.map((segment) => segment.direction ?? WireDirection.Straight)
				const startPole = firstUnclaimedPole(lineGroup[0].startNodes)
				const lastNodes = lineGroup.at(-1).endNodes
				const endPole = firstUnclaimedPole(lastNodes)
				// Exported sampled curves are plain editable polylines. Recognize
				// dense non-orthogonal geometry again when importing that export.
				const preserveGeometry = lineGroup.some(segment => segment.sampled) ||
					(lineGroup.length >= 8 && lineGroup.some(segment =>
						Math.abs(segment.start.x - segment.end.x) > 1e-6 && Math.abs(segment.start.y - segment.end.y) > 1e-6))
				const save: any = {
					type: "wire",
					...(preserveGeometry ? { preserveGeometry: true } : {}),
					points: points.map((point) => ({ x: point.x, y: point.y })),
					directions,
					stroke: { width: stroke.width ?? new SVG.Number("0.4pt") },
				}
				const fill = parseFillColor(command.options)
				if ((fill || command.kind === "fill" || command.kind === "filldraw") && points[0].sub(points.at(-1)).abs() < 1e-6 && points.length >= 4) {
					save.type = "polygon"
					save.fill = { color: fill ?? stroke.color ?? "#000000" }
					if (command.kind === "fill") save.stroke.opacity = 0
				}
				if (startPole || endPole) {
					save.poles = { start: startPole, end: endPole }
				}
				if (stroke.color) save.stroke.color = stroke.color
				if (stroke.opacity != undefined) save.stroke.opacity = stroke.opacity
				if (stroke.style) save.stroke.style = stroke.style
				components.push(save)
				builtObjects.push({
					object: save,
					first: lineGroupStart,
					last: lineGroupStart + lineGroup.length - 1,
					kind: "wire",
				})

				for (let index = 0; index < lineGroup.length; index++) {
					const segment = lineGroup[index]
					if (index < lineGroup.length - 1) {
						for (const node of segment.endNodes) {
							if (!node.claimed) addPoleNode(node, segment.end, components, warnings)
						}
					}
					for (const node of segment.midNodes) {
						if (!node.claimed)
							addPoleNode(node, segment.start.add(segment.end).div(2), components, warnings)
					}
				}
				lineGroup = []
			}

			segments.forEach((segment, index) => {
				if (segment.kind == "line") {
					// A bare coordinate starts a new subpath. Never bridge the gap by
					// joining the previous endpoint to this segment's endpoint.
					if (lineGroup.length && lineGroup.at(-1).end.sub(segment.start).abs() > 1e-6)
						flushLineGroup()
					if (lineGroup.length == 0) lineGroupStart = index
					lineGroup.push(segment)
					return
				}
				flushLineGroup()
				if (segment.kind == "component") {
					const save = buildPathComponent(segment, warnings)
					if (save) {
						components.push(save)
						builtObjects.push({ object: save, first: index, last: index, kind: "component" })
					}
				} else if (segment.kind == "arc" || segment.kind == "bezier") {
					const save: any = {
						type: segment.kind,
						points: [
							{ x: segment.start.x, y: segment.start.y },
							{ x: segment.end.x, y: segment.end.y },
						],
						bend: segment.bend ?? 45,
						stroke: { width: stroke.width ?? new SVG.Number("0.4pt") },
					}
					if (segment.controls) {
						save.points.push(...segment.controls.map(point => ({ x: point.x, y: point.y })))
						delete save.bend
					}
					if (stroke.color) save.stroke.color = stroke.color
					if (stroke.opacity != undefined) save.stroke.opacity = stroke.opacity
					if (stroke.style) save.stroke.style = stroke.style
					components.push(save)
					builtObjects.push({ object: save, first: index, last: index, kind: "arc" })
					for (const node of segment.startNodes) {
						addPoleNode(node, segment.start, components, warnings)
					}
					for (const node of segment.endNodes) {
						addPoleNode(node, segment.end, components, warnings)
					}
				} else if (segment.kind == "rect" || segment.kind == "circle") {
					const save = buildShapeComponent(segment, command.kind, command.options, stroke)
					if (save) {
						components.push(save)
						builtObjects.push({ object: save, first: index, last: index, kind: "shape" })
					}
				}
			})
			flushLineGroup()

			const firstObject = builtObjects.find((entry) => entry.first == 0)
			const lastObject = builtObjects.find((entry) => entry.last == segments.length - 1)
			if (ar.start) {
				if (firstObject && (firstObject.kind == "wire" || firstObject.kind == "arc")) {
					firstObject.object.startArrow = ar.start
				} else {
					pushWarning(warnings, "不支持二端元件起点的箭头，已忽略。")
				}
			}
			if (ar.end) {
				if (lastObject && (lastObject.kind == "wire" || lastObject.kind == "arc")) {
					lastObject.object.endArrow = ar.end
				} else {
					pushWarning(warnings, "不支持二端元件终点的箭头，已忽略。")
				}
			}
			if (ar.middle) {
				const onlyObject = builtObjects.length == 1 ? builtObjects[0] : null
				if (onlyObject && (onlyObject.kind == "wire" || onlyObject.kind == "arc")) {
					onlyObject.object.middleArrow = ar.middle
					if (ar.middlePosition != undefined) {
						onlyObject.object.middleArrowPosition = ar.middlePosition
					}
				} else if (segments.length > 1) {
					pushWarning(warnings, "包含多个元件的路径上的装饰箭头已忽略。")
				}
			}

			const wireOrArcObjects = builtObjects.filter((entry) => entry.kind == "wire" || entry.kind == "arc")
			if (stroke.width || stroke.color || stroke.opacity != undefined || stroke.style) {
				for (const entry of wireOrArcObjects) {
					entry.object.stroke = entry.object.stroke ?? {}
					if (stroke.width) entry.object.stroke.width = stroke.width
					if (stroke.color) entry.object.stroke.color = stroke.color
					if (stroke.opacity != undefined) entry.object.stroke.opacity = stroke.opacity
					if (stroke.style) entry.object.stroke.style = stroke.style
				}
			}
		} finally {
			for (const [name, point] of namedCoordinates) worldCoordinates.set(name, point.transform(command.matrix))
			for (const [name, outline] of nodeOutlines)
				worldOutlines.set(name, { ...outline, center: outline.center.transform(command.matrix) })
			for (const component of components.slice(firstComponent)) {
				if (component.points)
					component.points = component.points.map((point: SVG.Point) => {
						const translated = new SVG.Point(point).transform(command.matrix)
						return { x: translated.x, y: translated.y }
					})
				if (component.position) {
					const translated = new SVG.Point(component.position).transform(command.matrix)
					component.position = { x: translated.x, y: translated.y }
				}
				const sx = Math.hypot(command.matrix.a, command.matrix.b), sy = Math.hypot(command.matrix.c, command.matrix.d)
				const angle = -Math.atan2(command.matrix.b, command.matrix.a) * 180 / Math.PI
				if (component.__pathPrimitive || command.transformShape) {
					if (component.size) component.size = { x: component.size.x * sx, y: component.size.y * sy }
					else if (["path", "node", "short", "open", "simpleText"].includes(component.type) && (sx !== 1 || sy !== 1)) {
						if (["short", "open"].includes(component.type)) component.scale = (typeof component.scale === "number" ? component.scale : 1) * Math.sqrt(sx * sy)
						else if (typeof component.scale === "number") component.scale *= Math.sqrt(sx * sy)
						else component.scale = { x: (component.scale?.x ?? 1) * sx, y: (component.scale?.y ?? 1) * sy }
					}
					if (component.position && Math.abs(angle) > 1e-8) component.rotation = (component.rotation ?? 0) + angle
				}
				delete component.__pathPrimitive
			}
		}
	}

	return { components, warnings }
}
