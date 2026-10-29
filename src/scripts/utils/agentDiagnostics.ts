import { CanvasController, CircuitComponent, GroupComponent } from "../internal"
import { agentTree, legs, physicalPins } from "./agentEditing"

type Point = { x: number; y: number }
type Pin = { key: string; name: string; point: Point }
type Part = { id: string; parentIds: string[]; type: string; symbol: string; label: string; pins: Pin[]; legs: [Point, Point][]; body: Point[]; bounds: Box }
type Box = { x: number; y: number; width: number; height: number }
export type LayoutRelation = { key: string; kind: string; ids: string[]; components?: object[]; point: Point; pins?: object[]; areas?: Point[][]; segments?: [Point, Point][]; geometryTruncated?: boolean; confidence?: string }
export type LayoutSnapshot = { connections: LayoutRelation[]; overlaps: LayoutRelation[]; crossings: LayoutRelation[]; coverage: { complete: boolean; components: number; pairsChecked: number; segmentPairsChecked: number; skippedBodyIds: string[]; reason?: string }; tolerancePx: number }
export type DiagnosticMarker = { kind: string; point: Point; ids: string[]; areas?: Point[][]; segments?: [Point, Point][] }
const xy = (p: Point): Point => ({ x: p.x, y: p.y })
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (p: Point, t: number): Point => ({ x: p.x * t, y: p.y * t })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const cross = (a: Point, b: Point) => a.x * b.y - a.y * b.x
const length = (p: Point) => Math.hypot(p.x, p.y)
const distance = (a: Point, b: Point) => length(sub(a, b))
const middle = (a: Point, b: Point) => mul(add(a, b), .5)
const center = (points: Point[]) => mul(points.reduce(add, { x: 0, y: 0 }), 1 / points.length)
function bounds(points: Point[]): Box {
	const xs = points.map(p => p.x), ys = points.map(p => p.y)
	return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }
}
const boxesMeet = (a: Box, b: Box, t: number) => a.x <= b.x + b.width + t && b.x <= a.x + a.width + t && a.y <= b.y + b.height + t && b.y <= a.y + a.height + t
function onSegment(p: Point, a: Point, b: Point, tolerance: number) {
	const d = sub(b, a), l = length(d)
	if (!l) return distance(p, a) <= tolerance
	const t = dot(sub(p, a), d) / (l * l)
	return t >= 0 && t <= 1 && distance(p, add(a, mul(d, t))) <= tolerance
}
const orientation = (poly: Point[]) => Math.sign(poly.reduce((sum, p, i) => sum + cross(p, poly[(i + 1) % poly.length]), 0)) || 1

/** Convex oriented body rectangles, without expanding for labels or SVG hit areas. */
function bodyPolygon(component: CircuitComponent): Point[] {
	const element = component.componentVisualization?.node as SVGGraphicsElement
	if (!element?.getBBox || !element.getCTM()) throw new Error("No rendered body transform")
	const box = element.getBBox(), root = CanvasController.instance.canvas.node.getCTM()
	if (!root) throw new Error("No canvas transform")
	const matrix = root.inverse().multiply(element.getCTM())
	return [{ x: box.x, y: box.y }, { x: box.x + box.width, y: box.y }, { x: box.x + box.width, y: box.y + box.height }, { x: box.x, y: box.y + box.height }]
		.map(p => ({ x: matrix.a * p.x + matrix.c * p.y + matrix.e, y: matrix.b * p.x + matrix.d * p.y + matrix.f }))
}
function polygonOverlap(a: Point[], b: Point[], tolerance: number): Point[] {
	if (!a.length || !b.length) return []
	for (const poly of [a, b]) for (let i = 0; i < poly.length; i++) {
		const d = sub(poly[(i + 1) % poly.length], poly[i]), size = length(d)
		if (!size) return []
		const axis = { x: -d.y / size, y: d.x / size }, pa = a.map(p => dot(p, axis)), pb = b.map(p => dot(p, axis))
		if (Math.min(Math.max(...pa), Math.max(...pb)) - Math.max(Math.min(...pa), Math.min(...pb)) <= tolerance) return []
	}
	let result = a.slice(), sign = orientation(b)
	for (let i = 0; i < b.length && result.length; i++) {
		const p = b[i], edge = sub(b[(i + 1) % b.length], p), previous = result; result = []
		for (let j = 0; j < previous.length; j++) {
			const from = previous[j], to = previous[(j + 1) % previous.length]
			const f = sign * cross(edge, sub(from, p)), t = sign * cross(edge, sub(to, p))
			if (f >= 0) result.push(from)
			if ((f >= 0) !== (t >= 0)) result.push(add(from, mul(sub(to, from), f / (f - t))))
		}
	}
	return result
}
function clipToBody(a: Point, b: Point, body: Point[], tolerance: number): [Point, Point] | null {
	let low = 0, high = 1
	const d = sub(b, a), sign = orientation(body)
	for (let i = 0; i < body.length; i++) {
		const edge = sub(body[(i + 1) % body.length], body[i])
		const f = sign * cross(edge, sub(a, body[i])) - tolerance * length(edge), delta = sign * cross(edge, d)
		if (Math.abs(delta) < 1e-12) { if (f < 0) return null; continue }
		const t = -f / delta
		if (delta > 0) low = Math.max(low, t); else high = Math.min(high, t)
		if (high <= low) return null
	}
	return (high - low) * length(d) > tolerance ? [add(a, mul(d, low)), add(a, mul(d, high))] : null
}

/** Centerline tests: positive-length collinear overlap versus a point intersection. */
export function segmentRelation(a: Point, b: Point, c: Point, d: Point, tolerance: number): { kind: string; point: Point; segment?: [Point, Point] } | null {
	const u = sub(b, a), v = sub(d, c), lu = length(u), lv = length(v)
	if (lu <= tolerance || lv <= tolerance) return null
	const denominator = cross(u, v)
	if (Math.abs(denominator) <= 1e-10 * lu * lv) {
		if (Math.abs(cross(u, sub(c, a))) / lu > tolerance || Math.abs(cross(u, sub(d, a))) / lu > tolerance) return null
		const t1 = dot(sub(c, a), u) / (lu * lu), t2 = dot(sub(d, a), u) / (lu * lu)
		const lo = Math.max(0, Math.min(t1, t2)), hi = Math.min(1, Math.max(t1, t2))
		if ((hi - lo) * lu <= tolerance) return null // Merely meeting endpoints is normal contact.
		const segment: [Point, Point] = [add(a, mul(u, lo)), add(a, mul(u, hi))]
		return { kind: "wire-overlap", point: middle(...segment), segment }
	}
	const w = sub(c, a), t = cross(w, v) / denominator, s = cross(w, u) / denominator
	if (t < 0 || t > 1 || s < 0 || s > 1) return null
	return { kind: "wire-crossing", point: add(a, mul(u, t)) }
}

export function captureLayout(components: CircuitComponent[], tolerance = .05, ids?: string[]): LayoutSnapshot {
	const coverage: LayoutSnapshot["coverage"] = { complete: true, components: 0, pairsChecked: 0, segmentPairsChecked: 0, skippedBodyIds: [] }
	const parts: Part[] = agentTree(components).filter(e => !(e.component instanceof GroupComponent)).map(({ component, parentIds }) => {
		const save: any = component.toJson(), id = component.automationId
		const sourcePins = ["open", "arc"].includes(save.type) ? [] : physicalPins(component)
		const pins = sourcePins.map((p, index) => ({ key: JSON.stringify([id, p.name != null && sourcePins.filter(other => other.name === p.name).length === 1 ? ["name", p.name] : ["index", index]]), name: String(p.name ?? index), point: xy(p.point) }))
		const paths = legs(component).map(([a, b]) => [xy(a), xy(b)] as [Point, Point])
		let body: Point[] = []
		if (!["wire", "short", "open", "simpleText", "arc"].includes(save.type)) {
			try { body = bodyPolygon(component); if (!body.every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) throw new Error("Invalid body bounds") }
			catch { coverage.skippedBodyIds.push(id) }
		}
		const all = [...body, ...pins.map(p => p.point), ...paths.flat()]
		return { id, parentIds, type: save.type, symbol: save.id ?? "", label: save.label?.value ?? "", pins, legs: paths, body, bounds: bounds(all.length ? all : [xy(component.position)]) }
	})
	coverage.components = parts.length
	const junctions = parts.filter(part => ["circ", "ocirc", "diamondpole", "odiamondpole"].includes(part.symbol)).flatMap(part => part.pins)
	const selected = ids ? new Set(ids) : null
	const connections = new Map<string, LayoutRelation>(), overlaps = new Map<string, LayoutRelation>(), crossings = new Map<string, LayoutRelation>()
	const relation = (kind: string, a: Part, b: Part, point: Point, extras: Partial<LayoutRelation> = {}): LayoutRelation => ({ key: JSON.stringify([kind, ...[a.id, b.id].sort()]), kind, ids: [a.id, b.id].sort(), components: [a, b].map(part => ({ id: part.id, type: part.type, symbol: part.symbol, label: part.label, parentIds: part.parentIds })), point: xy(point), ...extras })
	const terminal = (p: Part, pin: Pin) => ({ id: p.id, pin: pin.name, pinKey: pin.key, point: pin.point })
	const put = (map: Map<string, LayoutRelation>, value: LayoutRelation) => {
		const previous = map.get(value.key)
		if (previous && value.segments) {
			if ((previous.segments?.length ?? 0) < 100) previous.segments.push(...value.segments)
			else previous.geometryTruncated = true
		} else if (!previous) map.set(value.key, value)
	}
	outer: for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) {
		const a = parts[i], b = parts[j]
		if (selected && ![a.id, b.id, ...a.parentIds, ...b.parentIds].some(id => selected.has(id))) continue
		if (++coverage.pairsChecked > 100000 || connections.size + overlaps.size + crossings.size > 20000) { coverage.complete = false; coverage.reason = "Analysis budget reached; narrow the check to explicit ids."; break outer }
		if (!boxesMeet(a.bounds, b.bounds, tolerance)) continue
		for (const pa of a.pins) for (const pb of b.pins) if (distance(pa.point, pb.point) <= tolerance) {
			const keys = [pa.key, pb.key].sort()
			put(connections, relation("pin-contact", a, b, middle(pa.point, pb.point), { key: JSON.stringify(["pin-contact", ...keys]), pins: [terminal(a, pa), terminal(b, pb)] }))
		}
		for (const [owner, wire] of [[a, b], [b, a]]) for (const pin of owner.pins) {
			if (wire.pins.some(p => distance(p.point, pin.point) <= tolerance)) continue
			if (wire.legs.some(([from, to]) => onSegment(pin.point, from, to, tolerance)))
				put(connections, relation("pin-wire-interior", owner, wire, pin.point, { key: JSON.stringify(["pin-wire-interior", pin.key, wire.id]), pins: [terminal(owner, pin)] }))
		}
		const area = polygonOverlap(a.body, b.body, tolerance)
		if (area.length) put(overlaps, relation("component-bounds-overlap", a, b, center(area), { areas: [area], confidence: "potential: oriented body bounds, not exact symbol contours" }))
		for (const [wire, body] of [[a, b], [b, a]]) if (wire.legs.length && body.body.length && !["circ", "ocirc", "diamondpole", "odiamondpole"].includes(body.symbol)) {
			for (const [from, to] of wire.legs) {
				const clipped = clipToBody(from, to, body.body, tolerance)
				if (clipped) put(overlaps, relation("wire-component-overlap", wire, body, middle(...clipped), { segments: [clipped], confidence: "potential: wire centerline inside oriented body bounds" }))
			}
		}
		for (const [a1, a2] of a.legs) for (const [b1, b2] of b.legs) {
			if (++coverage.segmentPairsChecked > 2000000) { coverage.complete = false; coverage.reason = "Segment analysis budget reached; narrow the check to explicit ids."; break outer }
			const hit = segmentRelation(a1, a2, b1, b2, tolerance)
			if (!hit) continue
			if (hit.kind === "wire-overlap") put(overlaps, relation(hit.kind, a, b, hit.point, { segments: [hit.segment], confidence: "collinear wire centerlines overlap" }))
			else if (![...a.pins, ...b.pins, ...junctions].some(pin => distance(pin.point, hit.point) <= tolerance))
				put(crossings, relation(hit.kind, a, b, hit.point, { confidence: "ambiguous: a crossing is not automatically an electrical junction" }))
		}
	}
	if (coverage.skippedBodyIds.length) { coverage.complete = false; coverage.reason ??= "Some body bounds could not be read; overlap absence is not conclusive." }
	return { connections: [...connections.values()], overlaps: [...overlaps.values()], crossings: [...crossings.values()], coverage, tolerancePx: tolerance }
}

export function layoutReport(snapshot: LayoutSnapshot, limit = 200) {
	const bounded = (items: LayoutRelation[]) => ({ total: items.length, items: items.slice(0, limit), truncated: items.length > limit })
	return { connections: bounded(snapshot.connections), overlaps: bounded(snapshot.overlaps), crossings: bounded(snapshot.crossings), coverage: snapshot.coverage, tolerancePx: snapshot.tolerancePx,
		note: "Geometric diagnostics only. Body overlap uses oriented bounds excluding labels, so verify potential overlaps visually. Wire crossings do not imply a short circuit. Junction dots touching wires are normal." }
}
export function compareLayouts(before: LayoutSnapshot, after: LayoutSnapshot, limit = 200) {
	if (!before.coverage.complete || !after.coverage.complete) return { complete: false, before: before.coverage, after: after.coverage, note: "Incomplete scan: added/removed relationships are withheld rather than inferred from missing results." }
	const diff = (oldItems: LayoutRelation[], newItems: LayoutRelation[]) => {
		const oldMap = new Map(oldItems.map(item => [item.key, item])), newMap = new Map(newItems.map(item => [item.key, item]))
		const added = newItems.filter(item => !oldMap.has(item.key)), removed = oldItems.filter(item => !newMap.has(item.key)), preserved = newItems.filter(item => oldMap.has(item.key)).map(item => ({ before: oldMap.get(item.key), after: item }))
		return { counts: { preserved: preserved.length, removed: removed.length, added: added.length }, preserved: preserved.slice(0, limit), removed: removed.slice(0, limit), added: added.slice(0, limit), truncated: preserved.length > limit || removed.length > limit || added.length > limit }
	}
	return { complete: true, connections: diff(before.connections, after.connections), overlaps: diff(before.overlaps, after.overlaps), crossings: diff(before.crossings, after.crossings), before: before.coverage, after: after.coverage,
		note: "Relationships are matched by stable component/pin ids, not coordinates. Added/removed are observations, not approval decisions or electrical equivalence checks." }
}
export function changeMarkers(diff: ReturnType<typeof compareLayouts>): DiagnosticMarker[] {
	if (!diff.complete) return []
	const markers = (items: LayoutRelation[], kind: string) => items.map(item => ({ kind, point: item.point, ids: item.ids, areas: item.areas, segments: item.segments }))
	return [...markers(diff.connections.removed, "connection-removed"), ...markers(diff.connections.added, "connection-added"), ...markers(diff.overlaps.added, "overlap-added"), ...markers(diff.crossings.added, "crossing-added")]
}
