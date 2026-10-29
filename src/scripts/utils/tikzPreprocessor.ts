import { evaluateTikzMath, readTikzGroup, splitTikzOptions } from "./tikzMath"

type Macro = { body: string; args: number; optional?: string }
export type TikzPreparation = { source: string; warnings: string[] }

/** Expand a documented, bounded subset, leaving unknown TeX intact for source export. */
export function prepareTikz(source: string): TikzPreparation {
	if (source.length > 1200 * 1024) throw Error("TikZ 输入超过 1200 KiB。")
	const warnings: string[] = []
	const warn = (message: string) => { if (!warnings.includes(message) && warnings.length < 50) warnings.push(message) }
	let iterations = 0, emitted = 0
	function expand(input: string, macros: Map<string, Macro>, depth = 0): string {
		if (depth > 32) throw Error("TikZ 宏或循环嵌套超过 32 层。")
		let result = "", index = 0
		const scopes: Map<string, Macro>[] = []
		const skip = (i: number) => { while (/\s/.test(input[i] ?? "")) i++; return i }
		while (index < input.length) {
			if (input[index] === "%") {
				while (index < input.length && input[index] !== "\n") index++
				result += "\n"; continue
			}
			if (input[index] === "{") {
				const group = readTikzGroup(input, index)
				if (group) { result += "{" + expand(group.content, new Map(macros), depth + 1) + "}"; index = group.end; continue }
			}
			const command = input.slice(index).match(/^\\([A-Za-z]+)\*?/)
			if (!command) {
				// Escaped percent, braces and linebreaks are literal, not parser delimiters.
				if (input[index] === "\\" && index + 1 < input.length) { result += input.slice(index, index + 2); index += 2 }
				else result += input[index++]
				continue
			}
			const name = command[1]
			let cursor = skip(index + command[0].length)
			if (name === "begin" || name === "end") {
				const environment = readTikzGroup(input, cursor)
				if (environment?.content === "scope") {
					if (name === "begin") { scopes.push(macros); macros = new Map(macros) }
					else if (scopes.length) macros = scopes.pop()
					result += command[0] + "{scope}"; index = environment.end; continue
				}
			}
			if (["newcommand", "renewcommand", "providecommand", "def"].includes(name)) {
				let target: string, args = 0, optional: string
				if (input[cursor] === "{") {
					const group = readTikzGroup(input, cursor)
					if (group) { target = group.content.trim().match(/^\\([A-Za-z]+)$/)?.[1]; cursor = skip(group.end) }
				} else {
					const token = input.slice(cursor).match(/^\\([A-Za-z]+)/)
					if (token) { target = token[1]; cursor = skip(cursor + token[0].length) }
				}
				if (name === "def") {
					const params = input.slice(cursor).match(/^(?:#[1-9])*/)?.[0] ?? ""
					if (params && params !== Array.from({ length: params.length / 2 }, (_, i) => "#" + (i + 1)).join("")) target = null
					args = params.length / 2; cursor = skip(cursor + params.length)
				} else if (input[cursor] === "[") {
					const count = readTikzGroup(input, cursor, "[", "]")
					if (count && /^[0-9]$/.test(count.content.trim())) { args = Number(count.content); cursor = skip(count.end) }
					else target = null
					if (input[cursor] === "[") {
						const value = readTikzGroup(input, cursor, "[", "]")
						if (value) { optional = value.content; cursor = skip(value.end) }
					}
				}
				const body = readTikzGroup(input, cursor)
				if (target && body) {
					if (name !== "providecommand" || !macros.has(target)) macros.set(target, { body: body.content, args, ...(optional !== undefined ? { optional } : {}) })
					index = body.end; continue
				}
				warn("暂不支持的宏定义已保留在原始源码中：\\" + name)
			}
			if (name === "pgfmathsetmacro" || name === "pgfmathtruncatemacro") {
				const target = readTikzGroup(input, cursor)
				const body = target && readTikzGroup(input, skip(target.end))
				const variable = target?.content.trim().match(/^\\([A-Za-z]+)$/)?.[1]
				if (variable && body) {
					const expression = expand(body.content, macros, depth + 1)
					const value = evaluateTikzMath(expression)
					if (value != null) { macros.set(variable, { body: String(name === "pgfmathtruncatemacro" ? Math.trunc(value) : value), args: 0 }); index = body.end; continue }
					warn("无法计算 \\" + name + " 的表达式：" + expression)
				}
			}
			if (name === "foreach") {
				const variables: string[] = []
				while (true) {
					const variable = input.slice(cursor).match(/^\\([A-Za-z]+)/)
					if (!variable) break
					variables.push(variable[1]); cursor = skip(cursor + variable[0].length)
					if (input[cursor] !== "/") break
					cursor = skip(cursor + 1)
				}
				let options = ""
				if (input[cursor] === "[") {
					const group = readTikzGroup(input, cursor, "[", "]")
					if (group) { options = group.content; cursor = skip(group.end) }
				}
				const keyword = input.slice(cursor).match(/^in\b/)
				if (keyword) cursor = skip(cursor + keyword[0].length)
				const list = keyword && readTikzGroup(input, cursor)
				if (list) cursor = skip(list.end)
				let body = list && readTikzGroup(input, cursor)
				if (list && !body) {
					let end = cursor, nesting = 0
					for (; end < input.length; end++) {
						if ("{[(".includes(input[end])) nesting++
						if ("}])".includes(input[end])) nesting--
						if (input[end] === ";" && nesting === 0) break
					}
					if (end < input.length) body = { content: input.slice(cursor, end + 1), end: end + 1 }
				}
				if (variables.length && list && body && !options.trim()) {
					const items = splitTikzOptions(expand(list.content, macros, depth + 1))
					const expanded: string[] = []
					for (let i = 0; i < items.length; i++) {
						if (items[i] !== "...") { expanded.push(items[i]); continue }
						const previous = evaluateTikzMath(expanded.at(-1) ?? "")
						const end = evaluateTikzMath(items[++i] ?? "")
						const before = expanded.length > 1 ? evaluateTikzMath(expanded.at(-2)) : null
						const step = before != null && previous != null ? previous - before : Math.sign((end ?? 0) - (previous ?? 0))
						if (previous == null || end == null || !step || (end - previous) / step < 0) throw Error("无法展开 \\foreach 数值范围。")
						const count = Math.floor((end - previous) / step + 1e-9)
						if (expanded.length + count > 2000) throw Error("\\foreach 范围超过 2000 项。")
						for (let n = 1; n <= count; n++) expanded.push(String(Number((previous + n * step).toPrecision(12))))
					}
					for (const item of expanded) {
						if (++iterations > 5000) throw Error("TikZ 循环展开超过 5000 次。")
						const local = new Map(macros), values = splitTikzOptions(item, "/")
						variables.forEach((variable, i) => local.set(variable, { body: values[i] ?? values.at(-1) ?? "", args: 0 }))
						result += "\\begin{scope}\n" + expand(body.content, local, depth + 1) + "\n\\end{scope}\n"
						if (result.length > 2 * 1024 * 1024) throw Error("TikZ 展开结果超过 2 MiB。")
					}
					index = body.end; continue
				}
				warn("暂不支持此 \\foreach 的选项或语法；原始源码已保留。")
			}
			const macro = macros.get(name)
			if (macro) {
				const values: string[] = []
				if (macro.optional !== undefined) {
					const value = readTikzGroup(input, cursor, "[", "]")
					values.push(value?.content ?? macro.optional)
					if (value) cursor = skip(value.end)
				}
				while (values.length < macro.args) {
					const value = readTikzGroup(input, cursor)
					if (!value) break
					values.push(value.content); cursor = skip(value.end)
				}
				if (values.length === macro.args) {
					const substituted = macro.body.replace(/#([1-9])/g, (match, n) => values[Number(n) - 1] ?? match)
					result += expand(substituted, new Map(macros), depth + 1)
					if (result.length > 2 * 1024 * 1024) throw Error("TikZ 展开结果超过 2 MiB。")
					index = macro.args ? cursor : index + command[0].length; continue
				}
				warn("宏 \\" + name + " 缺少参数，未转换。")
			}
			result += command[0]; index += command[0].length
			if ((emitted += command[0].length) > 2 * 1024 * 1024 || result.length > 2 * 1024 * 1024) throw Error("TikZ 展开结果超过 2 MiB。")
		}
		if (result.length > 2 * 1024 * 1024) throw Error("TikZ 展开结果超过 2 MiB。")
		return result
	}
	return { source: expand(source, new Map()), warnings }
}
