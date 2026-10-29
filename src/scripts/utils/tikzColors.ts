import { readTikzGroup } from "./tikzMath"

export const tikzNamedColors: Record<string, string> = {
	black: "#000000", white: "#ffffff", red: "#ff0000", green: "#00ff00", blue: "#0000ff",
	cyan: "#00ffff", magenta: "#ff00ff", yellow: "#ffff00", gray: "#808080", darkgray: "#404040",
	lightgray: "#bfbfbf", brown: "#bf8040", lime: "#bfff00", olive: "#808000", orange: "#ff8000",
	pink: "#ffbfbf", purple: "#bf0040", teal: "#008080", violet: "#800080",
}
const byte = (value: number) => Math.round(Math.max(0, Math.min(255, value))).toString(16).padStart(2, "0")
const hex = (r: number, g: number, b: number) => "#" + byte(r) + byte(g) + byte(b)

export function resolveTikzColor(value: string, custom = new Map<string, string>()): string | null {
	let text = value.trim().replace(/^\{(.*)\}$/, "$1").trim()
	const rgb = text.match(/^rgb,255:red,(\d+);green,(\d+);blue,(\d+)$/)
	if (rgb) return hex(Number(rgb[1]), Number(rgb[2]), Number(rgb[3]))
	const parts = text.split("!")
	const basic = (name: string) => custom.get(name.trim()) ?? tikzNamedColors[name.trim()] ?? (/^#[\da-f]{6}$/i.test(name.trim()) ? name.trim() : null)
	const inverted = parts[0].startsWith("-")
	let color = basic(inverted ? parts[0].slice(1) : parts[0])
	if (!color) return null
	if (inverted) color = hex(...[1, 3, 5].map(i => 255 - parseInt(color.slice(i, i + 2), 16)) as [number, number, number])
	for (let i = 1; i < parts.length; i += 2) {
		if (!/^\d+(?:\.\d*)?$/.test(parts[i])) return null
		const ratio = Number(parts[i]) / 100
		const other = basic(parts[i + 1] || "white")
		if (!other || ratio < 0 || ratio > 1) return null
		color = hex(...[1, 3, 5].map(k => parseInt(color.slice(k, k + 2), 16) * ratio + parseInt(other.slice(k, k + 2), 16) * (1 - ratio)) as [number, number, number])
	}
	return color
}

export function collectTikzColors(source: string): Map<string, string> {
	const colors = new Map<string, string>()
	for (const match of source.matchAll(/\\(definecolor|providecolor|colorlet)\s*(?=\{)/g)) {
		let cursor = match.index + match[0].length
		const groups: string[] = []
		for (let i = 0; i < (match[1] === "colorlet" ? 2 : 3); i++) {
			while (/\s/.test(source[cursor] ?? "")) cursor++
			const group = readTikzGroup(source, cursor)
			if (!group) break
			groups.push(group.content.trim()); cursor = group.end
		}
		let color: string
		if (match[1] === "colorlet" && groups.length === 2) color = resolveTikzColor(groups[1], colors)
		else if (groups.length === 3) {
			const [name, model, spec] = groups
			if (model === "HTML" && /^[\da-f]{6}$/i.test(spec)) color = "#" + spec.toLowerCase()
			else {
				const values = spec.split(",").map(Number)
				if (values.every(Number.isFinite)) {
					if (model === "RGB" && values.length === 3) color = hex(values[0], values[1], values[2])
					if (model === "rgb" && values.length === 3) color = hex(values[0] * 255, values[1] * 255, values[2] * 255)
					if (model === "gray" && values.length === 1) color = hex(values[0] * 255, values[0] * 255, values[0] * 255)
				}
			}
			if (match[1] === "providecolor" && colors.has(name)) continue
		}
		if (color) colors.set(groups[0], color)
	}
	return colors
}
