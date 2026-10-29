export type TikzSourceDocument = {
	version: 1
	source: string
	preamble: string
	mode: "tikz" | "circuitikz"
	importWarnings: string[]
	baseline?: string
	settingsBaseline?: string
	sourceOnly?: boolean
}

/** Selection and automation IDs are not drawing edits. Stable across JSON round trips. */
export function sceneSignature(components: unknown[]): string {
	const canonical = (value: any): any => {
		if (Array.isArray(value)) return value.map(canonical)
		if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().filter(key => !["automationId", "selected"].includes(key)).map(key => [key, canonical(value[key])]))
		return value
	}
	const text = JSON.stringify(canonical(components))
	// Store the canonical representation, not a collision-prone edit detector.
	return text
}

export function validateSourceDocument(value: unknown): TikzSourceDocument | undefined {
	if (value == null) return undefined
	const doc = value as TikzSourceDocument
	if (doc.version !== 1 || typeof doc.source !== "string" || doc.source.length > 1024 * 1024 || typeof doc.preamble !== "string" || doc.preamble.length > 128 * 1024 ||
		!["tikz", "circuitikz"].includes(doc.mode) || !Array.isArray(doc.importWarnings) || !doc.importWarnings.every(w => typeof w === "string") ||
		(doc.sourceOnly != null && typeof doc.sourceOnly !== "boolean") ||
		(doc.baseline != null && (typeof doc.baseline !== "string" || doc.baseline.length > 8 * 1024 * 1024)) ||
		(doc.settingsBaseline != null && typeof doc.settingsBaseline !== "string")) throw Error("Invalid saved TikZ source document.")
	return structuredClone(doc)
}
