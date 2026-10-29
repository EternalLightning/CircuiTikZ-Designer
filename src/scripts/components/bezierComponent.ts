import * as SVG from "@svgdotjs/svg.js"
import { ArcComponent, ArcSaveObject, CircuitComponent, TikzPathCommand } from "../internal"

/** A cubic curve with two endpoints and two independently editable controls. */
export class BezierComponent extends ArcComponent {
	static { CircuitComponent.jsonSaveMap.set("bezier", BezierComponent) }
	constructor() {
		super(false, true)
		this.displayName = "贝塞尔曲线"
		this.pointLimit = 4
	}
	protected curvePathString(): string {
		if (this.referencePoints.length < 4) return ""
		const [p0, p1, c0, c1] = this.referencePoints
		return `M ${p0.x} ${p0.y} C ${c0.x} ${c0.y} ${c1.x} ${c1.y} ${p1.x} ${p1.y}`
	}
	protected endpointDirections() {
		const [p0, p1, c0 = p1, c1 = p0] = this.referencePoints
		return { start: p0.sub(c0), end: p1.sub(c1) }
	}
	protected quadraticPoint(t: number) {
		if (this.referencePoints.length < 4) return null
		const [p0, p1, c0, c1] = this.referencePoints, u = 1 - t
		return {
			point: p0.mul(u ** 3).add(c0.mul(3 * u * u * t)).add(c1.mul(3 * u * t * t)).add(p1.mul(t ** 3)),
			tangent: c0.sub(p0).mul(3 * u * u).add(c1.sub(c0).mul(6 * u * t)).add(p1.sub(c1).mul(3 * t * t)),
		}
	}
	protected buildTikzCommand(command: TikzPathCommand): void {
		super.buildTikzCommand(command)
		const [p0, p1, c0, c1] = this.referencePoints
		command.coordinates = [p0, p1]
		command.connectors = [`.. controls ${c0.toTikzString()} and ${c1.toTikzString()} ..`]
	}
	public toJson(): ArcSaveObject {
		const save = super.toJson()
		save.type = "bezier"
		delete save.bend
		return save
	}
	public static fromJson(save: ArcSaveObject): BezierComponent {
		if (save.points?.length !== 4) throw Error("A Bezier curve requires exactly two endpoints and two control points.")
		return new BezierComponent()
	}
	public copyForPlacement(): BezierComponent { return new BezierComponent() }
}
