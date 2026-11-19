#!/usr/bin/env node
// Panel web local: npm run panel → http://localhost:3737 (solo accesible desde esta Mac)
import http from "http"
import fs from "fs"
import path from "path"
import { exec } from "child_process"
import { ROOT, DATOS_DIR, CUIT, PTO_VTA, EMISOR, PRECIO_INCLUYE_IVA, IS_DEMO } from "./config.js"
import { prepararLote, emitirLote, editarFila, omitirFila, emitirNotaCredito, listarArchivos, detalleArchivo, rutaArchivo, cargarArchivo, historial, rutaPdf, libroResultado, probarConexion, ambiente, publica, resumir } from "./motor.js"

const PORT = Number(process.env.PORT || 3737)
const MAX_EXCEL = 10 * 1024 * 1024
const lotes = new Map()

const json = (res, code, data) => { res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(data)) }
const loteJson = (l) => ({ id: l.id, archivoId: l.archivoId, nombre: l.nombre, avisos: l.avisos, filas: l.filas.map(publica), resumen: resumir(l.filas) })

function leerCuerpo(req) {
  return new Promise((ok, fail) => {
    const chunks = []; let size = 0
    req.on("data", (c) => { size += c.length; if (size > MAX_EXCEL) { fail(new Error("El archivo es demasiado grande (máx. 10 MB)")); req.destroy() } else chunks.push(c) })
    req.on("end", () => ok(Buffer.concat(chunks)))
    req.on("error", fail)
  })
}

const rutas = {
  "GET /": (req, res) => { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); fs.createReadStream(path.join(ROOT, "public", "index.html")).pipe(res) },
  "GET /img/garage.jpg": (req, res) => { res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "max-age=86400" }); fs.createReadStream(path.join(ROOT, "public", "img", "garage.jpg")).pipe(res) },
  "GET /favicon.svg": (req, res) => { res.writeHead(200, { "Content-Type": "image/svg+xml" }); res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#000"/><path d="M10 7h13v4h-8.5v3h7.5v4h-7.5v3h8.5v4H10z" fill="#976CF6"/></svg>') },
  "GET /api/estado": (req, res) => json(res, 200, { ...ambiente(), cuit: CUIT, ptoVta: PTO_VTA, nombre: EMISOR.nombreComercial, razonSocial: EMISOR.razonSocial, precioIncluyeIva: PRECIO_INCLUYE_IVA }),
  "POST /api/probar": async (req, res) => json(res, 200, await probarConexion()),
  "GET /api/historial": (req, res) => json(res, 200, historial()),
  "GET /api/archivos": (req, res) => json(res, 200, listarArchivos()),
  // Solo demo: carga el Excel de ejemplo como si lo hubieras soltado en el panel
  "POST /api/lotes/ejemplo": async (req, res) => {
    if (!IS_DEMO) return json(res, 403, { error: "Solo disponible en modo demo" })
    const dir = path.join(ROOT, "ejemplo")
    const archivo = fs.readdirSync(dir).find((f) => f.endsWith(".xlsx"))
    if (!archivo) return json(res, 404, { error: "No hay ningún Excel en la carpeta ejemplo/" })
    const lote = await prepararLote(path.join(dir, archivo), archivo.replace(" (ejemplo)", ""))
    lotes.set(lote.id, lote)
    json(res, 200, loteJson(lote))
  },
  "POST /api/lotes": async (req, res) => {
    const nombre = decodeURIComponent(req.headers["x-nombre"] || "archivo.xlsx").replace(/[/\\]/g, "_")
    if (!/\.xlsx$/i.test(nombre)) return json(res, 400, { error: "Tiene que ser un archivo .xlsx" })
    const buf = await leerCuerpo(req)
    const dir = path.join(DATOS_DIR, "subidas"); fs.mkdirSync(dir, { recursive: true })
    const tmp = path.join(dir, `${Date.now()}-${nombre}`)
    fs.writeFileSync(tmp, buf)
    const lote = await prepararLote(tmp, nombre)
    lotes.set(lote.id, lote)
    json(res, 200, loteJson(lote))
  },
}

async function emitir(req, res, id) {
  const lote = lotes.get(id)
  if (!lote) return json(res, 404, { error: "Ese Excel ya no está cargado. Volvé a subirlo." })
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-cache" })
  const send = (o) => res.write(JSON.stringify(o) + "\n")
  try { send({ tipo: "fin", resumen: await emitirLote(lote, send) }) } catch (err) { send({ tipo: "error", error: err.message }) }
  res.end()
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost")
  try {
    const ruta = rutas[`${req.method} ${url.pathname}`]
    if (ruta) return await ruta(req, res)
    let m
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/lotes\/([a-f0-9-]+)\/emitir$/))) return await emitir(req, res, m[1])
    if (req.method === "POST" && (m = url.pathname.match(/^\/api\/lotes\/([a-f0-9-]+)\/filas\/(\d+)$/))) {
      const lote = lotes.get(m[1])
      if (!lote) return json(res, 404, { error: "Ese Excel ya no está cargado. Volvé a subirlo." })
      const body = JSON.parse((await leerCuerpo(req)).toString("utf8") || "{}")
      if ("omitir" in body) omitirFila(lote, m[2], !!body.omitir)
      else await editarFila(lote, m[2], body)
      return json(res, 200, loteJson(lote))
    }
    if ((m = url.pathname.match(/^\/api\/archivos\/([a-z0-9-]+)(?:\/(original|resultado|cargar))?$/))) {
      const [, id, accion] = m
      if (req.method === "POST" && accion === "cargar") { const lote = await cargarArchivo(id); lotes.set(lote.id, lote); return json(res, 200, loteJson(lote)) }
      if (req.method === "GET" && !accion) { const d = detalleArchivo(id); return d ? json(res, 200, d) : json(res, 404, { error: "Ese archivo no existe" }) }
      if (req.method === "GET") {
        const p = rutaArchivo(id, accion), d = detalleArchivo(id)
        if (!p) return json(res, 404, { error: accion === "resultado" ? "Ese archivo todavía no se emitió" : "No encuentro la copia" })
        const nombre = accion === "original" ? d.nombre : `resultado-${d.nombre}`
        res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(nombre)}` })
        return fs.createReadStream(p).pipe(res)
      }
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/api\/lotes\/([a-f0-9-]+)\/resultado$/))) {
      const lote = lotes.get(m[1])
      if (!lote) return json(res, 404, { error: "Ese Excel ya no está cargado." })
      const buf = await (await libroResultado(lote.filas)).xlsx.writeBuffer()
      res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="resultado-${encodeURIComponent(lote.nombre)}"` })
      return res.end(Buffer.from(buf))
    }
    if (req.method === "GET" && (m = url.pathname.match(/^\/fonts\/(Inter_24pt-[A-Za-z]+\.woff2)$/))) {
      const p = path.join(ROOT, "public", "fonts", m[1])
      if (!fs.existsSync(p)) return json(res, 404, { error: "No existe" })
      res.writeHead(200, { "Content-Type": "font/woff2", "Cache-Control": "max-age=604800" })
      return fs.createReadStream(p).pipe(res)
    }
    if (req.method === "POST" && url.pathname === "/api/nota-credito") {
      const body = JSON.parse((await leerCuerpo(req)).toString("utf8") || "{}")
      return json(res, 200, await emitirNotaCredito(String(body.key || ""), body))
    }
    if (req.method === "GET" && url.pathname === "/api/pdf") {
      const p = rutaPdf(url.searchParams.get("key") || "")
      if (!p) return json(res, 404, { error: "No encuentro ese PDF" })
      res.writeHead(200, { "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${path.basename(p)}"` })
      return fs.createReadStream(p).pipe(res)
    }
    json(res, 404, { error: "No existe" })
  } catch (err) {
    if (!res.headersSent) json(res, 400, { error: err.message, errores: err.errores })
    else res.end()
  }
})

server.listen(PORT, "127.0.0.1", () => {
  const url = `http://localhost:${PORT}`
  console.log(`\nPanel del facturador (${ambiente().ambiente}): ${url}\nDejá esta ventana abierta mientras lo usás. Ctrl+C para cerrarlo.\n`)
  if (process.argv.includes("--abrir")) exec(`open -a Safari ${url}`)
})
