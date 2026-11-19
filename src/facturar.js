#!/usr/bin/env node
// Uso por terminal (el panel web hace lo mismo con botones: npm run panel)
//   npm run facturar -- ~/Downloads/archivo.xlsx            muestra el resumen y pide confirmación
//   npm run facturar -- ~/Downloads/archivo.xlsx --simular  solo muestra el resumen
//   npm run facturar -- ~/Downloads/archivo.xlsx --si       emite sin preguntar
import path from "path"
import readline from "readline/promises"
import { IS_PROD, IS_DEMO, PTO_VTA, CUIT, PRECIO_INCLUYE_IVA } from "./config.js"
import { prepararLote, emitirLote } from "./motor.js"

const c = { red: (s) => `\x1b[31m${s}\x1b[0m`, green: (s) => `\x1b[32m${s}\x1b[0m`, yellow: (s) => `\x1b[33m${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, dim: (s) => `\x1b[2m${s}\x1b[0m` }
const ars = (n) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n)
const pad = (s, n, right) => (right ? String(s ?? "").padStart(n) : String(s ?? "").padEnd(n)).slice(0, n)

async function main() {
  const args = process.argv.slice(2)
  const archivo = args.find((a) => !a.startsWith("--"))
  if (!archivo) { console.log("Uso: npm run facturar -- <archivo.xlsx> [--simular] [--si]"); process.exit(1) }

  const amb = IS_DEMO ? c.yellow("DEMO (ARCA simulado)") : IS_PROD ? c.red("PRODUCCIÓN (facturas reales)") : c.yellow("HOMOLOGACIÓN (pruebas, no valen)")
  console.log(c.bold(`\nFacturador ARCA — ${amb}`))
  console.log(c.dim(`CUIT ${CUIT} · Punto de venta ${PTO_VTA} · Precios ${PRECIO_INCLUYE_IVA ? "CON IVA incluido" : "SIN IVA (se suma 21%)"} · ${path.basename(archivo)}`))

  const lote = await prepararLote(archivo)
  lote.avisos.forEach((a) => console.log(c.yellow(`\n⚠ ${a}`)))
  if (!lote.filas.length) { console.log("\nEl Excel no tiene filas para facturar."); return }

  const linea = (f) => {
    const est = f.estado === "a emitir" ? c.green("a emitir") + (f.receptor?.aviso ? c.yellow(` (${f.receptor.aviso})`) : "") : f.estado === "emitida" ? c.green(`✓ ${f.comprobante} · CAE ${f.cae}`) : f.estado === "error" ? c.red("ERROR: " + f.errores.join("; ")) : c.dim(`${f.estado} ${f.comprobante || ""}`)
    const cliente = f.receptor?.nombre || (f.doc ? "" : "Consumidor Final")
    return `${pad(f.fila, 5)}${pad(f.tipo || "?", 5)}${pad(f.doc || "-", 13)}${pad(cliente, 26)}${pad(f.producto, 26)}${pad(f.cantidad, 7, 1)}${pad(f.total != null ? ars(f.total) : "", 16, 1)}  ${est}`
  }
  console.log("\n" + c.dim(`${pad("Fila", 5)}${pad("Tipo", 5)}${pad("CUIT/DNI", 13)}${pad("Cliente", 26)}${pad("Producto/Servicio", 26)}${pad("Cant.", 7, 1)}${pad("Total", 16, 1)}  Estado`))
  lote.filas.forEach((f) => console.log(linea(f)))
  const r = lote.resumen
  console.log(`\n${c.bold(`${r.aEmitir} factura(s) a emitir por ${ars(r.totalAEmitir)}`)}${r.errores ? c.red(` · ${r.errores} fila(s) con error (no se emiten)`) : ""}`)
  if (!r.aEmitir || args.includes("--simular")) { if (args.includes("--simular")) console.log(c.dim("Modo --simular: no se emitió nada.")); return }

  if (!args.includes("--si")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const resp = (await rl.question(IS_PROD ? `Escribí SI para emitir ${r.aEmitir} factura(s) REALES en ARCA: ` : `¿Emitir ${r.aEmitir} factura(s)? (s/n): `)).trim().toLowerCase()
    rl.close()
    if (IS_PROD ? resp !== "si" && resp !== "sí" : !/^s/.test(resp)) { console.log("Cancelado. No se emitió nada."); return }
  }
  console.log()
  const fin = await emitirLote(lote, (e) => {
    if (e.tipo === "frenado") console.log(c.red(`  ${e.motivo}`))
    else if (["emitida", "error", "pendiente"].includes(e.fila.estado)) console.log(e.fila.estado === "emitida" ? c.green(`✓ Fila ${e.fila.fila}: ${e.fila.comprobante} · ${ars(e.fila.total)} · CAE ${e.fila.cae}`) : c.red(`✗ Fila ${e.fila.fila}: ${e.fila.errores.join("; ")}`))
  })
  console.log(c.bold(`\nListo: ${fin.emitidas} emitida(s) por ${ars(fin.totalEmitido)}.`))
  console.log(`PDFs y resumen en: ${path.dirname(lote.resultado)}`)
}

main().catch((err) => { console.error(c.red(`\nError: ${err.message}`)); process.exit(1) })
