import * as SVG from "@svgdotjs/svg.js"
import { BezierComponent, CircuitComponent, EllipseComponent, GroupComponent, NodeSymbolComponent, PathComponent, ShapeComponent, WireComponent } from "../internal"

const tolerance = 1e-4

/** Inspect connection/control points, not visual bounds or label outlines. Never edits geometry. */
export function checkComponentsOnGrid(components: CircuitComponent[], spacing: number, epsilon = tolerance, limit = 200) {
	if (!Number.isFinite(spacing) || spacing <= 0) throw new Error("网格间距必须为正数。")
	if (!Number.isFinite(epsilon) || epsilon < 0 || epsilon > spacing / 2) throw new Error("Tolerance must be between zero and half the grid spacing.")
	let checkedComponents = 0, checkedPoints = 0, misalignedPoints = 0, misalignedComponents = 0
	const issues: object[] = []
	const visit = (component: CircuitComponent, ancestors: string[]) => {
		if (component instanceof GroupComponent) {
			component.groupedComponents.forEach(child => visit(child, [...ancestors, component.automationId]))
			return
		}
		checkedComponents++
		const kind = component instanceof PathComponent ? "reference" : component instanceof NodeSymbolComponent && component.snappingPoints.length ? "pin" : "position"
		const points = kind === "reference" ? (component as PathComponent).getReferencePoints() : kind === "pin" ? component.snappingPoints : [component.position]
		let offGrid = false
		points.forEach((point, index) => {
			checkedPoints++
			const nearest = { x: Math.round(point.x / spacing) * spacing, y: Math.round(point.y / spacing) * spacing }
			const delta = { x: nearest.x - point.x, y: nearest.y - point.y }
			if (Math.abs(delta.x) <= epsilon && Math.abs(delta.y) <= epsilon) return
			offGrid = true
			misalignedPoints++
			if (issues.length < limit) issues.push({ componentId: component.automationId, ancestors, displayName: component.displayName, kind, index,
				...(kind === "pin" ? { name: component.snappingPoints[index].name } : {}),
				point: { x: point.x, y: point.y }, nearest, delta })
		})
		if (offGrid) misalignedComponents++
	}
	components.forEach(component => visit(component, []))
	return { allAligned: misalignedPoints === 0, spacingPx: spacing, tolerancePx: epsilon, origin: { x: 0, y: 0 },
		checkedComponents, checkedPoints, misalignedComponents, misalignedPoints, issues, truncated: misalignedPoints > issues.length }
}

/** One mapping per axis keeps shared endpoints and horizontal/vertical wires together.
 * Preserve crowded coordinates rather than merging distinct junctions onto one grid line.
 */
export function gridAxis(values: number[], fixed: number[], spacing: number): (value: number) => number {
	if (!Number.isFinite(spacing) || spacing <= 0) throw new Error("网格间距必须为正数。")
	const sorted = [...values, ...fixed].filter(Number.isFinite).sort((a, b) => a - b)
	const coordinates = sorted.filter((value, index) => index == 0 || value - sorted[index - 1] > tolerance)
	const targets = coordinates.map((value) =>
		fixed.some((pin) => Math.abs(pin - value) <= tolerance) ? value : Math.round(value / spacing) * spacing
	)
	let changed: boolean
	do {
		changed = false
		for (let index = 1; index < coordinates.length; index++) {
			if (targets[index] - targets[index - 1] > tolerance) continue
			for (const neighbour of [index - 1, index]) {
				if (targets[neighbour] != coordinates[neighbour]) {
					targets[neighbour] = coordinates[neighbour]
					changed = true
				}
			}
		}
	} while (changed)
	return (value) => {
		const index = coordinates.findIndex((coordinate) => Math.abs(coordinate - value) <= tolerance)
		return index < 0 ? value : targets[index]
	}
}

/** Multi-pin symbols keep their geometry; their pin axes constrain connected wires. */
export function alignComponentsToGrid(components: CircuitComponent[], spacing: number): void {
	const points: SVG.Point[] = []
	const fixed: SVG.Point[] = []
	const rigid = new Set<CircuitComponent>()
	const boundaryContacts = new Map<CircuitComponent, SVG.Point[]>()
	const pathPoints = components.flatMap((component) =>
		component instanceof PathComponent ? component.getReferencePoints() : []
	)
	for (const component of components) {
		component.recalculateSnappingPoints()
		if (component instanceof PathComponent) {
			points.push(...component.getReferencePoints())
			if ((component instanceof WireComponent && component.preserveGeometry) || component instanceof BezierComponent) rigid.add(component)
		} else if (component instanceof NodeSymbolComponent) {
			points.push(...component.snappingPoints, component.position)
			if (component.snappingPoints.length > 1) rigid.add(component)
		} else {
			points.push(component.position)
			// A box boundary can be a real connection (for example a two-port network).
			// Named TikZ shapes are clipped at arbitrary boundary angles, not
			// just the eight compass snapping points. Keep those contacts rigid.
			let contacts: SVG.Point[] = []
			if (component instanceof ShapeComponent) {
				const save = component.toJson()
				const half = new SVG.Point(save.size).div(2)
				const inverse = component.getTransformMatrix().inverse()
				const stroke = save.stroke?.width
				const edgeTolerance = (stroke ? new SVG.Number(stroke.value, stroke.unit).convertToUnit("px").value : 0) + tolerance
				contacts = pathPoints.filter(point => {
					const relative = point.transform(inverse).sub(half)
					if (component instanceof EllipseComponent) {
						if (half.x <= 0 || half.y <= 0) return false
						const radius = Math.hypot(relative.x / half.x, relative.y / half.y)
						return Math.abs(radius - 1) * Math.max(half.x, half.y) <= edgeTolerance
					}
					return Math.abs(relative.x) <= half.x + edgeTolerance && Math.abs(relative.y) <= half.y + edgeTolerance &&
						Math.min(Math.abs(Math.abs(relative.x) - half.x), Math.abs(Math.abs(relative.y) - half.y)) <= edgeTolerance
				})
			}
			boundaryContacts.set(component, contacts)
			if (component.snappingPoints.some((pin) => pathPoints.some((point) => pin.sub(point).abs() <= tolerance)) ||
				contacts.length)
				rigid.add(component)
		}
		if (rigid.has(component)) {
			fixed.push(...component.snappingPoints, component.position)
			if (component instanceof PathComponent) fixed.push(...component.getReferencePoints())
			// Freeze contact axes as well; a clipped circle point need not be
			// one of the shape's compass anchors.
			fixed.push(...(boundaryContacts.get(component) ?? []))
		}
	}
	const mapX = gridAxis(
		points.map((point) => point.x),
		fixed.map((point) => point.x),
		spacing
	)
	const mapY = gridAxis(
		points.map((point) => point.y),
		fixed.map((point) => point.y),
		spacing
	)
	const mapPoint = (point: SVG.Point) => new SVG.Point(mapX(point.x), mapY(point.y))
	for (const component of components) {
		if (rigid.has(component)) continue
		if (component instanceof PathComponent) {
			component.mapReferencePoints(mapPoint)
		} else if (component instanceof NodeSymbolComponent) {
			const anchor = component.snappingPoints[0] ?? component.position
			component.moveRel(mapPoint(anchor).sub(anchor))
		} else {
			component.moveTo(mapPoint(component.position))
		}
		component.recalculateSnappingPoints()
	}
}
