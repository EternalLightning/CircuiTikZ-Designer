import { mkdtemp, readFile, writeFile, rm, mkdir, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, delimiter, isAbsolute, join, resolve, sep } from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createHash } from "node:crypto"
import { performance } from "node:perf_hooks"

const executeFile = promisify(execFile)
async function execute(file, args, options) {
  const pending = executeFile(file, args, options)
  // Abort rejects before Windows has necessarily closed the process's file handles.
  const closed = new Promise(resolve => pending.child.once("close", resolve))
  try { return await pending }
  catch (error) { if (options.signal?.aborted) await closed; throw error }
}
const engines = new Set(["xelatex", "lualatex", "pdflatex"])
const boundedLog = value => String(value || "").slice(-14000)

export function standaloneDocument(source, engine = "xelatex") {
  const circuit = /\\begin\{circuitikz\}|\\ctikzset\b|\bto\s*\[/.test(source)
  const unicode = engine !== "pdflatex"
  // Package declarations belong before \begin{document}. Macro definitions can
  // contain a picture themselves, so the first picture token is not a safe split.
  const packages = []
  let body = "", depth = 0
  for (let i = 0; i < source.length;) {
    if (source[i] === "%") {
      let end = source.indexOf("\n", i); if (end < 0) end = source.length
      body += source.slice(i, end); i = end; continue
    }
    if (depth === 0 && source[i] === "\\" && /^\\documentclass\b/.test(source.slice(i))) return source
    const declaration = depth === 0 && source[i] === "\\" && source.slice(i).match(/^\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}/)
    if (declaration) { packages.push(declaration[0]); i += declaration[0].length; continue }
    if (source[i] === "\\" && /[{}%\\]/.test(source[i + 1] ?? "")) { body += source.slice(i, i + 2); i += 2; continue }
    if (source[i] === "{") depth++
    if (source[i] === "}") depth--
    body += source[i++]
  }
  const suppliesCircuit = packages.some(p => /\{[^}]*\bcircuitikz\b/.test(p))
  return String.raw`\documentclass[border=6pt]{standalone}
\usepackage{amsmath,amssymb}
` + (unicode ? String.raw`\usepackage{fontspec}
\IfFontExistsTF{Times New Roman}{\setmainfont{Times New Roman}}{}
` + (engine === "xelatex" ? "\\usepackage{xeCJK}\n\\IfFontExistsTF{SimSun}{\\setCJKmainfont{SimSun}}{}\n" : "\\usepackage{luatexja-fontspec}\n\\IfFontExistsTF{SimSun}{\\setmainjfont{SimSun}}{}\n") : "") +
    (circuit && !suppliesCircuit ? "\\usepackage{circuitikz}\n" : "\\usepackage{tikz}\n") + packages.join("\n") + "\n" +
    "\\usetikzlibrary{arrows.meta,calc,positioning,angles,quotes,decorations.markings}\n" +
    "\\begin{document}\n" + body + "\n\\end{document}\n"
}

/** Typed local compiler. No shell command strings, no shell escape, bounded runtime. */
export async function compileTikz({ source, engine = "xelatex", includePreview = true, maxDimension = 1600, resourceDirectory, outputPath, overwrite = false, signal }) {
  signal?.throwIfAborted()
  if (!engines.has(engine) || typeof source !== "string" || source.length > 1200 * 1024) throw Error("Invalid compiler input.")
  if (resourceDirectory && !isAbsolute(resourceDirectory)) throw Error("resourceDirectory must be absolute.")
  if (outputPath && (!isAbsolute(outputPath) || !/\.pdf$/i.test(outputPath))) throw Error("outputPath must be an absolute .pdf path.")
  if (!Number.isInteger(maxDimension) || maxDimension < 128 || maxDimension > 2048) throw Error("Invalid preview size.")
  if (resourceDirectory && !(await stat(resourceDirectory)).isDirectory()) throw Error("resourceDirectory must be an existing directory.")
  if (outputPath && !overwrite) {
    const existing = await stat(outputPath).then(() => true, error => { if (error.code === "ENOENT") return false; throw error })
    if (existing) throw Object.assign(new Error(`Output file already exists: ${outputPath}. Set overwrite=true to replace it.`), { code: "output_exists" })
  }
  const started = performance.now()
  const directory = await mkdtemp(join(tmpdir(), "tikz-designer-"))
  const content = standaloneDocument(source, engine)
  const result = { engine, sourceSha256: createHash("sha256").update(source).digest("hex"), success: false, renderer: "TeX", diagnostics: "" }
  try {
    await writeFile(join(directory, "diagram.tex"), content, "utf8")
    const env = { ...process.env, ...(resourceDirectory ? { TEXINPUTS: resolve(resourceDirectory) + "//" + delimiter + (process.env.TEXINPUTS || "") } : {}) }
    try {
      await execute(engine, ["-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "diagram.tex"], { cwd: directory, env, signal, timeout: 45000, maxBuffer: 2 * 1024 * 1024, windowsHide: true })
      result.success = true
    } catch (error) {
      result.errorCode = signal?.aborted ? "cancelled" : error.code === "ENOENT" ? "compiler_not_found" : error.killed ? "compile_timeout" : "compile_failed"
      result.diagnostics = error.code === "ENOENT" ? `Compiler not found: ${engine}. Install TeX or add it to the MCP server's PATH.` : boundedLog(error.stdout || error.stderr || error.message)
      return result
    }
    result.compileMs = Math.round(performance.now() - started)
    signal?.throwIfAborted()
    const log = await readFile(join(directory, "diagram.log"), "utf8").catch(() => "")
    result.diagnostics = boundedLog(log.split(/\r?\n/).filter(line => /Warning|Overfull|Underfull|Missing character|Undefined/.test(line)).join("\n"))
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true })
      await writeFile(outputPath, await readFile(join(directory, "diagram.pdf")), { flag: overwrite ? "w" : "wx" })
      result.outputPath = resolve(outputPath)
    }
    if (includePreview) {
      try {
        await execute("pdftoppm", ["-f", "1", "-l", "1", "-singlefile", "-scale-to", String(maxDimension), "-png", "diagram.pdf", "preview"], { cwd: directory, signal, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true })
        result.preview = (await readFile(join(directory, "preview.png"))).toString("base64")
        result.previewPage = 1
      } catch (error) {
        if (signal?.aborted) { result.success = false; result.errorCode = "cancelled" }
        result.previewWarning = "PDF compiled, but PNG preview is unavailable: " + boundedLog(error.message)
      }
    }
    return result
  } finally {
    result.durationMs = Math.round(performance.now() - started)
    const resolved = resolve(directory), prefix = resolve(tmpdir()) + sep + "tikz-designer-"
    if (!resolved.startsWith(prefix)) throw Error("Refusing to remove a compiler directory outside its temporary root.")
    await rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}
