/** A bounded PGF math subset. Compiles expressions without JavaScript eval or TeX execution. */
type Variables = Record<string, number>
export type TikzMathEvaluator = (variables?: Variables) => number | null
type Expression = (variables: Variables) => number
const degrees = Math.PI / 180
const functions: Record<string, { min: number; max: number; run: (...args: number[]) => number }> = {
	sin: { min: 1, max: 1, run: (x) => Math.sin(x * degrees) },
	cos: { min: 1, max: 1, run: (x) => Math.cos(x * degrees) },
	tan: { min: 1, max: 1, run: (x) => Math.tan(x * degrees) },
	asin: { min: 1, max: 1, run: (x) => Math.asin(x) / degrees },
	acos: { min: 1, max: 1, run: (x) => Math.acos(x) / degrees },
	atan: { min: 1, max: 1, run: (x) => Math.atan(x) / degrees },
	atan2: { min: 2, max: 2, run: (y, x) => Math.atan2(y, x) / degrees },
	sqrt: { min: 1, max: 1, run: Math.sqrt },
	abs: { min: 1, max: 1, run: Math.abs },
	exp: { min: 1, max: 1, run: Math.exp },
	ln: { min: 1, max: 1, run: Math.log },
	log10: { min: 1, max: 1, run: Math.log10 },
	floor: { min: 1, max: 1, run: Math.floor },
	ceil: { min: 1, max: 1, run: Math.ceil },
	round: { min: 1, max: 1, run: (x) => Math.sign(x) * Math.floor(Math.abs(x) + 0.5) },
	int: { min: 1, max: 1, run: Math.trunc },
	min: { min: 1, max: 100, run: Math.min },
	max: { min: 1, max: 100, run: Math.max },
	mod: { min: 2, max: 2, run: (x, y) => x % y },
	pow: { min: 2, max: 2, run: Math.pow },
	deg: { min: 1, max: 1, run: (x) => x / degrees },
	rad: { min: 1, max: 1, run: (x) => x * degrees },
}
const operators: Record<string, { rank: number; run: (left: number, right: number) => number }> = {
	"||": { rank: 1, run: (a, b) => Number(!!a || !!b) },
	"&&": { rank: 2, run: (a, b) => Number(!!a && !!b) },
	"==": { rank: 3, run: (a, b) => Number(a === b) },
	"!=": { rank: 3, run: (a, b) => Number(a !== b) },
	"<": { rank: 3, run: (a, b) => Number(a < b) },
	">": { rank: 3, run: (a, b) => Number(a > b) },
	"<=": { rank: 3, run: (a, b) => Number(a <= b) },
	">=": { rank: 3, run: (a, b) => Number(a >= b) },
	"+": { rank: 4, run: (a, b) => a + b },
	"-": { rank: 4, run: (a, b) => a - b },
	"*": { rank: 5, run: (a, b) => a * b },
	"/": { rank: 5, run: (a, b) => a / b },
	"%": { rank: 5, run: (a, b) => a % b },
	"^": { rank: 7, run: Math.pow },
}

/** Compile once, then evaluate with fresh variables for every sample. Invalid syntax returns null. */
export function compileTikzMath(expression: string): TikzMathEvaluator | null {
	if (typeof expression !== "string" || expression.length > 12000) return null
	const source = expression.replace(/[{}]/g, (char) => (char === "{" ? "(" : ")"))
	const pattern =
		/\s*(?:(\d+(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)|(\\?[A-Za-z][A-Za-z0-9_]*)|(==|!=|<=|>=|&&|\|\||[+*/^%<>=!?:(),-]))/y
	const tokens: string[] = []
	let cursor = 0
	while (cursor < source.length) {
		pattern.lastIndex = cursor
		const match = pattern.exec(source)
		if (!match) {
			if (!source.slice(cursor).trim()) break
			return null
		}
		tokens.push(match[1] ?? match[2] ?? match[3])
		cursor = pattern.lastIndex
		if (tokens.length > 2000) return null
	}
	let index = 0
	const names = new Set<string>()
	function parse(minimum = 0, depth = 0): Expression {
		if (depth > 64) throw Error("Expression too deeply nested")
		const token = tokens[index++]
		let left: Expression
		if (token === "+" || token === "-" || token === "!") {
			const value = parse(6, depth + 1)
			left =
				token === "-" ? (vars) => -value(vars)
				: token === "!" ? (vars) => Number(!value(vars))
				: value
		} else if (token === "(") {
			left = parse(0, depth + 1)
			if (tokens[index++] !== ")") throw Error("Missing closing parenthesis")
		} else if (token && /^(?:\d|\.)/.test(token)) {
			const value = Number(token)
			left = () => value
		} else if (token && tokens[index] === "(") {
			const fn = Object.hasOwn(functions, token) ? functions[token] : null
			if (!fn) throw Error("Unsupported function")
			index++
			const args: Expression[] = []
			if (tokens[index] !== ")")
				do {
					args.push(parse(0, depth + 1))
					if (tokens[index] !== ",") break
					index++
				} while (args.length < 101)
			if (tokens[index++] !== ")" || args.length < fn.min || args.length > fn.max)
				throw Error("Invalid function arguments")
			left =
				args.length === 1 ? (vars) => fn.run(args[0](vars)) : (vars) => fn.run(...args.map((arg) => arg(vars)))
		} else if (token === "pi") left = () => Math.PI
		else if (token === "e") left = () => Math.E
		else if (token === "true" || token === "false") {
			const value = Number(token === "true")
			left = () => value
		} else {
			if (!token) throw Error("Missing expression")
			const name = token.replace(/^\\/, "")
			names.add(name)
			left = (vars) => vars[name]
		}
		while (index < tokens.length) {
			const op = tokens[index]
			if (op === "?" && minimum === 0) {
				index++
				const condition = left,
					yes = parse(0, depth + 1)
				if (tokens[index++] !== ":") throw Error("Missing conditional branch")
				const no = parse(0, depth + 1)
				left = (vars) => (condition(vars) ? yes(vars) : no(vars))
				continue
			}
			const operator = Object.hasOwn(operators, op) ? operators[op] : null
			if (!operator || operator.rank < minimum) break
			index++
			const previous = left,
				right = parse(op === "^" ? operator.rank : operator.rank + 1, depth + 1)
			left = (vars) => operator.run(previous(vars), right(vars))
		}
		return left
	}
	try {
		const evaluate = parse()
		if (index !== tokens.length) return null
		const required = [...names]
		return (variables = {}) => {
			if (required.some((name) => !Object.hasOwn(variables, name) || !Number.isFinite(variables[name])))
				return null
			try {
				const value = evaluate(variables)
				return Number.isFinite(value) ? value : null
			} catch {
				return null
			}
		}
	} catch {
		return null
	}
}

// Bound both entry count and retained source size; cached evaluators never capture variable values.
const cache = new Map<string, TikzMathEvaluator | null>()
let cacheCharacters = 0
export function evaluateTikzMath(expression: string, variables: Variables = {}): number | null {
	if (typeof expression !== "string" || expression.length > 12000) return null
	let evaluate = cache.get(expression)
	if (evaluate === undefined) {
		evaluate = compileTikzMath(expression)
		while (cache.size >= 128 || cacheCharacters + expression.length > 128 * 1024) {
			const oldest = cache.keys().next().value
			cacheCharacters -= oldest.length
			cache.delete(oldest)
		}
		cache.set(expression, evaluate)
		cacheCharacters += expression.length
	} else {
		cache.delete(expression)
		cache.set(expression, evaluate)
	}
	return evaluate?.(variables) ?? null
}

export function readTikzGroup(
	source: string,
	start: number,
	open = "{",
	close = "}"
): { content: string; end: number } | null {
	if (source[start] !== open) return null
	let depth = 0,
		braces = 0
	for (let i = start; i < source.length; i++) {
		if (source[i] === "\\" && /[{}\[\]%\\]/.test(source[i + 1] ?? "")) {
			i++
			continue
		}
		if (open !== "{") {
			if (source[i] === "{") braces++
			if (source[i] === "}") braces--
			if (braces > 0) continue
		}
		if (source[i] === open) depth++
		if (source[i] === close && --depth === 0) return { content: source.slice(start + 1, i), end: i + 1 }
	}
	return null
}

export function splitTikzOptions(source: string, delimiter = ","): string[] {
	const result: string[] = []
	let depth = 0,
		start = 0
	for (let i = 0; i < source.length; i++) {
		if (source[i] === "\\" && /[{}\[\]%\\]/.test(source[i + 1] ?? "")) {
			i++
			continue
		}
		if ("{[(".includes(source[i])) depth++
		else if ("}])".includes(source[i])) depth--
		else if (source[i] === delimiter && depth === 0) {
			result.push(source.slice(start, i).trim())
			start = i + 1
		}
	}
	if (source.slice(start).trim()) result.push(source.slice(start).trim())
	return result
}
