import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { WebSessions } from "../lib/web-sessions.js";
import { WebRpc } from "../lib/web-rpc.js";
import type { RpcSpawn } from "../lib/web-rpc.js";
import { object, string } from "../lib/web-types.js";
import type { WebEvent } from "../lib/web-types.js";
import { dashboardHtml, dashboardCss } from "../ui/web-view.js";

export async function startWebServer(options: { cwd: string; agentDir: string; launcher: string; version: string; port?: number; sessionDir?: string; rpcSpawn?: RpcSpawn }) {
  const token = randomBytes(32).toString("base64url"), sessions = new WebSessions(options.agentDir, options.sessionDir);
  const streams = new Set<ServerResponse>(); let origin = "", stopping = false, disconnected: ReturnType<typeof setTimeout> | undefined;
  const emit = (event: WebEvent) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      if (stream.destroyed || stream.writableLength > 16 * 1024 * 1024) { stream.destroy(); continue; }
      stream.write(line);
    }
  };
  const rpc = new WebRpc({ ...options, sessions, emit, spawn: options.rpcSpawn });
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }); response.end(JSON.stringify(value));
  };
  const body = async (request: IncomingMessage) => {
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") throw new Error("Send JSON with Content-Type: application/json.");
    if (Number(request.headers["content-length"]) > 512_000) { request.resume(); throw new Error("Request exceeds 512,000 bytes."); }
    const chunks: Buffer[] = []; let length = 0;
    for await (const chunk of request) { length += chunk.length; if (length > 512_000) throw new Error("Request exceeds 512,000 bytes."); chunks.push(Buffer.from(chunk)); }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  };
  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Referrer-Policy", "no-referrer"); response.setHeader("X-Frame-Options", "DENY");
      response.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
      if (request.headers.host !== new URL(origin).host || request.headers.origin && request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") {
        json(response, 403, { error: "Use the local dashboard address printed by pi ui." }); return;
      }
      const url = new URL(request.url ?? "/", origin), path = url.pathname;
      if (request.method === "GET" && ["/", "/app.js", "/lib/web-types.js", "/style.css", "/pi.svg"].includes(path)) {
        const data = path === "/" ? dashboardHtml : path === "/style.css" ? dashboardCss : await readFile(new URL(path === "/app.js" ? "../ui/web-client.js" : path === "/lib/web-types.js" ? "../lib/web-types.js" : "../../ui/pi-logo.svg", import.meta.url));
        response.writeHead(200, { "Content-Type": path === "/" ? "text/html; charset=utf-8" : path.endsWith(".js") ? "text/javascript; charset=utf-8" : path === "/style.css" ? "text/css; charset=utf-8" : "image/svg+xml" }); response.end(data); return;
      }
      if (!path.startsWith("/api/")) { json(response, 404, { error: "Not found." }); return; }
      const supplied = request.headers.authorization?.replace(/^Bearer /, "") ?? "";
      const suppliedBytes = Buffer.from(supplied), tokenBytes = Buffer.from(token);
      if (suppliedBytes.length !== tokenBytes.length || !timingSafeEqual(suppliedBytes, tokenBytes)) { json(response, 401, { error: "Reopen the complete dashboard URL printed by pi ui." }); return; }
      if (request.method === "GET" && path === "/api/events") {
        if (streams.size >= 6) { json(response, 429, { error: "Close an extra dashboard tab before opening another." }); return; }
        if (disconnected) clearTimeout(disconnected); disconnected = undefined;
        response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        response.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`); streams.add(response);
        const heartbeat = setInterval(() => { if (!response.destroyed) response.write(": keepalive\n\n"); }, 15_000); heartbeat.unref();
        response.on("close", () => {
          clearInterval(heartbeat); streams.delete(response);
          if (!stopping && streams.size === 0) disconnected = setTimeout(() => {
            if (rpc.current?.busy || rpc.current?.dialogs.length) void rpc.abort(rpc.current.engineId).catch(() => {});
          }, 10_000);
        });
        return;
      }
      if (request.method === "GET" && path === "/api/overview") {
        if (url.searchParams.get("refresh") === "1") sessions.invalidate();
        const catalog = await sessions.list(), query = (url.searchParams.get("q") ?? "").slice(0, 500).toLowerCase();
        const current = rpc.current?.chat;
        const all = current ? [current, ...catalog.chats.filter(chat => chat.id !== current.id)] : catalog.chats;
        const chats = all.filter(chat => `${chat.title}\n${chat.preview}\n${chat.cwd}`.toLowerCase().includes(query));
        json(response, 200, { version: options.version, cwd: options.cwd, chats, skipped: catalog.skipped, active: rpc.current?.chat.id }); return;
      }
      if (request.method === "GET" && path === "/api/state") { json(response, 200, rpc.current ?? null); return; }
      if (request.method === "GET" && path.startsWith("/api/chats/")) {
        json(response, 200, await sessions.history(path.slice("/api/chats/".length))); return;
      }
      if (request.method !== "POST") { json(response, 405, { error: "Use a supported GET or POST endpoint." }); return; }
      const input = await body(request), engineId = string(input.engineId);
      if (path === "/api/open") {
        if (input.id !== undefined && (typeof input.id !== "string" || !/^[a-f0-9]{32}$/.test(input.id))) throw new Error("Unknown chat.");
        if (input.cwd !== undefined && typeof input.cwd !== "string") throw new Error("Invalid project directory.");
        const cwd = string(input.cwd);
        if (cwd.length > 4000 || /[\x00-\x1f]/.test(cwd)) throw new Error("Invalid project directory.");
        json(response, 200, await rpc.open(typeof input.id === "string" ? input.id : undefined, cwd || undefined));
      } else if (path === "/api/prompt") json(response, 200, await rpc.prompt(engineId, string(input.text)));
      else if (path === "/api/abort") { await rpc.abort(engineId); json(response, 200, { stopped: true }); }
      else if (path === "/api/answer") { rpc.answer(engineId, input); json(response, 200, { answered: true }); }
      else if (path === "/api/models") json(response, 200, await rpc.models(engineId));
      else if (path === "/api/levels") json(response, 200, await rpc.levels(engineId));
      else if (path === "/api/configure") json(response, 200, await rpc.configure(engineId, input));
      else { json(response, 404, { error: "Not found." }); }
    })().catch(error => {
      if (response.headersSent || response.destroyed) { response.end(); return; }
      const message = error instanceof Error ? error.message : "The dashboard request failed.";
      json(response, /Unknown chat|outside the active profile|Session links/.test(message) ? 404 : /exceeds/.test(message) ? 413 : /current reply|no longer active|already opening|finish before/.test(message) ? 409 : 400, { error: message });
    });
  });
  server.requestTimeout = 620_000; server.headersTimeout = 10_000; server.keepAliveTimeout = 5000;
  await new Promise<void>((accept, reject) => {
    server.once("error", reject); server.listen(options.port ?? 0, "127.0.0.1", () => { server.off("error", reject); accept(); });
  });
  const address = server.address(); if (!address || typeof address === "string") throw new Error("No local dashboard address.");
  origin = `http://127.0.0.1:${address.port}`;
  return { origin, url: `${origin}/#${token}`, token, sessions, rpc,
    async close() {
      if (stopping) return; stopping = true;
      if (disconnected) clearTimeout(disconnected);
      for (const stream of streams) stream.destroy(); streams.clear();
      await rpc.stop();
      await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); });
    },
  };
}
