export type PointLike = { x: number; y: number }
export type AffineFit = { a: number; b: number; c: number; d: number; e: number; f: number }

/** Recover a scene transform and verify every sample, including edits to interior points. */
export function fitAffine(original: PointLike[], current: PointLike[], tolerance = .02): AffineFit | null {
	if (original.length !== current.length || original.length < 2) return null
	const p = original[0], q = current[0]
	let j = 1
	for (let i = 2; i < original.length; i++)
		if (Math.hypot(original[i].x - p.x, original[i].y - p.y) > Math.hypot(original[j].x - p.x, original[j].y - p.y)) j = i
	const ux = original[j].x - p.x, uy = original[j].y - p.y
	let k = -1, determinant = 0
	for (let i = 1; i < original.length; i++) {
		const cross = ux * (original[i].y - p.y) - uy * (original[i].x - p.x)
		if (Math.abs(cross) > Math.abs(determinant)) { k = i; determinant = cross }
	}
	let a: number, b: number, c: number, d: number
	const vx = current[j].x - q.x, vy = current[j].y - q.y
	if (Math.abs(determinant) > 1e-8 && k >= 0) {
		const wx = original[k].x - p.x, wy = original[k].y - p.y
		const tx = current[k].x - q.x, ty = current[k].y - q.y
		a = (vx * wy - tx * uy) / determinant; c = (tx * ux - vx * wx) / determinant
		b = (vy * wy - ty * uy) / determinant; d = (ty * ux - vy * wx) / determinant
	} else {
		const length2 = ux * ux + uy * uy
		if (length2 < 1e-12) { a = d = 1; b = c = 0 }
		else { a = d = (vx * ux + vy * uy) / length2; b = (vy * ux - vx * uy) / length2; c = -b }
	}
	const result = { a, b, c, d, e: q.x - a * p.x - c * p.y, f: q.y - b * p.x - d * p.y }
	if (!Object.values(result).every(Number.isFinite)) return null
	return original.every((point, i) => Math.hypot(a * point.x + c * point.y + result.e - current[i].x, b * point.x + d * point.y + result.f - current[i].y) <= tolerance) ? result : null
}
