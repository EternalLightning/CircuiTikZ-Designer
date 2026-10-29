import * as SVG from "@svgdotjs/svg.js"
import {
	ArrowTip,
	arrowTips,
	CanvasController,
	ChoiceProperty,
	CircuitComponent,
	CircuitikzTo,
	PathComponent,
	PathSaveObject,
	PropertyCategories,
	defaultArrowTip,
	defaultStroke,
	SectionHeaderProperty,
	SelectionController,
	SliderProperty,
	SnapPoint,
	Strokable,
	TikzPathCommand,
} from "../internal"
import { rectRectIntersection, selectedBoxWidth } from "../utils/selectionHelper"

export type ArcSaveObject = PathSaveObject & {
	/**
	 * the bend angle in degrees. positive values bend to the left (counter clockwise in TikZ coordinates)
	 */
	bend?: number
	startArrow?: string
	endArrow?: string
	middleArrow?: string
	middleArrowPosition?: number
}

/**
 * A generic (curved) annotation arrow. It is drawn as a TikZ path with a bend option, e.g.
 * `\draw[->] (0,0) to[bend left=45] (2,1);`
 */
export class ArcComponent extends Strokable(PathComponent) {
	private static jsonID = "arc"
	static {
		CircuitComponent.jsonSaveMap.set(ArcComponent.jsonID, ArcComponent)
	}

	private curve: SVG.Path
	private dragCurve: SVG.Path

	public arrowStartChoice: ChoiceProperty<ArrowTip>
	public arrowEndChoice: ChoiceProperty<ArrowTip>
	public arrowMiddleChoice: ChoiceProperty<ArrowTip>
	public arrowMiddlePosition: SliderProperty
	public bendProperty: SliderProperty

	private startArrowElement: SVG.Element
	private endArrowElement: SVG.Element
	private middleArrowElement: SVG.Element

	constructor(withDefaultArrow = true, cubic = false) {
		super()
		this.displayName = "弧形箭头"
		this.pointLimit = 2
		this.referencePoints = []
		this.strokeWidthProperty.value = new SVG.Number("0.4pt")
		this.strokeInfo.width = this.strokeWidthProperty.value

		this.curve = CanvasController.instance.canvas.path().fill("none")
		this.dragCurve = CanvasController.instance.canvas.path().fill("none").stroke({
			width: 15,
			color: "transparent",
		})
		this.visualization.add(this.curve)
		this.visualization.add(this.dragCurve)
		this.visualization.hide()

		this.properties.add(
			PropertyCategories.options,
			new SectionHeaderProperty("弧形", undefined, "options:arc_header")
		)
		this.bendProperty = new SliderProperty(
			"弯曲度",
			-89,
			89,
			1,
			new SVG.Number(45, ""),
			true,
			"正值向左弯曲，负值向右弯曲",
			"options:arc_bend"
		)
		this.bendProperty.addChangeListener(() => this.update())
		if (!cubic) this.properties.add(PropertyCategories.options, this.bendProperty)

		this.properties.add(PropertyCategories.options, new SectionHeaderProperty("箭头", undefined, "arrows:header"))
		this.arrowStartChoice = new ChoiceProperty("起点", arrowTips, defaultArrowTip, undefined, "arrows:start")
		this.arrowStartChoice.addChangeListener(() => {
			this.updateArrowTypesAndColors()
			this.update()
		})
		this.properties.add(PropertyCategories.options, this.arrowStartChoice)

		this.arrowEndChoice = new ChoiceProperty(
			"终点",
			arrowTips,
			withDefaultArrow ? arrowTips.find((tip) => tip.key == "to") : defaultArrowTip,
			undefined,
			"arrows:end"
		)
		this.arrowEndChoice.addChangeListener(() => {
			this.updateArrowTypesAndColors()
			this.update()
		})
		this.properties.add(PropertyCategories.options, this.arrowEndChoice)

		this.arrowMiddleChoice = new ChoiceProperty("中段", arrowTips, defaultArrowTip, undefined, "arrows:middle")
		this.arrowMiddleChoice.addChangeListener(() => {
			this.updateArrowTypesAndColors()
			this.update()
		})
		this.properties.add(PropertyCategories.options, this.arrowMiddleChoice)

		this.arrowMiddlePosition = new SliderProperty(
			"位置",
			0.05,
			0.95,
			0.01,
			new SVG.Number(0.5, ""),
			true,
			"中段箭头沿弧线的相对位置",
			"arrows:middle_position"
		)
		this.arrowMiddlePosition.addChangeListener(() => this.update())
		this.properties.add(PropertyCategories.options, this.arrowMiddlePosition)

		this.snappingPoints = [new SnapPoint(this, null, new SVG.Point()), new SnapPoint(this, null, new SVG.Point())]
	}

	private lineWidthToArrowScale(): number {
		return this.strokeInfo.width.convertToUnit("pt").value * 4.5 + 2.8
	}

	private fadeColor() {
		return this.strokeInfo.color == "default" ? defaultStroke : this.strokeInfo.color
	}

	private updateArrowTypesAndColors() {
		const arrowColor = this.fadeColor()

		for (const [element, choice] of [
			[this.startArrowElement, this.arrowStartChoice],
			[this.endArrowElement, this.arrowEndChoice],
			[this.middleArrowElement, this.arrowMiddleChoice],
		] as [SVG.Element, ChoiceProperty<ArrowTip>][]) {
			element?.remove()
		}
		this.startArrowElement = null
		this.endArrowElement = null
		this.middleArrowElement = null

		const createArrow = (choice: ChoiceProperty<ArrowTip>) => {
			if (choice.value.key == defaultArrowTip.key) {
				return null
			}
			const group = CanvasController.instance.canvas.group()
			group.addTo(this.visualization)
			group.stroke({ color: arrowColor, opacity: this.strokeInfo.opacity })
			group.fill({ color: arrowColor, opacity: this.strokeInfo.opacity })
			const arrowPath = document.getElementById(choice.value.svgId ?? choice.value.key)
			for (const element of arrowPath.children) {
				group.node.append(element.cloneNode(true))
			}
			return group
		}

		this.startArrowElement = createArrow(this.arrowStartChoice)
		this.endArrowElement = createArrow(this.arrowEndChoice)
		this.middleArrowElement = createArrow(this.arrowMiddleChoice)
	}

	protected quadraticPoint(t: number): { point: SVG.Point; tangent: SVG.Point } | null {
		if (this.referencePoints.length < 2) {
			return null
		}
		const { p0, control, p1 } = this.getGeometry()
		const oneMinusT = 1 - t
		const point = p0
			.mul(oneMinusT * oneMinusT)
			.add(control.mul(2 * oneMinusT * t))
			.add(p1.mul(t * t))
		const tangent = control.sub(p0).mul(2 * oneMinusT).add(p1.sub(control).mul(2 * t))
		return { point, tangent }
	}

	protected getGeometry() {
		const p0 = this.referencePoints[0]
		const p1 = this.referencePoints[1]
		const chord = p1.sub(p0)
		const length = chord.abs() || 1
		const normal = chord.div(length).rotate(90)
		const bendRad = (this.bendProperty.value.value * Math.PI) / 180
		const control = p0.add(p1).div(2).add(normal.mul(length * Math.tan(bendRad / 2)))
		return { p0, p1, control, length }
	}

	protected curvePathString(): string {
		const { p0, p1, control } = this.getGeometry()
		return `M ${p0.x} ${p0.y} Q ${control.x} ${control.y} ${p1.x} ${p1.y}`
	}
	protected endpointDirections(): { start: SVG.Point; end: SVG.Point } {
		const { p0, p1, control } = this.getGeometry()
		return { start: p0.sub(control), end: p1.sub(control) }
	}

	private updateArrowTransforms() {
		if (this.referencePoints.length < 2) {
			return
		}
		const { p0, p1, control } = this.getGeometry()
		const scale = this.lineWidthToArrowScale()
		const strokeWidth = this.strokeInfo.width.convertToUnit("px").value / scale

		const placeArrow = (element: SVG.Element, choice: ArrowTip, point: SVG.Point, direction: SVG.Point) => {
			if (!element) {
				return
			}
			const angle = (Math.atan2(direction.y, direction.x) * 180) / Math.PI
			const refXY = choice.refXY ?? new SVG.Point(-1, -0.5)
			element.transform(
				new SVG.Matrix({
					translate: point.toArray(),
					rotate: angle,
					scale: [scale, scale],
				}).multiply({ translate: refXY.toArray() })
			)
			element.attr("stroke-width", strokeWidth * (choice.strokeFactor ?? 0))
		}

		const directions = this.endpointDirections()
		placeArrow(this.startArrowElement, this.arrowStartChoice.value, p0, directions.start)
		placeArrow(this.endArrowElement, this.arrowEndChoice.value, p1, directions.end)

		if (this.middleArrowElement) {
			const middle = this.quadraticPoint(this.arrowMiddlePosition.value.value)
			if (middle) {
				placeArrow(this.middleArrowElement, this.arrowMiddleChoice.value, middle.point, middle.tangent)
			}
		}
	}

	public updateTheme(): void {
		this.updateArrowTypesAndColors()
		const color = this.fadeColor()
		this.curve.stroke({
			color: color,
			opacity: this.strokeInfo.opacity,
			width: this.strokeInfo.width.convertToUnit("px").value,
			dasharray: this.strokeStyleProperty.value.dasharray
				.map((factor) => this.strokeInfo.width.times(factor).toString())
				.join(" "),
		})
		if (this.finishedPlacing) {
			this.update()
		}
	}

	public update(): void {
		if (this.referencePoints.length < 2) {
			this.curve.plot("")
			return
		}

		const { p0, p1, control } = this.getGeometry()
		const pathString = this.curvePathString()
		this.curve.plot(pathString)
		this.dragCurve.plot(pathString)

		this.position = p0.add(p1).div(2)

		this.updateArrowTransforms()
		this.recalculateResizePoints()
		this.recalculateSnappingPoints()
		this.recalculateSelectionVisuals()

		this._bbox = this.visualization.bbox()
		this.referencePosition = this._bbox ? this.position.sub(new SVG.Point(this._bbox.x, this._bbox.y)) : new SVG.Point()
	}

	protected recalculateSelectionVisuals(): void {
		if (!this.selectionElement || this.referencePoints.length < 2) {
			return
		}
		let bbox = this.curve.bbox()
		for (const arrow of [this.startArrowElement, this.endArrowElement, this.middleArrowElement]) {
			if (arrow) {
				bbox = bbox.merge(arrow.bbox().transform(new SVG.Matrix(arrow.transform())))
			}
		}
		this.selectionElement
			.size(bbox.width + selectedBoxWidth, bbox.height + selectedBoxWidth)
			.center(bbox.cx, bbox.cy)
	}

	public recalculateSnappingPoints(): void {
		if (this.referencePoints.length >= 2) {
			const inverseTransform = this.getTransformMatrix().inverse()
			this.snappingPoints[0].updateRelPosition(this.referencePoints[0].transform(inverseTransform))
			this.snappingPoints[1].updateRelPosition(this.referencePoints[1].transform(inverseTransform))
		}
		super.recalculateSnappingPoints()
	}

	public getSnappingInfo() {
		if (this.finishedPlacing) {
			return {
				trackedSnappingPoints: this.snappingPoints,
				additionalSnappingPoints: [],
			}
		}
		return {
			trackedSnappingPoints: [],
			additionalSnappingPoints: this.referencePoints.length > 0 ? [new SnapPoint(this, "", new SVG.Point())] : [],
		}
	}

	public viewSelected(show: boolean): void {
		super.viewSelected(show)
		this.resizable(this.isSelected && show && SelectionController.instance.currentlySelectedComponents.length == 1)
	}

	public isInsideSelectionRectangle(selectionRectangle: SVG.Box): boolean {
		return rectRectIntersection(this.visualization.bbox(), selectionRectangle)
	}

	public requiredTikzLibraries(): string[] {
		return [...(this.arrowMiddleChoice.value.key !== defaultArrowTip.key ? ["decorations.markings"] : []),
			...([this.arrowStartChoice, this.arrowEndChoice, this.arrowMiddleChoice].some(choice => choice.value.svgId) ? ["arrows.meta"] : [])]
	}

	protected buildTikzCommand(command: TikzPathCommand): void {
		super.buildTikzCommand(command)

		const arrowOptions: string[] = []
		if (this.arrowStartChoice.value.key !== defaultArrowTip.key) {
			arrowOptions.push(this.arrowStartChoice.value.tikz)
			arrowOptions.push("-")
		}
		if (this.arrowEndChoice.value.key !== defaultArrowTip.key) {
			if (arrowOptions.length == 0) {
				arrowOptions.push("-")
			}
			arrowOptions.push(this.arrowEndChoice.value.tikz)
		}
		if (arrowOptions.length > 0) {
			command.options.push(arrowOptions.join(""))
		}

		if (this.arrowMiddleChoice.value.key !== defaultArrowTip.key) {
			const position = this.arrowMiddlePosition.value.value.toFixed(2)
			command.options.push(">=" + this.arrowMiddleChoice.value.tikz)
			command.options.push("decoration={markings, mark=at position " + position + " with {\\arrow{>}}}")
			command.options.push("postaction={decorate}")
		}

		const bend = this.bendProperty.value.value
		if (Math.abs(bend) < 0.05) {
			command.connectors.push("--")
		} else {
			const bendOption = bend > 0 ? "bend left=" + bend.toFixed(1) : "bend right=" + Math.abs(bend).toFixed(1)
			const to: CircuitikzTo = { options: [bendOption] }
			command.connectors.push(to)
		}
	}

	public toJson(): ArcSaveObject {
		const data = super.toJson() as ArcSaveObject
		data.type = ArcComponent.jsonID
		if (this.bendProperty.value.value != 45) {
			data.bend = this.bendProperty.value.value
		}
		if (this.arrowStartChoice.value.key !== defaultArrowTip.key) {
			data.startArrow = this.arrowStartChoice.value.key
		}
		if (this.arrowEndChoice.value.key !== defaultArrowTip.key) {
			data.endArrow = this.arrowEndChoice.value.key
		}
		if (this.arrowMiddleChoice.value.key !== defaultArrowTip.key) {
			data.middleArrow = this.arrowMiddleChoice.value.key
			if (this.arrowMiddlePosition.value.value != 0.5) {
				data.middleArrowPosition = this.arrowMiddlePosition.value.value
			}
		}
		return data
	}

	public applyJson(saveObject: ArcSaveObject): void {
		super.applyJson(saveObject)
		if (saveObject.bend != undefined) {
			this.bendProperty.value = new SVG.Number(saveObject.bend, "")
		}
		this.arrowStartChoice.value =
			arrowTips.find((tip) => tip.key == saveObject.startArrow) ?? defaultArrowTip
		this.arrowEndChoice.value = arrowTips.find((tip) => tip.key == saveObject.endArrow) ?? defaultArrowTip
		this.arrowMiddleChoice.value =
			arrowTips.find((tip) => tip.key == saveObject.middleArrow) ?? defaultArrowTip
		if (saveObject.middleArrowPosition != undefined) {
			this.arrowMiddlePosition.value = new SVG.Number(saveObject.middleArrowPosition, "")
		}
		this.visualization.show()
		this.updateTheme()
		this.update()
		this.finishedPlacing = true
	}

	public static fromJson(saveObject: ArcSaveObject): ArcComponent {
		return new ArcComponent(false)
	}

	public copyForPlacement(): ArcComponent {
		return new ArcComponent()
	}

	public remove(): void {
		this.resizable(false)
		super.remove()
	}
}
