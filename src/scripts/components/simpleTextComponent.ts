import * as SVG from "@svgdotjs/svg.js"
import {
	CanvasController,
	CircuitComponent,
	ComponentSaveObject,
	defaultStroke,
	PropertyCategories,
	renderMathJax,
	SectionHeaderProperty,
	SnapPoint,
	SnappingInfo,
	TextProperty,
} from "../internal"
import { selectedBoxWidth } from "../utils/selectionHelper"

const PX_PER_CM = 96 / 2.54
const formatCoordinate = (value: number) => {
	const rounded = Number(value.toFixed(5))
	return (rounded === 0 ? 0 : rounded).toLocaleString("en", { maximumFractionDigits: 5, useGrouping: false })
}

export type SimpleTextSaveObject = ComponentSaveObject & {
	position: SVG.Point
	text: string
	rotation?: number
	scale?: SVG.Point
	anchor?: string
	innerSep?: number
	color?: string
	background?: string
	fontSize?: string
	align?: "left" | "center" | "right"
}

/** A natural-width, center-anchored TikZ node; the content is preserved as LaTeX. */
export class SimpleTextComponent extends CircuitComponent {
	private static jsonID = "simpleText"
	static {
		CircuitComponent.jsonSaveMap.set(SimpleTextComponent.jsonID, SimpleTextComponent)
	}

	public textProperty: TextProperty
	private xProperty: TextProperty
	private yProperty: TextProperty
	private rotationDeg = 0
	private scaleState = new SVG.Point(1, 1)
	private anchor = "center"
	private innerSep?: number
	private background?: string
	private textColor?: string
	private fontSize?: string
	private align?: "left" | "center" | "right"
	private localBox = new SVG.Box()
	private mathDefinitions = new Set<string>()

	constructor() {
		super()
		this.displayName = "简单文本"
		// Keep this component's form limited to content and coordinates.
		this.properties.clear()
		this.textProperty = new TextProperty(
			"内容",
			"文本",
			"默认以坐标为中心，导入代码可保留锚点。支持 LaTeX，例如 \\(U_1\\)、$I_2$、\\textbf{1}。",
			undefined,
			"simpletext:content"
		)
		this.textProperty.addChangeListener(() => this.renderText())
		this.properties.add(PropertyCategories.text, new SectionHeaderProperty("文本"))
		this.properties.add(PropertyCategories.text, this.textProperty)

		const coordinateValidator = (value: string) =>
			value.trim() !== "" && Number.isFinite(Number(value)) ? "" : "请输入有限数值（单位 cm）。"
		this.xProperty = new TextProperty("x", "0", "横坐标，单位 cm，向右为正。", coordinateValidator, "simpletext:x")
		this.yProperty = new TextProperty("y", "0", "纵坐标，单位 cm，向上为正。", coordinateValidator, "simpletext:y")
		this.xProperty.addChangeListener((ev) => this.setCoordinate("x", ev.value))
		this.yProperty.addChangeListener((ev) => this.setCoordinate("y", ev.value))
		this.properties.add(PropertyCategories.text, new SectionHeaderProperty("坐标（cm）"))
		this.properties.add(PropertyCategories.text, this.xProperty)
		this.properties.add(PropertyCategories.text, this.yProperty)

		this.componentVisualization = CanvasController.instance.canvas.group()
		this.dragElement = CanvasController.instance.canvas.rect(1, 1).fill("transparent").stroke("none")
		this.dragElement.addClass("simple-text-hit-area")
		this.visualization.add(this.componentVisualization)
		this.visualization.add(this.dragElement)
		this.snappingPoints = [new SnapPoint(this, "center", new SVG.Point())]
		this.renderText()
	}

	private clearMathDefinitions() {
		for (const id of this.mathDefinitions) document.getElementById(id)?.remove()
		this.mathDefinitions.clear()
	}

	private renderText() {
		this.clearMathDefinitions()
		this.componentVisualization.clear()
		this.componentVisualization.untransform()
		const content = this.textProperty.value ?? ""
		let box = new SVG.Box()
		if (content.trim()) {
			// textmacros parses text, inline math and text commands in their original modes.
			const size = ({ tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 10, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88 } as Record<string, number>)[this.fontSize] ?? 10
			const lines = this.align ? content.split(/\\\\/) : [content]
			const renderedLines = lines.map(line => {
				const font = line.match(/^\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b\s*/)
				const lineSize = font ? ({ tiny: 5, scriptsize: 7, footnotesize: 8, small: 9, normalsize: 10, large: 12, Large: 14.4, LARGE: 17.28, huge: 20.74, Huge: 24.88 } as Record<string, number>)[font[1]] : size
				return renderMathJax("\\text{" + (font ? line.slice(font[0].length) : line) + "}", lineSize, true)
			})
			const width = Math.max(...renderedLines.map(line => line.layoutBox.w))
			const baselineSkip = size * 1.2 * 96 / 72.27
			renderedLines.forEach((rendered, index) => {
				const lineBox = rendered.layoutBox
				const x = this.align === "left" ? 0 : this.align === "right" ? width - lineBox.w : (width - lineBox.w) / 2
				const offset = new SVG.Point(x - lineBox.x, index * baselineSkip)
				rendered.element.transform(new SVG.Matrix({ translate: offset.toArray() }).multiply(rendered.element.matrixify()))
				this.componentVisualization.add(rendered.element)
				const shifted = new SVG.Box(lineBox.x + offset.x, lineBox.y + offset.y, lineBox.w, lineBox.h)
				box = index === 0 ? shifted : box.merge(shifted)
				for (const use of rendered.element.find("use")) {
					const href = use.attr("href") ?? use.attr("xlink:href")
					if (typeof href === "string" && href.startsWith("#")) this.mathDefinitions.add(href.slice(1))
				}
			})
		}
		const sep = this.innerSep ?? 10 / 3 * 96 / 72.27
		if (this.background) (this.componentVisualization as SVG.G).rect(box.w + 2 * sep, box.h + 2 * sep).move(box.x - sep, box.y - sep).fill(this.background).back()
		const direction = new SVG.Point(
			this.anchor.includes("east") ? 1 : this.anchor.includes("west") ? -1 : 0,
			this.anchor.includes("north") ? -1 : this.anchor.includes("south") ? 1 : 0
		)
		const center = direction.mul(new SVG.Point(box.w / 2 + sep, box.h / 2 + sep)).mul(-1)
		this.componentVisualization.transform({ translate: [center.x - box.cx, center.y - box.cy] })
		// The hit area only makes small symbols easier to select; it is never exported.
		this.localBox = new SVG.Box(
			center.x - Math.max(box.w, 12) / 2,
			center.y - Math.max(box.h, 12) / 2,
			Math.max(box.w, 12),
			Math.max(box.h, 12)
		)
		this.dragElement.size(this.localBox.w, this.localBox.h).move(this.localBox.x, this.localBox.y)
		this.updateTheme()
		this.update()
	}

	public getTransformMatrix(): SVG.Matrix {
		return new SVG.Matrix({
			scale: this.scaleState.toArray(),
			rotate: -this.rotationDeg,
			translate: this.position.toArray(),
			origin: [0, 0],
		})
	}

	private setCoordinate(axis: "x" | "y", value: string): void {
		if (value.trim() === "" || !Number.isFinite(Number(value))) return
		this.position[axis] = Number(value) * PX_PER_CM * (axis === "y" ? -1 : 1)
		// Preserve the user's in-progress input, such as "1." or "-0.0".
		this.update(false)
	}

	public update(synchronizeCoordinates = true): void {
		const matrix = this.getTransformMatrix()
		this.visualization.transform(matrix)
		this._bbox = this.localBox.transform(matrix)
		if (synchronizeCoordinates) {
			this.xProperty.value = formatCoordinate(this.position.x / PX_PER_CM)
			this.yProperty.value = formatCoordinate(-this.position.y / PX_PER_CM)
		}
		this.recalculateSnappingPoints(matrix)
		this.recalculateSelectionVisuals()
	}

	public updateTheme(): void {
		this.componentVisualization.fill(this.textColor ?? defaultStroke).attr("color", this.textColor ?? defaultStroke)
	}

	protected recalculateSelectionVisuals(): void {
		if (this.selectionElement)
			this.selectionElement
				.size(this.localBox.w + selectedBoxWidth, this.localBox.h + selectedBoxWidth)
				.move(this.localBox.x - selectedBoxWidth / 2, this.localBox.y - selectedBoxWidth / 2)
				.transform(this.getTransformMatrix())
	}

	protected recalculateResizePoints(): void {}
	public resizable(): void {}
	public getSnappingInfo(): SnappingInfo {
		return { trackedSnappingPoints: this.snappingPoints, additionalSnappingPoints: [] }
	}
	public moveTo(position: SVG.Point): void {
		this.position = position.clone()
		this.update()
	}
	public moveRel(delta: SVG.Point): void {
		this.moveTo(this.position.add(delta))
	}
	public rotate(angleDeg: number): void {
		this.rotationDeg = (this.rotationDeg + angleDeg) % 360
		this.update()
	}
	public flip(horizontal: boolean): void {
		if (horizontal) this.scaleState.y *= -1
		else this.scaleState.x *= -1
		this.update()
	}
	public placeMove(position: SVG.Point): void {
		this.moveTo(position)
	}
	public placeStep(position: SVG.Point): boolean {
		this.moveTo(position)
		return true
	}
	public placeRotate(angleDeg: number): void {
		this.rotate(angleDeg)
	}
	public placeFlip(horizontal: boolean): void {
		this.flip(horizontal)
	}
	public placeFinish(): void {
		this.finishedPlacing = true
		this.draggable(true)
		this.update()
	}
	public copyForPlacement(): SimpleTextComponent {
		const copy = new SimpleTextComponent()
		copy.textProperty.value = this.textProperty.value
		copy.rotationDeg = this.rotationDeg
		copy.scaleState = this.scaleState.clone()
		copy.anchor = this.anchor
		copy.innerSep = this.innerSep
		copy.textColor = this.textColor
		copy.fontSize = this.fontSize
		copy.align = this.align
		copy.renderText()
		return copy
	}

	public toJson(): SimpleTextSaveObject {
		const data: SimpleTextSaveObject = {
			...super.toJson(),
			type: SimpleTextComponent.jsonID,
			position: this.position.clone(),
			text: this.textProperty.value ?? "",
		}
		if (this.rotationDeg) data.rotation = this.rotationDeg
		if (this.anchor != "center") data.anchor = this.anchor
		if (this.innerSep != undefined) data.innerSep = this.innerSep
		if (this.background) data.background = this.background
		if (this.textColor) data.color = this.textColor
		if (this.fontSize) data.fontSize = this.fontSize
		if (this.align) data.align = this.align
		if (!this.scaleState.eq(new SVG.Point(1, 1))) data.scale = this.scaleState.clone()
		return data
	}
	protected applyJson(data: SimpleTextSaveObject): void {
		if (data.color != null && !/^#[\da-f]{6}$/i.test(data.color)) throw Error("Text color must be #RRGGBB.")
		if (data.background != null && !/^#[\da-f]{6}$/i.test(data.background)) throw Error("Text background must be #RRGGBB.")
		super.applyJson(data)
		this.position = new SVG.Point(data.position)
		this.rotationDeg = data.rotation ?? 0
		this.scaleState = new SVG.Point(data.scale ?? { x: 1, y: 1 })
		this.anchor = data.anchor ?? "center"
		this.innerSep = data.innerSep
		this.background = data.background
		this.textColor = data.color
		this.fontSize = data.fontSize
		this.align = ["left", "center", "right"].includes(data.align) ? data.align : undefined
		this.textProperty.value = data.text ?? ""
		this.renderText()
	}
	public static fromJson(_data: SimpleTextSaveObject): SimpleTextComponent {
		return new SimpleTextComponent()
	}
	public toTikzString(): string {
		const options: string[] = []
		if (this.background) options.push("fill={rgb,255:red," + parseInt(this.background.slice(1, 3), 16) + ";green," + parseInt(this.background.slice(3, 5), 16) + ";blue," + parseInt(this.background.slice(5, 7), 16) + "}")
		if (this.textColor) options.push("text={rgb,255:red," + parseInt(this.textColor.slice(1, 3), 16) + ";green," + parseInt(this.textColor.slice(3, 5), 16) + ";blue," + parseInt(this.textColor.slice(5, 7), 16) + "}")
		if (this.fontSize && /^(?:tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)$/.test(this.fontSize)) options.push("font=\\" + this.fontSize)
		if (this.align) options.push("align=" + this.align)
		if (this.anchor != "center") options.push("anchor=" + this.anchor)
		if (this.innerSep != undefined) options.push("inner sep=" + formatCoordinate(this.innerSep / PX_PER_CM) + "cm")
		if (this.rotationDeg) options.push("rotate=" + this.rotationDeg)
		if (this.scaleState.x !== 1) options.push("xscale=" + this.scaleState.x)
		if (this.scaleState.y !== 1) options.push("yscale=" + this.scaleState.y)
		return (
			"\\node" +
			(options.length ? "[" + options.join(", ") + "]" : "") +
			" at (" +
			formatCoordinate(this.position.x / PX_PER_CM) +
			", " +
			formatCoordinate(-this.position.y / PX_PER_CM) +
			") {" +
			(this.textProperty.value ?? "") +
			"};"
		)
	}
	public toSVG(defs: Map<string, SVG.Element>): SVG.Element {
		const copy = super.toSVG(defs)
		copy.findOne(".simple-text-hit-area")?.remove()
		return copy
	}
	public remove(): void {
		this.clearMathDefinitions()
		super.remove()
	}
}
