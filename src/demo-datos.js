#!/usr/bin/env node
// npm run demo:datos — llena la DEMO con 3 meses de facturas de ejemplo (sep–nov 2026) y sus PDFs.
// Solo toca los datos de la demo (datos/registro-demo-*.json y facturas-demo/); nunca los reales.
process.env.ARCA_ENV = "demo"
const fs = await import("fs"), path = await import("path"), crypto = await import("crypto")
const { DATOS_DIR, FACTURAS_DIR, CUIT, PTO_VTA, CBTE_TIPO, COND_IVA, COND_IVA_LABEL } = await import("./config.js")
const { calcularImportes } = await import("./excel.js")
const { consultarCuit } = await import("./padron.js")
const { generarPdf } = await import("./pdf.js")
const { libroResultado, nroCbte } = await import("./motor.js")
const ExcelJS = (await import("exceljs")).default

const MESES = [["2026", "09", "septiembre"], ["2026", "10", "octubre"], ["2026", "11", "noviembre"]]
// [tipo, doc, producto, cantidad, precio, día]  — precios sin IVA
const plantilla = (mes, aumento) => [
  ["A", "30712345671", `Cochera mensual ${mes} - 2 camionetas`, 2, Math.round(95000 * aumento), 1],
  ["A", "30719998883", `Cochera mensual ${mes} - 3 autos`, 3, Math.round(85000 * aumento), 1],
  ["A", "30715550012", `Cochera mensual ${mes} - utilitario`, 1, Math.round(110000 * aumento), 2],
  ["A", "33709876541", `Cochera mensual ${mes} - flota`, 5, Math.round(80000 * aumento), 3],
  ["B", "20123456786", `Cochera mensual ${mes}`, 1, Math.round(85000 * aumento), 1],
  ["B", "27287654329", `Cochera mensual ${mes} - moto`, 1, Math.round(40000 * aumento), 2],
  ["B", "20301112220", `Cochera mensual ${mes}`, 1, Math.round(85000 * aumento), 4],
  ["B", "23345678905", "Lavado completo", 2, Math.round(12500 * aumento), 9],
  ["B", "", "Estadía por hora", 6, Math.round(1800 * aumento), 12],
  ["B", "32145678", "Cochera diaria", 3, Math.round(9000 * aumento), 15],
  ["B", "27287654329", "Lavado de motor", 1, Math.round(18000 * aumento), 18],
  ["B", "", "Estadía por día", 2, Math.round(9000 * aumento), 22],
  ["A", "30712345671", "Lavado de flota", 4, Math.round(15000 * aumento), 25],
]

const regPath = path.join(DATOS_DIR, `registro-demo-${CUIT}.json`)
const archPath = path.join(DATOS_DIR, `archivos-demo-${CUIT}.json`)
const copiasDir = path.join(DATOS_DIR, "archivos")
const borrarCopias = () => { if (fs.existsSync(copiasDir)) for (const f of fs.readdirSync(copiasDir)) if (f.startsWith("demo-")) fs.rmSync(path.join(copiasDir, f)) }
if (process.argv.includes("--borrar")) {
  fs.rmSync(regPath, { force: true }); fs.rmSync(archPath, { force: true }); borrarCopias(); fs.rmSync(path.join(DATOS_DIR, "demo-numeros.json"), { force: true }); fs.rmSync(FACTURAS_DIR, { recursive: true, force: true })
  console.log("Demo vaciada."); process.exit(0)
}
const reg = {}, arch = {}, nros = { [CBTE_TIPO.A]: 0, [CBTE_TIPO.B]: 0 }
fs.rmSync(FACTURAS_DIR, { recursive: true, force: true }); borrarCopias(); fs.mkdirSync(copiasDir, { recursive: true })
const HEAD = ["TIPO DE COMPROBANTE A/B", "CUIT", "Producto/Servicio", "Cantidad", "Precio Unitario"]
async function escribirExcel(destino, filas) {
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Hoja1")
  ws.addRow(HEAD); filas.forEach((r) => ws.addRow(r))
  ;[25, 16, 38, 10, 15].forEach((w, i) => (ws.getColumn(i + 1).width = w))
  await wb.xlsx.writeFile(destino)
}
const iso = (anio, mes, dia, h, m) => new Date(Date.UTC(+anio, +mes - 1, dia, h + 3, m)).toISOString() // hora AR → UTC

for (const [anio, mes, nombreMes] of MESES) {
  const aumento = { "09": 1, "10": 1.04, "11": 1.08 }[mes]
  const filasMes = plantilla(nombreMes, aumento).filter(([, , , , , dia]) => mes !== "11" || dia <= 18)
  // Un Excel por cada día que se facturó (la fecha de una factura es el día en que se emite)
  for (const dia of [...new Set(filasMes.map((f) => f[5]))].sort((a, b) => a - b)) {
    const filas = filasMes.filter((f) => f[5] === dia)
    const dd = String(dia).padStart(2, "0")
    const archivo = dia <= 4 ? `Cocheras mensuales ${dd}-${mes}.xlsx` : `Facturacion ${dd}-${mes}.xlsx`
    // El 04-11 traía una Factura A para un monotributista que quedó sin emitir: ese archivo sale "parcial"
    const conError = mes === "11" && dia === 4 ? [["A", "20301112220", "Cochera mensual noviembre - 2do auto", 1, Math.round(85000 * aumento), 4]] : []
    const id = `${anio}${mes}${dd}-${crypto.randomBytes(3).toString("hex")}`, copia = `demo-${id}.xlsx`
    await escribirExcel(path.join(copiasDir, copia), [...filas, ...conError].map(([t, d, p, c, pr]) => [t, d, p, c, pr]))
    // Misma huella que calcula el motor (contenido del archivo): si se vuelve a subir la copia, las filas salen "ya emitidas"
    const huella = crypto.createHash("sha256").update(fs.readFileSync(path.join(copiasDir, copia))).digest("hex").slice(0, 16)
    const hEmision = 9 + (dia % 9), mEmision = (dia * 7) % 60
    const filasResultado = []
    let filaExcel = 1
    for (const [tipo, doc, producto, cantidad, precio] of filas) {
      filaExcel++
      const fecha = `${anio}${mes}${dd}`
      const cbteTipo = CBTE_TIPO[tipo], cbteNro = ++nros[cbteTipo]
      const imp = calcularImportes(cantidad, precio)
      let receptor = { nombre: "", domicilio: "", docTipo: 99, docNro: 0, condIva: COND_IVA.CONSUMIDOR_FINAL }
      if (doc.length === 11) { const p = await consultarCuit(doc); receptor = { ...p, docTipo: 80, docNro: Number(doc), condIva: p.condIva } }
      else if (doc) receptor = { nombre: "", domicilio: "", docTipo: 96, docNro: Number(doc), condIva: COND_IVA.CONSUMIDOR_FINAL }
      const vto = new Date(Date.UTC(+anio, +mes - 1, dia + 10)).toISOString().slice(0, 10).replace(/-/g, "")
      const cae = String(76000000000000 + Math.floor(Math.random() * 1e12))
      const dir = `${anio}-${mes}-${dd}`
      const pdf = path.join(dir, `Factura-${tipo}-${String(PTO_VTA).padStart(5, "0")}-${String(cbteNro).padStart(8, "0")}.pdf`)
      fs.mkdirSync(path.join(FACTURAS_DIR, dir), { recursive: true })
      await generarPdf({ tipo, cbteTipo, ptoVta: PTO_VTA, cbteNro, fecha, cae, caeVto: vto, docTipo: receptor.docTipo, docNro: receptor.docNro, receptor: { ...receptor, condIvaLabel: COND_IVA_LABEL[receptor.condIva] }, producto, cantidad, precio, ...imp }, path.join(FACTURAS_DIR, pdf))
      filasResultado.push({ fila: filaExcel, tipo, doc, receptor, producto, cantidad, precio, ...imp, estado: "emitida", comprobante: nroCbte(tipo, cbteNro), cae, caeVto: vto, pdf: path.join(FACTURAS_DIR, pdf) })
      reg[`${huella}:${filaExcel}`] = { estado: "emitida", loteId: huella, archivoId: id, archivo, fila: filaExcel, tipo, cbteNro, docNro: String(receptor.docNro), doc, nombre: receptor.nombre, producto, cantidad, ...imp, cae, caeVto: vto, fecha, pdf, emitidaEn: iso(anio, mes, dia, hEmision, mEmision + filaExcel) }
    }
    for (const [tipo, doc, producto, cantidad, precio] of conError) filasResultado.push({ fila: ++filaExcel, tipo, doc, receptor: { nombre: "RODRIGUEZ JUAN PABLO" }, producto, cantidad, precio, estado: "error", errores: ["no es Responsable Inscripto (Responsable Monotributo) → corresponde Factura B"] })
    const resultado = path.join(`${anio}-${mes}-${dd}`, `resultado-${archivo.replace(/\.xlsx$/, "")}-${String(hEmision).padStart(2, "0")}${String(mEmision).padStart(2, "0")}.xlsx`)
    await (await libroResultado(filasResultado)).xlsx.writeFile(path.join(FACTURAS_DIR, resultado))
    const ok = filasResultado.filter((f) => f.estado === "emitida")
    const subido = iso(anio, mes, dia, hEmision, Math.max(0, mEmision - 4)), fin = iso(anio, mes, dia, hEmision, mEmision + filaExcel)
    arch[id] = { id, huella, nombre: archivo, copia, subidoEn: subido, ultimaSubida: subido, ultimaActividad: fin, subidas: 1, filas: filasResultado.length,
      previa: { aEmitir: ok.length, totalAEmitir: Math.round(ok.reduce((s, f) => s + f.total, 0) * 100) / 100, errores: conError.length, yaEmitidas: 0 },
      emisiones: [{ inicio: iso(anio, mes, dia, hEmision, mEmision), fin, emitidas: ok.length, total: Math.round(ok.reduce((s, f) => s + f.total, 0) * 100) / 100, errores: conError.length, omitidas: 0, editadas: mes === "10" && dia === 12 ? 1 : 0, pendientes: 0, resultado }] }
  }
}
fs.mkdirSync(DATOS_DIR, { recursive: true })
// Un borrador que se subió, se miró y nunca se emitió
{
  const id = "20261110-b0rr4d", copia = `demo-${id}.xlsx`
  await escribirExcel(path.join(copiasDir, copia), [["B", "20123456786", "Lavado completo", 1, 13500], ["B", "", "Estadía por hora", 3, 1950], ["A", "30712345671", "Lavado de flota", 2, 16200]])
  arch[id] = { id, huella: crypto.createHash("sha256").update(fs.readFileSync(path.join(copiasDir, copia))).digest("hex").slice(0, 16), nombre: "Facturacion lavados (borrador).xlsx", copia, subidoEn: iso(2026, 11, 10, 18, 42), ultimaSubida: iso(2026, 11, 10, 18, 42), ultimaActividad: iso(2026, 11, 10, 18, 42), subidas: 1, filas: 3, emisiones: [], previa: { aEmitir: 3, totalAEmitir: 72721.5, errores: 0, yaEmitidas: 0 } }
}
fs.writeFileSync(archPath, JSON.stringify(arch, null, 2))
fs.writeFileSync(regPath, JSON.stringify(reg, null, 2))
fs.writeFileSync(path.join(DATOS_DIR, "demo-numeros.json"), JSON.stringify(nros))
const l = Object.values(reg)
console.log(`Demo cargada: ${l.length} facturas (${l.filter((e) => e.tipo === "A").length} A, ${l.filter((e) => e.tipo === "B").length} B) por ${new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" }).format(l.reduce((s, e) => s + e.total, 0))}`)

// Una nota de crédito de ejemplo: el lavado de motor del 18/10 se había facturado dos veces
{
  const { emitirNotaCredito } = await import("./motor.js")
  const key = Object.entries(reg).find(([, e]) => e.fecha === "20261018" && e.producto === "Lavado de motor")?.[0]
  if (key) await emitirNotaCredito(key, { modo: "total", motivo: "Se facturó dos veces el mismo lavado" })
}
