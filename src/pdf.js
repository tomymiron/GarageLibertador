// PDF de la factura (RG 1415) con el QR de validación de ARCA (RG 4892). Basado en previateapi/services/afip/pdfBuilder.js.
import fs from "fs"
import PDFDocument from "pdfkit"
import QRCode from "qrcode"
import { EMISOR, IS_DEMO } from "./config.js"

const INK = "#111111", MUTED = "#666666", BORDER = "#CCCCCC"
const ars = (n) => new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS", minimumFractionDigits: 2 }).format(n)
const num = (n) => new Intl.NumberFormat("es-AR", { maximumFractionDigits: 4 }).format(n)
const fecha = (s) => `${s.slice(6, 8)}/${s.slice(4, 6)}/${s.slice(0, 4)}`

function qrUrl(f) {
  const p = { ver: 1, fecha: `${f.fecha.slice(0, 4)}-${f.fecha.slice(4, 6)}-${f.fecha.slice(6, 8)}`, cuit: Number(EMISOR.cuit), ptoVta: f.ptoVta, tipoCmp: f.cbteTipo, nroCmp: f.cbteNro, importe: f.total, moneda: "PES", ctz: 1, tipoDocRec: f.docTipo, nroDocRec: Number(f.docNro), tipoCodAut: "E", codAut: Number(f.cae) }
  return `https://www.afip.gob.ar/fe/qr/?p=${Buffer.from(JSON.stringify(p)).toString("base64")}`
}

/** f: { tipo 'A'|'B', cbteTipo, ptoVta, cbteNro, fecha, cae, caeVto, docTipo, docNro, receptor:{nombre,domicilio,condIva}, producto, cantidad, precio, neto, iva, total } */
export async function generarPdf(f, destino) {
  const doc = new PDFDocument({ size: "A4", margin: 40 })
  const stream = fs.createWriteStream(destino)
  doc.pipe(stream)
  const L = doc.page.margins.left, W = doc.page.width - L * 2, top = doc.y
  const line = () => { doc.moveTo(L, doc.y).lineTo(L + W, doc.y).lineWidth(0.5).stroke(BORDER); doc.moveDown(0.6) }

  // Cabecera: emisor | letra | datos del comprobante
  const boxW = 64, boxX = L + W / 2 - boxW / 2
  doc.lineWidth(1.5).rect(boxX, top, boxW, boxW).stroke(INK)
  doc.font("Helvetica-Bold").fontSize(44).fillColor(INK).text(f.tipo, boxX, top + 6, { width: boxW, align: "center" })
  doc.fontSize(7).fillColor(MUTED).text(`COD. ${String(f.cbteTipo).padStart(2, "0")}`, boxX, top + 52, { width: boxW, align: "center" })

  const lw = boxX - L - 12
  // Marca: la "E" azul del cartel del garage
  doc.roundedRect(L, top, 30, 30, 4).fill("#1F5FBF")
  doc.font("Helvetica-Bold").fontSize(22).fillColor("#FFFFFF").text("E", L, top + 5, { width: 30, align: "center" })
  doc.font("Helvetica-Bold").fontSize(14).fillColor(INK).text(EMISOR.nombreComercial, L + 40, top + 1, { width: lw - 40 })
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text(EMISOR.razonSocial !== EMISOR.nombreComercial ? EMISOR.razonSocial : "Estacionamiento · Cocheras", L + 40, doc.y, { width: lw - 40 })
  doc.y = Math.max(doc.y, top + 30)
  doc.moveDown(0.6).font("Helvetica").fontSize(8).fillColor(MUTED)
  if (EMISOR.domicilio) doc.text(`Domicilio: ${EMISOR.domicilio}`, { width: lw })
  doc.text(`Condición frente al IVA: ${EMISOR.condIva}`, { width: lw })

  const rx = boxX + boxW + 12, rw = L + W - rx
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(f.titulo || "FACTURA", rx, top, { width: rw })
  doc.moveDown(0.3).font("Helvetica").fontSize(8)
  doc.text(`Punto de Venta: ${String(f.ptoVta).padStart(5, "0")}    Comp. Nro: ${String(f.cbteNro).padStart(8, "0")}`, rx, doc.y, { width: rw })
  doc.text(`Fecha de Emisión: ${fecha(f.fecha)}`, rx, doc.y, { width: rw })
  doc.text(`CUIT: ${EMISOR.cuit}`, rx, doc.y, { width: rw })
  if (EMISOR.iibb) doc.text(`Ingresos Brutos: ${EMISOR.iibb}`, rx, doc.y, { width: rw })
  if (EMISOR.inicioActividad) doc.text(`Inicio de Actividades: ${EMISOR.inicioActividad}`, rx, doc.y, { width: rw })
  doc.y = Math.max(doc.y, top + boxW) + 16
  line()

  // Período / condición de venta
  doc.font("Helvetica").fontSize(8).fillColor(INK)
  doc.text(`Período facturado: ${fecha(f.fecha)} al ${fecha(f.fecha)}    Vto. para el pago: ${fecha(f.fecha)}    Condición de venta: Contado`, L)
  if (f.asociado) doc.moveDown(0.3).font("Helvetica-Bold").text(`Comprobante asociado: ${f.asociado}`, L).font("Helvetica")
  doc.moveDown(0.6)
  line()

  // Receptor
  doc.font("Helvetica-Bold").fontSize(9).text("DATOS DEL RECEPTOR", L).moveDown(0.3).font("Helvetica").fontSize(9)
  if (f.docTipo === 99) doc.text("Consumidor Final", L)
  else {
    doc.text(`${f.docTipo === 80 ? "CUIT" : "DNI"}: ${f.docNro}${f.receptor.nombre ? `    Apellido y Nombre / Razón Social: ${f.receptor.nombre}` : ""}`, L, doc.y, { width: W })
    if (f.receptor.domicilio) doc.text(`Domicilio: ${f.receptor.domicilio}`, L, doc.y, { width: W })
  }
  doc.text(`Condición frente al IVA: ${f.receptor.condIvaLabel}`, L)
  doc.moveDown(0.6)
  line()

  // Detalle — en A los precios van sin IVA; en B con IVA incluido
  const unit = f.tipo === "A" ? f.neto / f.cantidad : f.total / f.cantidad
  const sub = f.tipo === "A" ? f.neto : f.total
  const cols = [{ t: "Producto / Servicio", x: L, w: W - 300 }, { t: "Cantidad", x: L + W - 300, w: 60, a: "right" }, { t: "Precio Unit.", x: L + W - 230, w: 80, a: "right" }, { t: "% IVA", x: L + W - 140, w: 40, a: "right" }, { t: "Subtotal", x: L + W - 90, w: 90, a: "right" }]
  let y = doc.y
  doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
  cols.forEach((c) => doc.text(c.t, c.x, y, { width: c.w, align: c.a || "left" }))
  doc.y = y + 14
  line()
  y = doc.y
  doc.font("Helvetica").fontSize(9).fillColor(INK)
  const vals = [f.producto, num(f.cantidad), ars(unit), "21%", ars(sub)]
  cols.forEach((c, i) => doc.text(vals[i], c.x, y, { width: c.w, align: c.a || "left" }))
  doc.y = Math.max(doc.y, y + 14) + 10
  line()

  // Totales
  const tot = (label, v, bold) => {
    const ty = doc.y
    doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 9).fillColor(INK)
    doc.text(label, L + W - 290, ty, { width: 190, align: "right" })
    doc.text(ars(v), L + W - 100, ty, { width: 100, align: "right" })
    doc.y = ty + (bold ? 18 : 14)
  }
  if (f.tipo === "A") { tot("Importe Neto Gravado:", f.neto); tot("IVA 21%:", f.iva); tot("Importe Total:", f.total, true) }
  else {
    tot("Importe Total:", f.total, true)
    doc.moveDown(0.4).font("Helvetica").fontSize(8).fillColor(MUTED)
    doc.text(`Régimen de Transparencia Fiscal al Consumidor (Ley 27.743) — IVA Contenido: ${ars(f.iva)}`, L, doc.y, { width: W, align: "right" })
  }
  doc.moveDown(1.5)
  line()

  // QR + CAE
  const png = await QRCode.toBuffer(qrUrl(f), { errorCorrectionLevel: "M", margin: 1, width: 240 })
  const qy = doc.y
  doc.image(png, L, qy, { width: 96, height: 96 })
  doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(`CAE N°: ${f.cae}`, L + 112, qy + 14)
  doc.text(`Fecha de Vto. de CAE: ${fecha(f.caeVto)}`, L + 112, qy + 32)
  doc.font("Helvetica").fontSize(7).fillColor(MUTED).text("Comprobante Autorizado por ARCA. Escaneá el QR para verificarlo.", L + 112, qy + 70, { width: W - 112 })

  if (IS_DEMO) {
    doc.save().rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] }).font("Helvetica-Bold").fontSize(54).fillColor("#D92D20").opacity(0.12)
    doc.text("DEMO · SIN VALIDEZ FISCAL", 0, doc.page.height / 2 - 30, { width: doc.page.width, align: "center" }).restore()
  }
  doc.end()
  await new Promise((ok, fail) => { stream.on("finish", ok); stream.on("error", fail) })
}

