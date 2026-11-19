// WSFEv1 — Facturación electrónica de ARCA. Basado en previateapi/services/afip/wsfev1.js.
//   FEDummy                 → ¿están vivos los servidores de ARCA?
//   FECompUltimoAutorizado  → último número emitido para (punto de venta, tipo)
//   FECAESolicitar          → pide el CAE (esto ES emitir la factura)
//   FECompConsultar         → consulta un comprobante ya emitido (para recuperar cortes de conexión)
import axios from "axios"
import fs from "fs"
import path from "path"
import { WSFE_URL, CUIT, PTO_VTA, CONCEPTO_SERVICIOS, ALIC_IVA_21, IS_DEMO, DATOS_DIR } from "./config.js"
import { getTA, invalidateTA } from "./wsaa.js"

const NS = "http://ar.gov.afip.dif.FEV1/"
const ERRORES_DE_TICKET = [600, 601, 602, 603]

export const grab = (xml, tag) => xml?.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null
const items = (xml, container, item) => {
  const block = grab(xml, container)
  if (!block) return []
  return [...block.matchAll(new RegExp(`<${item}>([\\s\\S]*?)</${item}>`, "g"))].map(([, x]) => ({ code: Number(grab(x, "Code")), msg: grab(x, "Msg") }))
}
const fmtErr = (list) => list.map((e) => `${e.code}: ${e.msg}`).join(" | ")

async function call(action, inner) {
  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ar="${NS}"><soapenv:Header/><soapenv:Body><ar:${action}>${inner}</ar:${action}></soapenv:Body></soapenv:Envelope>`
  let resp
  try {
    resp = await axios.post(WSFE_URL, envelope, { headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: `${NS}${action}` }, timeout: 45000, validateStatus: () => true })
  } catch (err) {
    const e = new Error(`[${action}] sin respuesta de ARCA: ${err.message}`)
    e.sinRespuesta = true
    throw e
  }
  const body = String(resp.data || "")
  const fault = grab(body, "faultstring")
  if (fault) throw new Error(`[${action}] ${fault}`)
  if (resp.status !== 200) throw new Error(`[${action}] HTTP ${resp.status}: ${body.slice(0, 400)}`)
  const result = grab(body, `${action}Result`)
  if (result == null) throw new Error(`[${action}] respuesta sin ${action}Result`)
  return result
}

async function auth() {
  const ta = await getTA("wsfe")
  return `<ar:Auth><ar:Token>${ta.token}</ar:Token><ar:Sign>${ta.sign}</ar:Sign><ar:Cuit>${CUIT}</ar:Cuit></ar:Auth>`
}

// Errores de cabecera (ticket vencido, CUIT no autorizado, etc.)
function checkErrors(xml, action) {
  const errs = items(xml, "Errors", "Err")
  if (!errs.length) return
  if (errs.some((e) => ERRORES_DE_TICKET.includes(e.code))) invalidateTA("wsfe")
  const e = new Error(`[${action}] ${fmtErr(errs)}`)
  e.afipErrors = errs
  throw e
}

// ─── Modo demo: ARCA simulado ───────────────────────────────────────────────
const DEMO_NUMEROS = path.join(DATOS_DIR, "demo-numeros.json")
const demoNumeros = () => { try { return JSON.parse(fs.readFileSync(DEMO_NUMEROS, "utf8")) } catch { return {} } }
const espera = (ms) => new Promise((r) => setTimeout(r, ms))
const demo = {
  dummy: async () => ({ app: "OK (demo)", db: "OK (demo)", auth: "OK (demo)" }),
  ultimoAutorizado: async (t) => demoNumeros()[t] || 0,
  consultar: async () => null,
  solicitarCae: async (f) => {
    await espera(500 + Math.random() * 500)
    fs.mkdirSync(DATOS_DIR, { recursive: true })
    fs.writeFileSync(DEMO_NUMEROS, JSON.stringify({ ...demoNumeros(), [f.cbteTipo]: f.cbteNro }))
    const vto = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10).replace(/-/g, "")
    return { cae: String(76000000000000 + Math.floor(Math.random() * 1e12)), caeVto: vto, cbteNro: f.cbteNro, observaciones: [] }
  },
}

export async function dummy() {
  if (IS_DEMO) return demo.dummy()
  const xml = await call("FEDummy", "")
  return { app: grab(xml, "AppServer"), db: grab(xml, "DbServer"), auth: grab(xml, "AuthServer") }
}

export async function ultimoAutorizado(cbteTipo, ptoVta = PTO_VTA) {
  if (IS_DEMO) return demo.ultimoAutorizado(cbteTipo)
  const xml = await call("FECompUltimoAutorizado", `${await auth()}<ar:PtoVta>${ptoVta}</ar:PtoVta><ar:CbteTipo>${cbteTipo}</ar:CbteTipo>`)
  checkErrors(xml, "FECompUltimoAutorizado")
  return Number(grab(xml, "CbteNro") || 0)
}

export async function consultar(cbteTipo, cbteNro, ptoVta = PTO_VTA) {
  if (IS_DEMO) return demo.consultar()
  const xml = await call("FECompConsultar", `${await auth()}<ar:FeCompConsReq><ar:CbteTipo>${cbteTipo}</ar:CbteTipo><ar:CbteNro>${cbteNro}</ar:CbteNro><ar:PtoVta>${ptoVta}</ar:PtoVta></ar:FeCompConsReq>`)
  const errs = items(xml, "Errors", "Err")
  if (errs.some((e) => e.code === 602)) return null // 602 = no existe el comprobante
  checkErrors(xml, "FECompConsultar")
  const r = grab(xml, "ResultGet")
  if (!r) return null
  return { cae: grab(r, "CodAutorizacion"), caeVto: grab(r, "FchVto"), fecha: grab(r, "CbteFch"), docNro: grab(r, "DocNro"), impTotal: Number(grab(r, "ImpTotal")), resultado: grab(r, "Resultado") }
}

/**
 * Emite UNA factura (Concepto Servicios, IVA 21 %, contado, pesos).
 * @param {object} f { cbteTipo, cbteNro, fecha 'AAAAMMDD', docTipo, docNro, condIvaReceptor, neto, iva, total }
 */
export async function solicitarCae(f) {
  if (IS_DEMO) return demo.solicitarCae(f)
  const n = (x) => Number(x).toFixed(2)
  const det = `<ar:FECAEDetRequest>
<ar:Concepto>${CONCEPTO_SERVICIOS}</ar:Concepto><ar:DocTipo>${f.docTipo}</ar:DocTipo><ar:DocNro>${f.docNro}</ar:DocNro>
<ar:CbteDesde>${f.cbteNro}</ar:CbteDesde><ar:CbteHasta>${f.cbteNro}</ar:CbteHasta><ar:CbteFch>${f.fecha}</ar:CbteFch>
<ar:ImpTotal>${n(f.total)}</ar:ImpTotal><ar:ImpTotConc>0</ar:ImpTotConc><ar:ImpNeto>${n(f.neto)}</ar:ImpNeto><ar:ImpOpEx>0</ar:ImpOpEx><ar:ImpIVA>${n(f.iva)}</ar:ImpIVA><ar:ImpTrib>0</ar:ImpTrib>
<ar:FchServDesde>${f.fecha}</ar:FchServDesde><ar:FchServHasta>${f.fecha}</ar:FchServHasta><ar:FchVtoPago>${f.fecha}</ar:FchVtoPago>
<ar:MonId>PES</ar:MonId><ar:MonCotiz>1</ar:MonCotiz><ar:CondicionIVAReceptorId>${f.condIvaReceptor}</ar:CondicionIVAReceptorId>${(f.cbtesAsoc || []).length ? `<ar:CbtesAsoc>${f.cbtesAsoc.map((c) => `<ar:CbteAsoc><ar:Tipo>${c.tipo}</ar:Tipo><ar:PtoVta>${c.ptoVta}</ar:PtoVta><ar:Nro>${c.nro}</ar:Nro><ar:Cuit>${c.cuit}</ar:Cuit></ar:CbteAsoc>`).join("")}</ar:CbtesAsoc>` : ""}
<ar:Iva><ar:AlicIva><ar:Id>${ALIC_IVA_21}</ar:Id><ar:BaseImp>${n(f.neto)}</ar:BaseImp><ar:Importe>${n(f.iva)}</ar:Importe></ar:AlicIva></ar:Iva>
</ar:FECAEDetRequest>`
  const body = `${await auth()}<ar:FeCAEReq><ar:FeCabReq><ar:CantReg>1</ar:CantReg><ar:PtoVta>${PTO_VTA}</ar:PtoVta><ar:CbteTipo>${f.cbteTipo}</ar:CbteTipo></ar:FeCabReq><ar:FeDetReq>${det}</ar:FeDetReq></ar:FeCAEReq>`
  const xml = await call("FECAESolicitar", body)
  const detResp = grab(xml, "FECAEDetResponse") || ""
  const errores = [...items(detResp, "Observaciones", "Obs"), ...items(xml, "Errors", "Err")]
  const resultado = grab(detResp, "Resultado") || grab(xml, "Resultado")
  const cae = grab(detResp, "CAE")
  if (resultado !== "A" || !cae) {
    if (errores.some((e) => ERRORES_DE_TICKET.includes(e.code))) invalidateTA("wsfe")
    const e = new Error(`ARCA rechazó el comprobante: ${fmtErr(errores) || "sin detalle"}`)
    e.afipErrors = errores
    throw e
  }
  return { cae, caeVto: grab(detResp, "CAEFchVto"), cbteNro: Number(grab(detResp, "CbteDesde") || f.cbteNro), observaciones: items(detResp, "Observaciones", "Obs") }
}
