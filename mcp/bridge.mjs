import http from "node:http"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { WebSocketServer, WebSocket } from "ws"

const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])

/** The browser bridge is deliberately separate from the MCP stdio transport. */
export async function createBridge({ port = 3210, appUrl = "http://localhost:1234/", timeout = 30000 } = {}) {
  const application = new URL(appUrl)
  if (application.protocol !== "http:" || !loopback.has(application.hostname) || application.username || application.password) {
    throw new Error("MCP_APP_URL must be a local http://localhost or http://127.0.0.1 URL.")
  }
  const token = randomBytes(32).toString("hex")
  const sessions = new Map()
  const pending = new Map()
  const origins = new Set([application.origin])
  for (const hostname of ["localhost", "127.0.0.1"]) {
    const alias = new URL(application)
    alias.hostname = hostname
    origins.add(alias.origin)
  }
  const httpServer = http.createServer((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" })
    res.end("Use an MCP stdio client to connect to CircuiTikZ Designer.\n")
  })
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
    handleProtocols: () => "circuitikz",
  })
  httpServer.on("upgrade", (req, socket, head) => {
    const credentials = String(req.headers["sec-websocket-protocol"] || "").split(",").map(s => s.trim())
    const supplied = Buffer.from(credentials[1] || "")
    const valid = credentials[0] === "circuitikz" && supplied.length === token.length &&
      timingSafeEqual(supplied, Buffer.from(token))
    const address = httpServer.address()
    if (req.url !== "/bridge" || req.headers.host !== `127.0.0.1:${address.port}` ||
        !origins.has(req.headers.origin) || !valid) {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      return
    }
    sockets.handleUpgrade(req, socket, head, ws => sockets.emit("connection", ws))
  })

  function rejectPending(sessionId, message) {
    for (const [id, item] of pending) {
      if (item.sessionId !== sessionId) continue
      clearTimeout(item.timer)
      pending.delete(id)
      item.reject(new Error(message))
    }
  }
  sockets.on("connection", ws => {
    const sessionId = randomUUID()
    let registered = false
    ws.alive = true
    const greetingTimeout = setTimeout(() => ws.close(1008, "Missing hello"), 10000)
    ws.on("pong", () => { ws.alive = true })
    ws.on("error", () => {})
    ws.on("message", data => {
      let message
      try { message = JSON.parse(data.toString()) } catch { ws.close(1008, "Invalid JSON"); return }
      if (!message || typeof message !== "object" || Array.isArray(message)) { ws.close(1008, "Invalid message"); return }
      if (!registered) {
        if (message.type !== "hello" || message.version !== 1) { ws.close(1008, "Invalid hello"); return }
        clearTimeout(greetingTimeout)
        registered = true
        sessions.set(sessionId, { ws, sessionId, title: String(message.title || "Untitled").slice(0, 256), connectedAt: new Date().toISOString() })
        ws.send(JSON.stringify({ type: "welcome", sessionId }))
        return
      }
      if (message.type !== "result" || typeof message.id !== "string") return
      const item = pending.get(message.id)
      if (!item || item.sessionId !== sessionId) return
      clearTimeout(item.timer)
      pending.delete(message.id)
      if (typeof message.title === "string") sessions.get(sessionId).title = message.title.slice(0, 256)
      if (message.error) item.reject(new Error(String(message.error)))
      else item.resolve(message.result)
    })
    ws.on("close", () => {
      clearTimeout(greetingTimeout)
      sessions.delete(sessionId)
      rejectPending(sessionId, "Browser disconnected. The last operation's outcome may be unknown; reconnect and inspect the document before retrying.")
    })
  })
  const heartbeat = setInterval(() => {
    for (const ws of sockets.clients) {
      if (!ws.alive) { ws.terminate(); continue }
      ws.alive = false
      ws.ping()
    }
  }, 20000)
  heartbeat.unref()

  try {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject)
      httpServer.listen(port, "127.0.0.1", resolve)
    })
  } catch (error) {
    clearInterval(heartbeat)
    throw error
  }
  const actualPort = httpServer.address().port
  const connectUrl = new URL(application)
  connectUrl.searchParams.set("mcpPort", String(actualPort))
  connectUrl.hash = new URLSearchParams({ mcpToken: token }).toString()

  return {
    port: actualPort,
    connectUrl: connectUrl.href,
    status() {
      return {
        connectUrl: connectUrl.href,
        sessions: [...sessions.values()].map(({ ws, ...session }) => session),
        instructions: "Open connectUrl in the browser running npm start, or paste it into the application's MCP dialog. Choose an explicit sessionId; get the document revision before editing. Keep the connection URL private.",
      }
    },
    request(sessionId, method, args = {}) {
      const session = sessions.get(sessionId)
      if (!session || session.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error("Unknown or disconnected sessionId. Call designer_status and connect the browser first."))
      if (pending.size >= 64) return Promise.reject(new Error("Too many pending requests."))
      return new Promise((resolve, reject) => {
        const id = randomUUID()
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error("Browser request timed out. Outcome may be unknown; reconnect and inspect the document before retrying."))
          session.ws.terminate()
        }, timeout)
        pending.set(id, { sessionId, timer, resolve, reject })
        session.ws.send(JSON.stringify({ type: "request", id, method, args }), error => {
          if (!error || !pending.has(id)) return
          clearTimeout(timer)
          pending.delete(id)
          reject(error)
        })
      })
    },
    async close() {
      clearInterval(heartbeat)
      for (const sessionId of sessions.keys()) rejectPending(sessionId, "MCP server stopped.")
      for (const ws of sockets.clients) ws.terminate()
      await new Promise(resolve => sockets.close(resolve))
      await new Promise(resolve => httpServer.close(resolve))
    },
  }
}
