import * as SVG from "@svgdotjs/svg.js"
import {
	CircuitComponent,
	PropertyCategories,
	TextProperty,
	TikzPathCommand,
	WireComponent,
	WireSaveObject,
} from "../internal"
import { compileTikzMath } from "../utils/tikzMath"
import { fitAffine } from "../utils/affineFit"

export type PlotDefinition = { x: string; y: string; domain: [number, number]; samples: number }
export type PlotSaveObject = WireSaveObject & { plot: PlotDefinition }
const PX = 96 / 2.54
export function samplePlot(plot: PlotDefinition): SVG.Point[] {
	if (
		!plot ||
		typeof plot.x !== "string" ||
		typeof plot.y !== "string" ||
		plot.x.length > 12000 ||
		plot.y.length > 12000 ||
		!Array.isArray(plot.domain) ||
		plot.domain.length !== 2 ||
		!plot.domain.every(Number.isFinite) ||
		!Number.isInteger(plot.samples) ||
		plot.samples < 2 ||
		plot.samples > 500
	)
		throw Error("Invalid plot expression, domain or sample count (2–500).")
	const evaluateX = compileTikzMath(plot.x),
		evaluateY = compileTikzMath(plot.y)
	if (!evaluateX || !evaluateY) throw Error("曲线表达式包含不支持的语法。")
	return Array.from({ length: plot.samples }, (_, i) => {
		const value = plot.domain[0] + (i * (plot.domain[1] - plot.domain[0])) / (plot.samples - 1)
		const variables = { x: value },
			x = evaluateX(variables),
			y = evaluateY(variables)
		if (x == null || y == null || Math.abs(x) > 1e5 || Math.abs(y) > 1e5)
			throw Error("曲线在采样位置 " + value + " 无法求值；请分开绘制不连续区间。")
		return new SVG.Point(x * PX, -y * PX)
	})
}

/** Formula-driven curve. Samples are derived geometry; exports retain the formula. */
export class PlotComponent extends WireComponent {
	static {
		CircuitComponent.jsonSaveMap.set("plot", PlotComponent)
	}
	private definition: PlotDefinition
	private basePoints: SVG.Point[]
	private fields: TextProperty[] = []
	constructor() {
		super(true)
		this.displayName = "函数曲线"
		this.preserveGeometry = true
		for (const name of ["x 表达式", "y 表达式", "定义域起点", "定义域终点", "采样数"]) {
			const index = this.fields.length
			const field = new TextProperty(
				name,
				"",
				"使用变量 \\x；三角函数以度为单位。",
				(value) => {
					if (!this.definition) return ""
					const values = this.fields.map((f) => f.value)
					values[index] = value
					try {
						if (values.slice(2).some((v) => !v.trim())) return "请输入有限数值。"
						samplePlot({
							x: values[0],
							y: values[1],
							domain: [Number(values[2]), Number(values[3])],
							samples: Number(values[4]),
						})
						return ""
					} catch (error) {
						return String(error.message)
					}
				},
				"plot:" + index
			)
			field.addChangeListener(() => this.changeDefinition())
			this.fields.push(field)
			this.properties.add(PropertyCategories.options, field)
		}
	}
	private changeDefinition() {
		if (!this.definition) return
		const plot: PlotDefinition = {
			x: this.fields[0].value,
			y: this.fields[1].value,
			domain: [Number(this.fields[2].value), Number(this.fields[3].value)],
			samples: Number(this.fields[4].value),
		}
		const points = samplePlot(plot),
			matrix = fitAffine(this.basePoints, this.getReferencePoints())
		if (!matrix) throw Error("曲线的采样点已单独修改，无法恢复公式变换。")
		this.definition = plot
		this.basePoints = points
		this.referencePoints = points.map((point) => point.transform(new SVG.Matrix(matrix)))
		this.update()
	}
	public resizable(_enabled?: boolean): void {
		/* Use formula/domain fields, not independent sample handles. */
	}
	public toJson(): PlotSaveObject {
		return { ...super.toJson(), type: "plot", plot: structuredClone(this.definition) }
	}
	public applyJson(save: PlotSaveObject): void {
		const basePoints = samplePlot(save.plot)
		if (!fitAffine(basePoints, save.points))
			throw Error("Plot samples do not match the formula under an affine transform.")
		this.definition = structuredClone(save.plot)
		this.basePoints = basePoints
		const values = [
			this.definition.x,
			this.definition.y,
			...this.definition.domain.map(String),
			String(this.definition.samples),
		]
		values.forEach((value, i) => {
			this.fields[i].value = value
		})
		super.applyJson(save)
	}
	public toTikzString(): string {
		const matrix = fitAffine(this.basePoints, this.getReferencePoints())
		if (!matrix) throw Error("函数曲线的采样点已单独修改，无法保真导出公式。请恢复采样点或修改曲线参数。")
		const command: TikzPathCommand = { options: [], coordinates: [], connectors: [], additionalNodes: [] }
		this.buildTikzCommand(command)
		const format = (n: number) => String(Number(n.toFixed(8)))
		const transform =
			[matrix.a, -matrix.b, -matrix.c, matrix.d].map(format).join(",") +
			",(" +
			format(matrix.e / PX) +
			"," +
			format(-matrix.f / PX) +
			")"
		const options = command.options.filter((option) => option !== "draw")
		options.push("domain=" + this.definition.domain.join(":"), "samples=" + this.definition.samples)
		return (
			"\\begin{scope}[cm={" +
			transform +
			"}]\n\\draw[" +
			options.join(", ") +
			"] plot ({" +
			this.definition.x +
			"},{" +
			this.definition.y +
			"});\n\\end{scope}"
		)
	}
	public static fromJson(save: PlotSaveObject): PlotComponent {
		samplePlot(save.plot)
		return new PlotComponent()
	}
	public copyForPlacement(): PlotComponent {
		const copy = new PlotComponent()
		copy.applyJson(this.toJson())
		copy.finishedPlacing = false
		return copy
	}
	public placeMove(position: SVG.Point): void {
		this.moveTo(position)
	}
	public placeStep(position: SVG.Point): boolean {
		this.moveTo(position)
		return true
	}
	public placeFinish(): void {
		this.finishedPlacing = true
		this.draggable(true)
		this.update()
	}
}
