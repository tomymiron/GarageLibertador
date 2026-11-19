// Lee el Excel y devuelve una factura por fila. Las columnas se encuentran por el título (no por la letra),
// así que se pueden reordenar o agregar columnas de notas sin romper nada.
import ExcelJS from "exceljs"
import { PRECIO_INCLUYE_IVA } from "./config.js"

const COLUMNAS = {
  tipo: (t) => t.includes("tipo"),
  cuit: (t) => t.includes("cuit") || t.includes("dni") || t.includes("documento"),
  producto: (t) => t.includes("producto") || t.includes("servicio") || t.includes("descrip"),
  cantidad: (t) => t.includes("cantidad"),
  precio: (t) => t.includes("precio") || t.includes("importe"),
}

function valor(cell) {
  let v = cell?.value
  if (v && typeof v === "object") {
    if ("result" in v) v = v.result // fórmula
    else if (v.richText) v = v.richText.map((r) => r.text).join("")
    else if ("text" in v) v = v.text // hipervínculo
  }
  return v ?? null
}

// "1.234,50" / "$ 1234.5" / 1234.5 → 1234.5
export function aNumero(v) {
  if (typeof v === "number") return v
  if (v == null || v === "") return NaN
  let s = String(v).replace(/[^\d.,-]/g, "")
  if (s.includes(",")) s = s.replace(/\./g, "").replace(",", ".")
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "")
  return Number(s)
}

const centavos = (x) => Math.round(x * 100)

export function calcularImportes(cantidad, precio) {
  const bruto = centavos(cantidad * precio)
  let neto, iva
  if (PRECIO_INCLUYE_IVA) { neto = Math.round(bruto / 1.21); iva = bruto - neto }
  else { neto = bruto; iva = Math.round(neto * 0.21) }
  return { neto: neto / 100, iva: iva / 100, total: (neto + iva) / 100 }
}

// Dígito verificador de CUIT
export function cuitValido(c) {
  if (!/^\d{11}$/.test(c)) return false
  const m = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const s = m.reduce((acc, k, i) => acc + k * Number(c[i]), 0)
  let dv = 11 - (s % 11)
  if (dv === 11) dv = 0
  if (dv === 10) dv = 9
  return dv === Number(c[10])
}

export async function leerExcel(archivo) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(archivo)
  const ws = wb.worksheets[0]
  if (!ws) throw new Error("El Excel no tiene hojas")

  const header = ws.getRow(1)
  const col = {}
  header.eachCell((cell, n) => {
    const t = String(valor(cell) ?? "").toLowerCase()
    if (t.startsWith("detalle")) return // columnas de notas
    for (const [k, test] of Object.entries(COLUMNAS)) if (!col[k] && test(t)) { col[k] = n; break }
  })
  const faltan = Object.keys(COLUMNAS).filter((k) => !col[k])
  if (faltan.length) throw new Error(`No encuentro las columnas: ${faltan.join(", ")}. La fila 1 tiene que tener los títulos.`)

  const filas = []
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r)
    const raw = Object.fromEntries(Object.entries(col).map(([k, n]) => [k, valor(row.getCell(n))]))
    if (Object.values(raw).every((v) => v == null || String(v).trim() === "")) continue

    filas.push(validarFila(r, raw))
  }
  return filas
}

// Valida y calcula una fila (se usa al leer el Excel y al editar una fila desde el panel)
export function validarFila(fila, raw) {
  const errores = []
  const tipo = String(raw.tipo ?? "").trim().toUpperCase().replace(/^FACTURA\s*/, "")
  if (!["A", "B"].includes(tipo)) errores.push(`tipo "${raw.tipo ?? ""}" (tiene que ser A o B)`)
  const doc = String(raw.cuit ?? "").replace(/\D/g, "")
  if (tipo === "A" && !cuitValido(doc)) errores.push(`CUIT "${raw.cuit ?? ""}" inválido (Factura A exige CUIT)`)
  if (tipo === "B" && doc && !cuitValido(doc) && !/^\d{7,8}$/.test(doc)) errores.push(`CUIT/DNI "${raw.cuit}" inválido`)
  const producto = String(raw.producto ?? "").trim()
  if (!producto) errores.push("falta Producto/Servicio")
  const cantidad = aNumero(raw.cantidad)
  if (!(cantidad > 0)) errores.push(`cantidad "${raw.cantidad ?? ""}" inválida`)
  const precio = aNumero(raw.precio)
  if (!(precio > 0)) errores.push(`precio "${raw.precio ?? ""}" inválido`)
  return { fila, tipo, doc, producto, cantidad, precio, ...(errores.length ? { errores } : calcularImportes(cantidad, precio)) }
}
