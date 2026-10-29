import { readTikzGroup, splitTikzOptions } from "./tikzMath"

export class TikzStyles {
	private definitions: Map<string, string>
	constructor(parent?: TikzStyles) {
		this.definitions = new Map(parent?.definitions)
	}
	define(source: string) {
		for (const option of splitTikzOptions(source)) {
			const match = option.match(/^(.+?)\/\.(style|append style)\s*=\s*([\s\S]*)$/)
			if (!match) continue
			const group = readTikzGroup(match[3], 0)
			if (!group || group.end !== match[3].length) continue
			const name = match[1].trim()
			this.definitions.set(
				name,
				match[2] === "append style" && this.definitions.has(name) ?
					this.definitions.get(name) + "," + group.content
				:	group.content
			)
		}
	}
	expand(options: string[], depth = 0, budget = { tokens: 0, characters: 0 }): string[] {
		if (depth > 20) throw Error("TikZ 样式存在循环引用或嵌套超过 20 层。")
		return options.flatMap((option) => {
			budget.characters += option.length
			if (++budget.tokens > 10000 || budget.characters > 2 * 1024 * 1024)
				throw Error("TikZ 样式展开超过 10000 项或 2 MiB。")
			const equals = option.indexOf("=")
			const name = (equals < 0 ? option : option.slice(0, equals)).trim()
			const definition = this.definitions.get(name)
			if (definition == null) return [option]
			const value =
				equals < 0 ? "" : (
					option
						.slice(equals + 1)
						.trim()
						.replace(/^\{([\s\S]*)\}$/, "$1")
				)
			return this.expand(splitTikzOptions(definition.replace(/#1/g, () => value)), depth + 1, budget)
		})
	}
}
