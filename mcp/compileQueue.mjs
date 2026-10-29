import { performance } from "node:perf_hooks"

/** Bound local TeX processes; queued cancellations must never start a compiler. */
export function createCompileQueue({ concurrency = 2, maxQueued = 8 } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || !Number.isInteger(maxQueued) || maxQueued < 0) throw Error("Invalid compile queue limits.")
  let active = 0
  const waiting = []
  return async function schedule(task, signal) {
    signal?.throwIfAborted()
    const started = performance.now()
    await new Promise((resolve, reject) => {
      const entry = {
        start() {
          signal?.removeEventListener("abort", entry.cancel)
          active++
          resolve()
        },
        cancel() {
          const index = waiting.indexOf(entry)
          if (index < 0) return
          waiting.splice(index, 1)
          reject(signal.reason)
        },
      }
      if (active < concurrency) entry.start()
      else if (waiting.length >= maxQueued) reject(Object.assign(new Error("TeX compiler queue is full. Wait for an existing compile to finish before retrying."), { code: "queue_full" }))
      else { waiting.push(entry); signal?.addEventListener("abort", entry.cancel, { once: true }) }
    })
    const queueWaitMs = Math.round(performance.now() - started)
    try {
      signal?.throwIfAborted()
      return { result: await task(), queueWaitMs }
    } finally {
      active--
      waiting.shift()?.start()
    }
  }
}
