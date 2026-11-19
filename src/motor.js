// Lógica compartida entre la terminal (facturar.js) y el panel web (server.js).
//   prepararLote → lee el Excel, valida, consulta el padrón y deja cada fila "a emitir" / "error" / "ya emitida"
//   emitirLote   → emite fila por fila, avisando cada paso con onEvento
// Registro anti-duplicados: datos/registro-<ambiente>-<cuit>.json (huella del archivo + número de fila).
import fs from "fs"
import path from "path"
import crypto from "crypto"
import ExcelJS from "exceljs"
import { IS_PROD, IS_DEMO, ARCA_ENV, PTO_VTA, CUIT, DATOS_DIR, FACTURAS_DIR, CBTE_TIPO, NC_TIPO, DOC_TIPO, COND_IVA, COND_IVA_LABEL, COND_IVA_B_POR_DEFECTO, assertConfigured } from "./config.js"
import { leerExcel, validarFila, aNumero } from "./excel.js"
import { ultimoAutorizado, solicitarCae, consultar, dummy } from "./wsfe.js"
import { consultarCuit } from "./padron.js"
import { generarPdf } from "./pdf.js"
import { getTA, infoCertificado } from "./wsaa.js"

export const hoyAR = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Argentina/Buenos_Aires" }).format(new Date()).replace(/-/g, "")
export const nroCbte = (tipo, nro) => `${tipo} ${String(PTO_VTA).padStart(5, "0")}-${String(nro).padStart(8, "0")}`
export const comprobanteDe = (e) => `${e.esNC ? "NC " : ""}${nroCbte(e.tipo, e.cbteNro)}`

// ─── Registro ────────────────────────────────────────────────────────────────
const REGISTRO = path.join(DATOS_DIR, `registro-${ARCA_ENV}-${CUIT}.json`)
export const leerRegistro = () => { try { return JSON.parse(fs.readFileSync(REGISTRO, "utf8")) } catch { return {} } }
function guardarRegistro(reg) {
  fs.mkdirSync(DATOS_DIR, { recursive: true })
  fs.writeFileSync(REGISTRO + ".tmp", JSON.stringify(reg, null, 2))
  fs.renameSync(REGISTRO + ".tmp", REGISTRO)
}

// ─── Archivos procesados ─────────────────────────────────────────────────────
// datos/archivos-<ambiente>-<cuit>.json: cada Excel subido, con su copia (datos/archivos/), cuándo se subió, qué dio la
// vista previa y cada emisión (cuándo, cuántas, total y el Excel de resultado).
const ARCHIVOS = path.join(DATOS_DIR, `archivos-${ARCA_ENV}-${CUIT}.json`)
const COPIAS_DIR = path.join(DATOS_DIR, "archivos")
export const leerArchivos = () => { try { return JSON.parse(fs.readFileSync(ARCHIVOS, "utf8")) } catch { return {} } }
function guardarArchivos(a) {
  fs.mkdirSync(DATOS_DIR, { recursive: true })
  fs.writeFileSync(ARCHIVOS + ".tmp", JSON.stringify(a, null, 2))
  fs.renameSync(ARCHIVOS + ".tmp", ARCHIVOS)
}
export function estadoArchivo(a) {
  const em = a.emisiones || []
  if (!em.length) return "sin emitir"
  const emitidas = em.reduce((s, e) => s + e.emitidas, 0)
  if (!emitidas) return "sin emitir"
  const u = em.at(-1)
  return u.pendientes > 0 || u.errores > 0 ? "parcial" : "emitido"
}
const resumenArchivo = (a) => {
  const em = a.emisiones || []
  return { ...a, estado: estadoArchivo(a), emitidas: em.reduce((s, e) => s + e.emitidas, 0), totalEmitido: Math.round(em.reduce((s, e) => s + e.total, 0) * 100) / 100, ultimaEmision: em.at(-1)?.fin || null }
}
export const listarArchivos = () => Object.values(leerArchivos()).map(resumenArchivo).sort((x, y) => String(y.ultimaActividad).localeCompare(String(x.ultimaActividad)))
export function detalleArchivo(id) {
  const a = leerArchivos()[id]
  if (!a) return null
  const facturas = Object.entries(leerRegistro()).filter(([, e]) => e.archivoId === id && !e.esNC && (e.estado === "emitida" || e.estado === "revisar")).map(([key, e]) => ({ key, ...e, comprobante: comprobanteDe(e) })).sort((x, y) => x.fila - y.fila)
  return { ...resumenArchivo(a), facturas }
}
export function rutaArchivo(id, cual) {
  const a = leerArchivos()[id]
  if (!a) return null
  const rel = cual === "original" ? a.copia && path.join(COPIAS_DIR, a.copia) : (a.emisiones || []).filter((e) => e.resultado).at(-1)?.resultado && path.join(FACTURAS_DIR, a.emisiones.filter((e) => e.resultado).at(-1).resultado)
  return rel && fs.existsSync(rel) ? rel : null
}

// Guarda la copia y anota la subida. Si ese mismo Excel (mismo contenido) ya se había subido, se suma a esa entrada.
function registrarSubida(archivo, nombre, huella, filas, resumen, archivoId) {
  const arch = leerArchivos()
  let a = (archivoId && arch[archivoId]) || Object.values(arch).filter((x) => x.huella === huella).sort((x, y) => String(y.ultimaActividad).localeCompare(String(x.ultimaActividad)))[0]
  const ahora = new Date().toISOString()
  if (!a) {
    const id = `${new Date().toISOString().slice(0, 10).replace(/-/g, "")}-${crypto.randomBytes(3).toString("hex")}`
    const copia = `${ARCA_ENV}-${id}.xlsx`
    fs.mkdirSync(COPIAS_DIR, { recursive: true })
    fs.copyFileSync(archivo, path.join(COPIAS_DIR, copia))
    a = arch[id] = { id, huella, nombre, copia, subidoEn: ahora, subidas: 0, filas: filas.length, emisiones: [] }
  }
  Object.assign(a, { subidas: (a.subidas || 0) + 1, ultimaSubida: ahora, ultimaActividad: ahora, previa: { aEmitir: resumen.aEmitir, totalAEmitir: resumen.totalAEmitir, errores: resumen.errores, yaEmitidas: resumen.yaEmitidas } })
  guardarArchivos(arch)
  return a.id
}

export async function cargarArchivo(id) {
  const a = leerArchivos()[id]
  if (!a) throw new Error("Ese archivo no existe")
  const p = path.join(COPIAS_DIR, a.copia)
  if (!fs.existsSync(p)) throw new Error("No encuentro la copia de ese Excel")
  return prepararLote(p, a.nombre, { archivoId: id })
}

export function historial() {
  const reg = leerRegistro()
  return Object.entries(reg).filter(([, e]) => e.estado === "emitida" || e.estado === "revisar").map(([key, e]) => ({ key, ...e, comprobante: comprobanteDe(e), asociadaComprobante: e.esNC && reg[e.asociada] ? comprobanteDe(reg[e.asociada]) : undefined })).sort((a, b) => String(b.emitidaEn || "").localeCompare(String(a.emitidaEn || "")))
}

export function rutaPdf(key) {
  const e = leerRegistro()[key]
  if (!e?.pdf) return null
  const p = path.resolve(FACTURAS_DIR, e.pdf)
  return p.startsWith(FACTURAS_DIR + path.sep) && fs.existsSync(p) ? p : null
}

// Facturas que quedaron "en vuelo" en una corrida anterior (se mandó el pedido y no volvió la respuesta)
async function recuperarPendientes(reg, log) {
  const pend = Object.entries(reg).filter(([, e]) => e.estado === "pendiente")
  for (const [key, e] of pend) {
    const r = await consultar(e.cbteTipo || CBTE_TIPO[e.tipo], e.cbteNro)
    if (r?.cae && String(r.docNro) === String(e.docNro) && Math.abs(r.impTotal - e.total) < 0.01) {
      Object.assign(e, { estado: "emitida", cae: r.cae, caeVto: r.caeVto, fecha: r.fecha, emitidaEn: new Date().toISOString() })
      if (e.esNC && reg[e.asociada]) acreditar(reg[e.asociada], key, e.total)
      log(`${nroCbte(e.tipo, e.cbteNro)} de una corrida anterior sí se emitió (CAE ${r.cae}). Quedó registrada.`)
    } else if (r?.cae) {
      e.estado = "revisar"
      log(`${nroCbte(e.tipo, e.cbteNro)} existe en ARCA con otros datos. Revisala a mano.`)
    } else {
      delete reg[key]
      log(`${nroCbte(e.tipo, e.cbteNro)} de una corrida anterior no llegó a emitirse; esa fila se puede volver a facturar.`)
    }
    guardarRegistro(reg)
  }
}

// ─── Receptor: tipo de documento + condición IVA + nombre ───────────────────
async function resolverReceptor(f, ctx) {
  const cf = { nombre: "", domicilio: "" }
  if (f.tipo === "B" && !f.doc) return { ...cf, docTipo: DOC_TIPO.CONSUMIDOR_FINAL, docNro: "0", condIva: COND_IVA.CONSUMIDOR_FINAL }
  if (f.tipo === "B" && f.doc.length <= 8) return { ...cf, docTipo: DOC_TIPO.DNI, docNro: f.doc, condIva: COND_IVA.CONSUMIDOR_FINAL }
  const base = { ...cf, docTipo: DOC_TIPO.CUIT, docNro: f.doc }
  let p = null
  if (ctx.padronDisponible) {
    try { p = await consultarCuit(f.doc) } catch (err) {
      if (/^\[padrón\] CUIT/.test(err.message)) return { ...base, error: err.message.replace("[padrón] ", "") + " en el padrón de ARCA" }
      ctx.padronDisponible = false
      ctx.avisos.push(`No se pudo consultar el padrón de ARCA (${err.message}). Las facturas salen sin el nombre del cliente: A → Resp. Inscripto, B con CUIT → ${COND_IVA_LABEL[COND_IVA_B_POR_DEFECTO]}.`)
    }
  }
  if (!p) return { ...base, condIva: f.tipo === "A" ? COND_IVA.RI : COND_IVA_B_POR_DEFECTO, aviso: "sin padrón" }
  const r = { ...base, nombre: p.nombre, domicilio: p.domicilio }
  if (f.tipo === "A") return p.condIva === COND_IVA.RI ? { ...r, condIva: COND_IVA.RI } : { ...r, error: `no es Responsable Inscripto (${COND_IVA_LABEL[p.condIva] || "sin IVA"}) → corresponde Factura B` }
  if (p.condIva === COND_IVA.RI) return { ...r, error: "es Responsable Inscripto → corresponde Factura A" }
  return { ...r, condIva: p.condIva || COND_IVA.CONSUMIDOR_FINAL }
}

// ─── Preparar ────────────────────────────────────────────────────────────────
export async function prepararLote(archivo, nombre = path.basename(archivo), { archivoId: idExistente } = {}) {
  assertConfigured()
  const huella = crypto.createHash("sha256").update(fs.readFileSync(archivo)).digest("hex").slice(0, 16)
  const filas = await leerExcel(archivo)
  const reg = leerRegistro()
  const avisos = []
  await recuperarPendientes(reg, (m) => avisos.push(m))
  const ctx = { padronDisponible: true, avisos }

  for (const f of filas) {
    f.original = { tipo: f.tipo, cuit: f.doc, producto: f.producto, cantidad: f.cantidad, precio: f.precio }
    f.key = `${huella}:${f.fila}`
    const prev = reg[f.key]
    if (prev && prev.estado !== "error") {
      Object.assign(f, { estado: prev.estado === "emitida" ? "ya emitida" : "revisar", cbteNro: prev.cbteNro, comprobante: nroCbte(prev.tipo, prev.cbteNro), cae: prev.cae, caeVto: prev.caeVto, receptor: { nombre: prev.nombre } })
      continue
    }
    if (f.errores) { f.estado = "error"; continue }
    f.receptor = await resolverReceptor(f, ctx)
    if (f.receptor.error) { f.errores = [f.receptor.error]; f.estado = "error"; continue }
    f.estado = "a emitir"
  }
  // Cada carga tiene su propia vista previa (dos pestañas con el mismo Excel no se pisan las ediciones).
  // El anti-duplicados no depende de esto: usa la huella del archivo + número de fila (f.key).
  const resumen = resumir(filas)
  const archivoId = registrarSubida(archivo, nombre, huella, filas, resumen, idExistente)
  return { id: `${huella}-${crypto.randomBytes(4).toString("hex")}`, huella, archivoId, nombre, filas, avisos, ctx, resumen }
}

export function resumir(filas) {
  const sum = (l) => Math.round(l.reduce((s, f) => s + f.total, 0) * 100) / 100
  const aEmitir = filas.filter((f) => f.estado === "a emitir"), emitidas = filas.filter((f) => f.estado === "emitida")
  return { filas: filas.length, aEmitir: aEmitir.length, totalAEmitir: sum(aEmitir), emitidas: emitidas.length, totalEmitido: sum(emitidas), errores: filas.filter((f) => f.estado === "error").length, yaEmitidas: filas.filter((f) => f.estado === "ya emitida").length, omitidas: filas.filter((f) => f.estado === "omitida").length }
}

// ─── Editar desde la vista previa ────────────────────────────────────────────
const EDITABLE = ["a emitir", "error", "omitida"]

// Solo se guarda si la fila queda válida: si no, tira el error con la lista y la fila queda como estaba.
export async function editarFila(lote, nro, cambios) {
  if (emitiendo) throw new Error("No se puede editar mientras se emite.")
  const f = lote.filas.find((x) => x.fila === Number(nro))
  if (!f) throw new Error("Esa fila no existe")
  if (!EDITABLE.includes(f.estado)) throw new Error("Esa fila ya se emitió; no se puede editar.")
  const v = validarFila(f.fila, { tipo: cambios.tipo, cuit: cambios.cuit, producto: cambios.producto, cantidad: cambios.cantidad, precio: cambios.precio })
  const rechazar = (errores) => { const e = new Error(errores.join(" · ")); e.errores = errores; throw e }
  if (v.errores) rechazar(v.errores)
  const receptor = await resolverReceptor(v, lote.ctx || { padronDisponible: true, avisos: lote.avisos })
  if (receptor.error) rechazar([receptor.error])
  for (const k of ["errores", "neto", "iva", "total", "receptor"]) delete f[k]
  Object.assign(f, v, { receptor, estado: "a emitir" })
  const o = f.original
  f.editada = o.tipo !== f.tipo || o.cuit !== f.doc || o.producto !== f.producto || o.cantidad !== f.cantidad || o.precio !== f.precio
  return f
}

export function omitirFila(lote, nro, omitir) {
  if (emitiendo) throw new Error("No se puede cambiar mientras se emite.")
  const f = lote.filas.find((x) => x.fila === Number(nro))
  if (!f) throw new Error("Esa fila no existe")
  if (omitir) {
    if (f.estado !== "a emitir") throw new Error("Solo se puede omitir una fila lista para emitir.")
    f.estado = "omitida"
  } else if (f.estado === "omitida") f.estado = f.errores ? "error" : "a emitir"
  return f
}

// ─── Nota de crédito ─────────────────────────────────────────────────────────
// Anula total o parcialmente una factura emitida. Como previateapi (emitCreditNote): misma letra (A→3, B→8), numeración
// propia, fecha de hoy y CbtesAsoc con la factura original. Además permite un monto parcial y deja el motivo.
function acreditar(fac, ncKey, total) {
  fac.acreditado = Math.round(((fac.acreditado || 0) + total) * 100) / 100
  fac.notasCredito = [...new Set([...(fac.notasCredito || []), ncKey])]
}
async function condIvaDe(fac) {
  if (fac.condIva) return fac.condIva
  if (fac.tipo === "A") return COND_IVA.RI
  if (!fac.doc || fac.doc.length <= 8) return COND_IVA.CONSUMIDOR_FINAL
  try { return (await consultarCuit(fac.doc)).condIva || COND_IVA.CONSUMIDOR_FINAL } catch { return COND_IVA_B_POR_DEFECTO }
}

export async function emitirNotaCredito(facturaKey, { modo = "total", total: totalPedido, motivo } = {}) {
  if (emitiendo) throw new Error("Hay una emisión en curso. Esperá a que termine.")
  emitiendo = true
  try {
    const reg = leerRegistro()
    const fac = reg[facturaKey]
    if (!fac || fac.esNC) throw new Error("No encuentro esa factura")
    if (fac.estado !== "emitida" || !fac.cae) throw new Error("Esa factura no está emitida")
    const restante = Math.round((fac.total - (fac.acreditado || 0)) * 100) / 100
    if (restante <= 0) throw new Error("Esa factura ya está anulada por completo")
    const pedido = modo === "total" ? restante : Math.round(aNumero(totalPedido) * 100) / 100
    if (!(pedido > 0)) throw new Error("Poné un importe mayor a cero")
    if (pedido > restante + 0.001) throw new Error(`No se puede acreditar más de lo que queda de la factura (${restante.toLocaleString("es-AR", { style: "currency", currency: "ARS" })})`)
    // Anulación total de una factura sin NC previas → mismos importes exactos; si no, se separa el IVA del total pedido
    const exacta = pedido === fac.total && !fac.acreditado
    const neto = exacta ? fac.neto : Math.round((pedido / 1.21) * 100) / 100
    const iva = exacta ? fac.iva : Math.round((pedido - neto) * 100) / 100
    const cbteTipo = NC_TIPO[fac.tipo]
    const docTipo = !fac.doc ? DOC_TIPO.CONSUMIDOR_FINAL : fac.doc.length === 11 ? DOC_TIPO.CUIT : DOC_TIPO.DNI
    const docNro = !fac.doc ? "0" : fac.doc
    const condIva = await condIvaDe(fac)
    const fecha = hoyAR()
    const dia = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`
    const cbteNro = (await ultimoAutorizado(cbteTipo)) + 1
    const ncKey = `nc:${cbteTipo}:${cbteNro}`
    const original = comprobanteDe(fac)
    const detalle = (motivo || "").trim() || (modo === "total" && !fac.acreditado ? `Anulación de la factura ${original}` : `Ajuste sobre la factura ${original}`)
    reg[ncKey] = { estado: "pendiente", esNC: true, asociada: facturaKey, tipo: fac.tipo, cbteTipo, cbteNro, docNro, doc: fac.doc, nombre: fac.nombre, condIva, producto: detalle, cantidad: 1, neto, iva, total: pedido, archivo: fac.archivo, archivoId: fac.archivoId, motivo: (motivo || "").trim() }
    guardarRegistro(reg)
    let r
    try {
      r = await solicitarCae({ cbteTipo, cbteNro, fecha, docTipo, docNro, condIvaReceptor: condIva, neto, iva, total: pedido, cbtesAsoc: [{ tipo: fac.cbteTipo || CBTE_TIPO[fac.tipo], ptoVta: PTO_VTA, nro: fac.cbteNro, cuit: CUIT }] })
    } catch (err) {
      if (!err.sinRespuesta) { delete reg[ncKey]; guardarRegistro(reg); throw err }
      const q = await consultar(cbteTipo, cbteNro).catch(() => undefined)
      if (!q?.cae) { if (q === null) { delete reg[ncKey]; guardarRegistro(reg) } throw new Error(q === null ? err.message : "Se cortó la conexión con ARCA y no se pudo confirmar si salió. Abrí el panel de nuevo en un rato: se verifica solo.") }
      r = { cae: q.cae, caeVto: q.caeVto, cbteNro }
    }
    const pdfRel = path.join(dia, `NotaCredito-${fac.tipo}-${String(PTO_VTA).padStart(5, "0")}-${String(r.cbteNro).padStart(8, "0")}.pdf`)
    fs.mkdirSync(path.join(FACTURAS_DIR, dia), { recursive: true })
    Object.assign(reg[ncKey], { estado: "emitida", cbteNro: r.cbteNro, cae: r.cae, caeVto: r.caeVto, fecha, pdf: pdfRel, emitidaEn: new Date().toISOString() })
    acreditar(fac, ncKey, pedido)
    guardarRegistro(reg)
    await generarPdf({ tipo: fac.tipo, cbteTipo, titulo: "NOTA DE CRÉDITO", asociado: `Factura ${original} del ${fac.fecha.slice(6, 8)}/${fac.fecha.slice(4, 6)}/${fac.fecha.slice(0, 4)}`, ptoVta: PTO_VTA, cbteNro: r.cbteNro, fecha, cae: r.cae, caeVto: r.caeVto, docTipo, docNro: Number(docNro), receptor: { nombre: fac.nombre, condIvaLabel: COND_IVA_LABEL[condIva] }, producto: detalle, cantidad: 1, precio: fac.tipo === "A" ? neto : pedido, neto, iva, total: pedido }, path.join(FACTURAS_DIR, pdfRel))
    return { nc: { key: ncKey, ...reg[ncKey], comprobante: comprobanteDe(reg[ncKey]) }, factura: { key: facturaKey, ...fac, comprobante: original, restante: Math.round((fac.total - fac.acreditado) * 100) / 100 } }
  } finally { emitiendo = false }
}

// ─── Emitir ──────────────────────────────────────────────────────────────────
let emitiendo = false

export async function emitirLote(lote, onEvento = () => {}) {
  if (emitiendo) throw new Error("Ya hay una emisión en curso. Esperá a que termine.")
  emitiendo = true
  try {
    const reg = leerRegistro()
    const fecha = hoyAR()
    const dia = `${fecha.slice(0, 4)}-${fecha.slice(4, 6)}-${fecha.slice(6, 8)}`
    fs.mkdirSync(path.join(FACTURAS_DIR, dia), { recursive: true })
    const aEmitir = lote.filas.filter((f) => f.estado === "a emitir")
    const inicio = new Date().toISOString()

    for (const f of aEmitir) {
      // Si otra pestaña/corrida ya emitió esta fila, no la repetimos
      if (reg[f.key] && reg[f.key].estado !== "error") { f.estado = "ya emitida"; onEvento({ tipo: "fila", fila: publica(f) }); continue }
      const cbteTipo = CBTE_TIPO[f.tipo]
      const { docTipo, docNro, condIva } = f.receptor
      f.estado = "emitiendo"
      onEvento({ tipo: "fila", fila: publica(f) })
      try {
        const cbteNro = (await ultimoAutorizado(cbteTipo)) + 1
        reg[f.key] = { estado: "pendiente", loteId: lote.huella || lote.id, archivoId: lote.archivoId, archivo: lote.nombre, fila: f.fila, tipo: f.tipo, cbteTipo, cbteNro, docNro, condIva, doc: f.doc, nombre: f.receptor.nombre, producto: f.producto, cantidad: f.cantidad, neto: f.neto, iva: f.iva, total: f.total }
        guardarRegistro(reg)
        let r
        try { r = await solicitarCae({ cbteTipo, cbteNro, fecha, docTipo, docNro, condIvaReceptor: condIva, neto: f.neto, iva: f.iva, total: f.total }) } catch (err) {
          if (!err.sinRespuesta) { delete reg[f.key]; guardarRegistro(reg); throw err }
          const q = await consultar(cbteTipo, cbteNro).catch(() => undefined)
          if (q === undefined) {
            f.estado = "pendiente"
            f.errores = ["Se cortó la conexión con ARCA y no se pudo confirmar si salió. Volvé a subir el mismo Excel y se verifica solo."]
            onEvento({ tipo: "fila", fila: publica(f) })
            onEvento({ tipo: "frenado", motivo: "Se cortó la conexión con ARCA." })
            break
          }
          if (!q?.cae) { delete reg[f.key]; guardarRegistro(reg); throw err }
          r = { cae: q.cae, caeVto: q.caeVto, cbteNro, observaciones: [] }
        }
        const pdfRel = path.join(dia, `Factura-${f.tipo}-${String(PTO_VTA).padStart(5, "0")}-${String(r.cbteNro).padStart(8, "0")}.pdf`)
        Object.assign(f, { estado: "emitida", cbteNro: r.cbteNro, comprobante: nroCbte(f.tipo, r.cbteNro), cae: r.cae, caeVto: r.caeVto, observaciones: (r.observaciones || []).map((o) => o.msg) })
        Object.assign(reg[f.key], { estado: "emitida", cbteNro: r.cbteNro, cae: r.cae, caeVto: r.caeVto, fecha, pdf: pdfRel, emitidaEn: new Date().toISOString() })
        guardarRegistro(reg)
        await generarPdf({ ...f, cbteTipo, ptoVta: PTO_VTA, fecha, docTipo, docNro: Number(docNro), receptor: { ...f.receptor, condIvaLabel: COND_IVA_LABEL[condIva] } }, path.join(FACTURAS_DIR, pdfRel))
        f.pdf = path.join(FACTURAS_DIR, pdfRel)
        onEvento({ tipo: "fila", fila: publica(f) })
      } catch (err) {
        f.estado = "error"
        f.errores = [err.message]
        onEvento({ tipo: "fila", fila: publica(f) })
        if (/WSAA|certificado|clave privada|\b60[0-3]\b/i.test(err.message)) { onEvento({ tipo: "frenado", motivo: "Problema de autenticación con ARCA: se frenó para no fallar en todas." }); break }
      }
    }
    const r = resumir(lote.filas)
    // Excel de resultado en la carpeta del día + anotación en el historial de archivos
    const base = lote.nombre.replace(/\.xlsx$/i, "").replace(/[^\w áéíóúñÁÉÍÓÚÑ()-]/g, "_")
    const hora = new Intl.DateTimeFormat("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date()).replace(":", "")
    const resultadoRel = path.join(dia, `resultado-${base}-${hora}.xlsx`)
    await (await libroResultado(lote.filas)).xlsx.writeFile(path.join(FACTURAS_DIR, resultadoRel))
    const arch = leerArchivos(), a = arch[lote.archivoId]
    if (a) {
      const emitidasAhora = lote.filas.filter((f) => f.estado === "emitida" && aEmitir.includes(f))
      a.emisiones = [...(a.emisiones || []), { inicio, fin: new Date().toISOString(), emitidas: emitidasAhora.length, total: Math.round(emitidasAhora.reduce((s, f) => s + f.total, 0) * 100) / 100, errores: r.errores, omitidas: r.omitidas, editadas: lote.filas.filter((f) => f.editada).length, pendientes: lote.filas.filter((f) => ["a emitir", "pendiente"].includes(f.estado) || (f.estado === "error" && aEmitir.includes(f))).length, resultado: resultadoRel }]
      a.ultimaActividad = new Date().toISOString()
      guardarArchivos(arch)
    }
    lote.resultado = path.join(FACTURAS_DIR, resultadoRel)
    return r
  } finally { emitiendo = false }
}

// Lo que se manda al navegador (sin datos internos)
export const publica = (f) => ({ key: f.key, fila: f.fila, tipo: f.tipo, doc: f.doc, cliente: f.receptor?.nombre || (f.tipo === "B" && !f.doc ? "Consumidor Final" : ""), aviso: f.receptor?.aviso, producto: f.producto, cantidad: f.cantidad, precio: f.precio, neto: f.neto, iva: f.iva, total: f.total, estado: f.estado, errores: f.errores, comprobante: f.comprobante, cae: f.cae, caeVto: f.caeVto, observaciones: f.observaciones, editada: !!f.editada, original: f.original })

// ─── Excel de resultado ──────────────────────────────────────────────────────
export async function libroResultado(filas) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet("Resultado")
  ws.columns = [["Fila", 6], ["Editada", 8], ["Tipo", 6], ["CUIT/DNI", 14], ["Cliente", 30], ["Producto/Servicio", 30], ["Cantidad", 9], ["Precio Unit.", 13], ["Neto", 13], ["IVA 21%", 12], ["Total", 13], ["Estado", 12], ["Comprobante", 20], ["CAE", 16], ["Vto. CAE", 11], ["PDF / Error", 60]].map(([header, width]) => ({ header, width }))
  ws.getRow(1).font = { bold: true }
  for (const f of filas) ws.addRow([f.fila, f.editada ? "sí" : "", f.tipo, f.doc, f.receptor?.nombre || "", f.producto, f.cantidad, f.precio, f.neto, f.iva, f.total, f.estado, f.comprobante || "", f.cae || "", f.caeVto || "", f.pdf || (f.errores || []).join("; ")])
  ;["H", "I", "J", "K"].forEach((k) => (ws.getColumn(k).numFmt = '"$"#,##0.00'))
  return wb
}

// ─── Chequeo de configuración (npm run probar y botón del panel) ────────────
export async function probarConexion() {
  const pasos = []
  const paso = async (nombre, fn) => {
    try { const detalle = await fn(); pasos.push({ nombre, ok: true, detalle }); return true } catch (err) { pasos.push({ nombre, ok: false, detalle: err.message }); return false }
  }
  if (!(await paso(".env completo", () => { assertConfigured(); return `CUIT ${CUIT} · Punto de venta ${PTO_VTA}` }))) return pasos
  if (!IS_DEMO) await paso("Certificado y clave privada", () => {
    const c = infoCertificado()
    if (c.serial && !c.serial.includes(CUIT)) throw new Error(`El certificado es del ${c.serial}, pero en .env pusiste CUIT ${CUIT}`)
    if (c.hasta < new Date()) throw new Error(`Venció el ${c.hasta.toLocaleDateString("es-AR")} — generá uno nuevo`)
    return `${c.cn} · ${c.serial} · válido hasta ${c.hasta.toLocaleDateString("es-AR")}`
  })
  await paso("Servidores de ARCA", async () => { const d = await dummy(); return `app ${d.app} · db ${d.db} · auth ${d.auth}` })
  const auth = IS_DEMO || (await paso("Autenticación para facturar (wsfe)", async () => `ticket válido hasta ${new Date((await getTA("wsfe")).expirationTime).toLocaleString("es-AR")}`))
  if (auth) for (const t of ["A", "B"]) await paso(`Punto de venta ${PTO_VTA} habilitado para Factura ${t}`, async () => `última emitida: ${await ultimoAutorizado(CBTE_TIPO[t])}`)
  await paso("Padrón de ARCA (nombre y condición IVA de clientes)", async () => `tu CUIT figura como ${(await consultarCuit(CUIT)).nombre}`)
  return pasos
}

export const ambiente = () => ({ ambiente: IS_DEMO ? "demo" : IS_PROD ? "produccion" : "homologacion" })
