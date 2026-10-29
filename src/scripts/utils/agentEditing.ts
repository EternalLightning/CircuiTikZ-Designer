import * as SVG from "@svgdotjs/svg.js"
import {
	CircuitComponent, MainController, GroupComponent, PathComponent, NodeSymbolComponent,
	ChoiceProperty, RadioButtonProperty, TextProperty, TextAreaProperty, MathJaxProperty,
	BooleanProperty, ColorProperty, SliderProperty, EditableProperty,
} from "../internal"

const pxPerCm = 96 / 2.54
const contactTolerance = 0.05 // SVG px; accommodates serialized coordinate rounding.
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
export function agentPoint(value: { x: number; y: number }, unit = "cm") {
	if (!value || !Number.isFinite(value.x) || !Number.isFinite(value.y)) throw new Error("Expected a finite {x,y} point.")
	if (unit !== "px" && unit !== "cm") throw new Error("Unit must be cm or px.")
	return new SVG.Point(value.x * (unit === "cm" ? pxPerCm : 1), value.y * (unit === "cm" ? -pxPerCm : 1))
}

export function agentTree(components: CircuitComponent[], parentIds: string[] = []): { component: CircuitComponent; parentIds: string[] }[] {
	return components.flatMap(component => [{ component, parentIds }, ...(component instanceof GroupComponent ? agentTree(component.groupedComponents, [...parentIds, component.automationId]) : [])])
}

function propertyInfo(property: EditableProperty<any>) {
	if (!property.id) return null
	let type: string, value: any, options: any = {}
	if (property instanceof ChoiceProperty || property instanceof RadioButtonProperty) {
		type = "choice"; value = property.value?.key
		options.choices = (property instanceof ChoiceProperty ? property.entries : property.options).map(choice => ({ key: choice.key, name: choice.name }))
	} else if (property instanceof SliderProperty) {
		type = "number"; value = property.value.value; options = property.automationRange
	} else if (property instanceof BooleanProperty) {
		type = "boolean"; value = property.value; options.nullable = property.allowsNull
	} else if (property instanceof ColorProperty) {
		type = "color"; value = property.value?.toHex() ?? null; options.nullable = property.allowsNull
	} else if (property instanceof TextProperty || property instanceof TextAreaProperty || property instanceof MathJaxProperty) {
		type = "string"; value = property.value ?? ""
	} else return null // Buttons, headers and informational fields are not edit commands.
	const element = property.getHTMLElement()
	return { id: property.id, label: element.querySelector(".input-group-text")?.textContent?.trim() || property.id,
		type, value, disabled: !!property.disabled, ...options }
}

export function editableProperties(component: CircuitComponent) {
	return component.properties.sorted().map(propertyInfo).filter(Boolean)
}

function setProperties(component: CircuitComponent, values: Record<string, unknown>) {
	if (!values || !Object.keys(values).length) throw new Error("Supply at least one property id and value from get_component.")
	for (const [id, value] of Object.entries(values)) {
		// Some option changes rebuild the property collection, so resolve each id afresh.
		const property = component.properties.sorted().find(property => property.id === id && propertyInfo(property))
		if (!property) throw new Error(`Unknown editable property: ${id}. Read designer_get_component.`)
		if (property.disabled) throw new Error(`Property is disabled: ${id}`)
		let next: any
		if (property instanceof ChoiceProperty || property instanceof RadioButtonProperty) {
			const entries = property instanceof ChoiceProperty ? property.entries : property.options
			next = entries.find(entry => entry.key === value)
			if (!next) throw new Error(`Invalid choice for ${id}; use a returned choice key.`)
		} else if (property instanceof SliderProperty) {
			const range = property.automationRange
			if (typeof value !== "number" || !Number.isFinite(value) || (range.restricted && (value < range.min || value > range.max)))
				throw new Error(`Invalid number or out of range for ${id}.`)
			next = new SVG.Number(value, range.unit)
		} else if (property instanceof BooleanProperty) {
			if (typeof value !== "boolean" && !(value === null && property.allowsNull)) throw new Error(`Expected boolean for ${id}.`)
			next = value
		} else if (property instanceof ColorProperty) {
			if (value === null && property.allowsNull) next = null
			else {
				if (typeof value !== "string" || !/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`Expected #RRGGBB for ${id}.`)
				next = new SVG.Color(value)
			}
		} else {
			if (typeof value !== "string" || value.length > 65536) throw new Error(`Expected a string for ${id}.`)
			if (property instanceof TextProperty) {
				const error = property.validateInput(value)
				if (error) throw new Error(`${id}: ${error}`)
			}
			next = value
		}
		property.updateValue(next, true, true)
	}
}

export function componentPins(component: CircuitComponent) {
	component.recalculateSnappingPoints()
	if (component instanceof GroupComponent) return component.groupedComponents.flatMap(componentPins)
	if (component instanceof PathComponent) {
		const points = component.getReferencePoints()
		const endpoints = [points[0], component.toJson().type === "bezier" ? points[1] : points.at(-1)]
		if (component.toJson().type === "path") endpoints.push(...component.snappingPoints.slice(2))
		return endpoints.map((point, index) => ({ name: index === 0 ? "start" : index === 1 ? "end" : component.snappingPoints[index]?.name, point: new SVG.Point(point) }))
	}
	if (component instanceof NodeSymbolComponent) return component.snappingPoints.map((point, index) => ({ name: point.name ?? String(index), point: new SVG.Point(point) }))
	return [] // Text and decorative shape outlines are not electrical pins.
}

function conductor(component: CircuitComponent) { return ["wire", "short"].includes(component.toJson().type) }
function junction(component: CircuitComponent) { return component.toJson().type === "node" && ["circ", "ocirc", "diamondpole", "odiamondpole"].includes((component.toJson() as any).id) }
export function physicalPins(component: CircuitComponent) {
	if (component instanceof GroupComponent) return component.groupedComponents.flatMap(physicalPins)
	const pins = componentPins(component)
	return pins.length ? pins : junction(component) ? [{ name: "center", point: component.position.clone() }] : []
}

/** Actual polyline legs, including the implicit elbow in -| and |-. */
export function legs(component: CircuitComponent) {
	if (!(component instanceof PathComponent) || !conductor(component)) return []
	const points = component.getReferencePoints(), directions = (component.toJson() as any).directions ?? []
	return points.slice(1).flatMap((end, i) => {
		const start = points[i]
		const elbow = directions[i] === "-|" ? new SVG.Point(end.x, start.y) : directions[i] === "|-" ? new SVG.Point(start.x, end.y) : null
		return elbow ? [[start, elbow], [elbow, end]] : [[start, end]]
	})
}
function onLeg(point: SVG.Point, a: SVG.Point, b: SVG.Point, tolerance: number) {
	const delta = b.sub(a), length2 = delta.x ** 2 + delta.y ** 2
	if (!length2) return point.sub(a).abs() <= tolerance
	const t = ((point.x - a.x) * delta.x + (point.y - a.y) * delta.y) / length2
	return t >= 0 && t <= 1 && point.sub(a.add(delta.mul(t))).abs() <= tolerance
}

export function describeComponent(component: CircuitComponent, parentIds: string[] = []) {
	const save: any = component.toJson()
	return { id: component.automationId, parentIds, topLevelId: parentIds[0] ?? component.automationId,
		editable: parentIds.length === 0, displayName: component.displayName, type: save.type, symbol: save.id ?? null,
		label: save.label?.value ?? save.text?.text ?? (typeof save.text === "string" ? save.text : ""), name: save.name ?? "",
		selected: component.isSelected, position: { x: component.position.x, y: component.position.y },
		positionCm: { x: component.position.x / pxPerCm, y: -component.position.y / pxPerCm },
		bounds: component.bbox ? { x: component.bbox.x, y: component.bbox.y, width: component.bbox.width, height: component.bbox.height } : null,
		pins: physicalPins(component).map(({ name, point }, index) => ({ index, name, x: point.x, y: point.y, cm: { x: point.x / pxPerCm, y: -point.y / pxPerCm } })),
		...(component instanceof PathComponent ? { points: component.getReferencePoints().map(p => ({ x: p.x, y: p.y })), pointsCm: component.getReferencePoints().map(p => ({ x: p.x / pxPerCm, y: -p.y / pxPerCm })) } : {}),
		capabilities: { endpoints: component instanceof PathComponent, move: parentIds.length === 0, properties: parentIds.length === 0 }, save }
}

export class AgentEditing {
	public constructor(private main: MainController, private create: (save: any) => CircuitComponent) {}
	public find(id: string, allowChild = false) {
		const entry = agentTree(this.main.circuitComponents).find(entry => entry.component.automationId === id)
		if (!entry) throw new Error(`Unknown component id: ${id}. Read the document again.`)
		if (entry.parentIds.length && !allowChild) throw new Error(`Grouped child ${id} is read-only; target its top-level group ${entry.parentIds[0]}.`)
		return entry
	}
	public targets(operation: any): CircuitComponent[] {
		if ((!!operation.ids) === (operation.selected === true)) throw new Error("Supply either ids or selected:true, exclusively.")
		const ids = operation.selected ? this.main.circuitComponents.filter(c => c.isSelected).map(c => c.automationId) : operation.ids
		if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Error("Target requires 1–500 components; the current selection is empty or invalid.")
		return [...new Set<string>(ids)].map(id => this.find(id).component)
	}
	public query(args: any) {
		let entries = agentTree(this.main.circuitComponents)
		if (!args.includeChildren) entries = entries.filter(entry => !entry.parentIds.length)
		const near = args.near ? agentPoint(args.near, args.unit ?? "cm") : null
		const radius = (args.radius ?? 1) * (args.unit === "px" ? 1 : pxPerCm)
		const results = entries.map(({ component, parentIds }) => describeComponent(component, parentIds)).filter(info => {
			if (args.selected != undefined && info.selected !== args.selected) return false
			if (args.type && info.type !== args.type) return false
			if (args.symbol && info.symbol !== args.symbol) return false
			if (args.label != undefined && info.label !== args.label) return false
			if (args.query && ![info.displayName, info.symbol, info.label, info.name, info.id].some(value => value?.toLowerCase().includes(args.query.toLowerCase()))) return false
			return !near || new SVG.Point(info.position).sub(near).abs() <= radius
		})
		if (near) results.sort((a, b) => new SVG.Point(a.position).sub(near).abs() - new SVG.Point(b.position).sub(near).abs())
		return { total: results.length, ambiguous: results.length > 1, components: results.slice(0, args.limit ?? 100), truncated: results.length > (args.limit ?? 100) }
	}
	public connections(ids: string[], tolerance = contactTolerance) {
		const tree = agentTree(this.main.circuitComponents).filter(entry => !(entry.component instanceof GroupComponent))
		const contacts: object[] = []
		for (const id of [...new Set(ids)]) {
			const component = this.find(id, true).component
			for (const pin of physicalPins(component)) for (const other of tree) {
				if (other.component === component || agentTree([component]).some(entry => entry.component === other.component)) continue
				const matched = physicalPins(other.component).filter(otherPin => pin.point.sub(otherPin.point).abs() <= tolerance)
				for (const target of matched) contacts.push({ id, pin: pin.name, otherId: other.component.automationId, otherPin: target.name, kind: "pin", point: { x: pin.point.x, y: pin.point.y } })
				if (!matched.length && legs(other.component).some(([a, b]) => onLeg(pin.point, a, b, tolerance)))
					contacts.push({ id, pin: pin.name, otherId: other.component.automationId, kind: "wire-interior", point: { x: pin.point.x, y: pin.point.y } })
			}
		}
		return { tolerancePx: tolerance, contacts, note: "Geometric contacts only; crossings, isolation and electrical net equivalence are not inferred." }
	}
	private updateGroups() {
		for (const { component } of agentTree(this.main.circuitComponents).reverse()) if (component instanceof GroupComponent) component.update()
	}
	private geometry(targets: CircuitComponent[], mode: string, action: () => void) {
		if (!["detach", "follow_wires"].includes(mode)) throw new Error("Unknown connections mode.")
		const moving = new Set(targets.flatMap(c => agentTree([c]).map(entry => entry.component)))
		const before = targets.map(component => ({ component, pins: physicalPins(component) }))
		action()
		if (mode === "detach") return []
		const maps: { from: SVG.Point; to: SVG.Point }[] = []
		for (const entry of before) {
			const after = physicalPins(entry.component)
			if (after.length !== entry.pins.length) throw new Error("Pin count changed; use detach or edit the complete connected set.")
			entry.pins.forEach((pin, index) => {
				const previous = maps.find(map => map.from.sub(pin.point).abs() <= contactTolerance)
				if (previous && previous.to.sub(after[index].point).abs() > contactTolerance) throw new Error("A shared pin would split into different positions; move the connected set together or use detach.")
				if (!previous) maps.push({ from: pin.point, to: after[index].point })
			})
		}
		const changed = maps.filter(map => map.from.sub(map.to).abs() > contactTolerance)
		const followed: string[] = []
		for (const { component } of agentTree(this.main.circuitComponents)) {
			if (moving.has(component) || component instanceof GroupComponent) continue
			const pins = physicalPins(component)
			if (!conductor(component) && !junction(component)) {
				if (pins.some(pin => changed.some(map => map.from.sub(pin.point).abs() <= contactTolerance)))
					throw new Error(`Shared junction also touches rigid component ${component.automationId}; include it in the edit or use detach.`)
				continue
			}
			if (conductor(component)) {
				if (changed.some(map => !pins.some(pin => map.from.sub(pin.point).abs() <= contactTolerance) && legs(component).some(([a, b]) => onLeg(map.from, a, b, contactTolerance))))
					throw new Error(`Connection lies inside wire ${component.automationId}; include that wire explicitly or use detach.`)
				const path = component as PathComponent, points = path.getReferencePoints()
				let edited = false
				path.mapReferencePoints((point, index) => {
					// Only stored path endpoints follow; intermediate route points are retained.
					if (index !== 0 && index !== points.length - 1) return point
					const map = changed.find(map => point.sub(map.from).abs() <= contactTolerance)
					if (map) edited = true
					return map?.to.clone() ?? point
				})
				if (edited) followed.push(component.automationId)
			} else {
				const map = changed.find(map => component.position.sub(map.from).abs() <= contactTolerance)
				if (map) { component.moveTo(map.to); followed.push(component.automationId) }
			}
		}
		this.updateGroups()
		return followed
	}
	public apply(operation: any) {
		const targets = this.targets(operation), unit = operation.unit ?? "cm"
		if (operation.op === "set_properties") {
			return this.geometry(targets, operation.connections ?? "detach", () => targets.forEach(component => setProperties(component, operation.values)))
		}
		if (operation.op === "duplicate") {
			const delta = agentPoint({ x: operation.dx ?? 0, y: operation.dy ?? 0 }, unit)
			return targets.map(component => {
				const duplicated = this.create(copy(component.toJson())); duplicated.moveRel(delta)
				return { sourceId: component.automationId, id: duplicated.automationId }
			})
		}
		return this.geometry(targets, operation.connections ?? "detach", () => {
			if (operation.op === "move" || operation.op === "move_to") {
				const delta = operation.op === "move" ? agentPoint({ x: operation.dx, y: operation.dy }, operation.unit ?? "px") :
					agentPoint(operation.position, unit).sub(targets.reduce((sum, c) => sum.add(c.position), new SVG.Point()).div(targets.length))
				targets.forEach(component => component.moveRel(delta))
			} else if (operation.op === "set_endpoints" || operation.op === "set_points") {
				if (targets.length !== 1 || !(targets[0] instanceof PathComponent)) throw new Error("Endpoint/point edits require exactly one path component.")
				const component = targets[0] as PathComponent, points = component.getReferencePoints()
				if (component.toJson().type === "plot") throw Error("Formula plots use plot:* properties and whole-object transforms; individual sample points cannot be edited.")
				if (operation.op === "set_endpoints") {
					if (!operation.start && !operation.end) throw new Error("Supply start and/or end.")
					if (operation.start) points[0] = agentPoint(operation.start, unit)
					if (operation.end) points[component.toJson().type === "bezier" ? 1 : points.length - 1] = agentPoint(operation.end, unit)
				} else {
					if (!Array.isArray(operation.points) || operation.points.length !== points.length) throw new Error("set_points requires the existing reference-point count; use native update to replace a route's topology.")
					operation.points.forEach((p, i) => { points[i] = agentPoint(p, unit) })
				}
				let i = 0; component.mapReferencePoints(() => points[i++])
			} else if (operation.op === "rotate") {
				if (!Number.isFinite(operation.angle)) throw new Error("Angle must be finite degrees, positive counterclockwise.")
				const pivot = operation.pivot ? agentPoint(operation.pivot, unit) : targets.reduce((sum, c) => sum.add(c.position), new SVG.Point()).div(targets.length)
				for (const component of targets) { const position = component.position.rotate(operation.angle, pivot); component.rotate(operation.angle); component.moveTo(position) }
			} else if (operation.op === "align" || operation.op === "distribute") {
				if (targets.length < (operation.op === "align" ? 2 : 3)) throw new Error("Align needs at least two targets; distribute needs at least three.")
				const axis = operation.axis
				if (axis !== "x" && axis !== "y") throw new Error("Axis must be x or y.")
				if (operation.op === "align") {
					const value = operation.referenceId ? this.find(operation.referenceId).component.position[axis] : targets.reduce((sum, c) => sum + c.position[axis], 0) / targets.length
					for (const component of targets) { const position = component.position.clone(); position[axis] = value; component.moveTo(position) }
				} else {
					const sorted = targets.slice().sort((a, b) => a.position[axis] - b.position[axis])
					const start = sorted[0].position[axis], step = (sorted.at(-1).position[axis] - start) / (sorted.length - 1)
					sorted.slice(1, -1).forEach((component, i) => { const p = component.position.clone(); p[axis] = start + step * (i + 1); component.moveTo(p) })
				}
			} else throw new Error(`Unknown operation: ${operation.op}`)
		})
	}
}
