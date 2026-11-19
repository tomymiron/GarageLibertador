// Padrón de ARCA (ws_sr_constancia_inscripcion) — basado en previateapi/services/afip/padronConstancia.js.
// Sirve para dos cosas: el nombre/razón social del cliente (va impreso en la factura) y su condición
// frente al IVA (ARCA la exige en cada factura desde la RG 5616).
import axios from "axios"
import { getTA } from "./wsaa.js"
import { PADRON_URL, CUIT, COND_IVA, IS_DEMO } from "./config.js"
import { grab } from "./wsfe.js"

const cache = new Map()

export async function consultarCuit(cuit) {
  if (cache.has(cuit)) return cache.get(cuit)
  if (IS_DEMO) return demoPersona(cuit)
  const ta = await getTA("ws_sr_constancia_inscripcion")
  const soap = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a5="http://a5.soap.ws.server.puc.sr/"><soapenv:Header/><soapenv:Body><a5:getPersona><token>${ta.token}</token><sign>${ta.sign}</sign><cuitRepresentada>${CUIT}</cuitRepresentada><idPersona>${cuit}</idPersona></a5:getPersona></soapenv:Body></soapenv:Envelope>`
  const resp = await axios.post(PADRON_URL, soap, { headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" }, timeout: 20000, validateStatus: () => true })
  const body = String(resp.data || "")
  const fault = grab(body, "faultstring")
  if (fault) throw new Error(`[padrón] ${fault}`)
  const dg = grab(body, "datosGenerales")
  if (!dg) {
    const err = grab(grab(body, "errorConstancia"), "error")
    throw new Error(`[padrón] CUIT ${cuit}: ${err || `sin datos (HTTP ${resp.status})`}`)
  }
  const nombre = grab(dg, "razonSocial") || [grab(dg, "apellido"), grab(dg, "nombre")].filter(Boolean).join(" ")
  const dom = grab(dg, "domicilioFiscal")
  const domicilio = dom ? [grab(dom, "direccion"), grab(dom, "localidad"), grab(dom, "descripcionProvincia")].filter(Boolean).join(", ") : ""
  // Monotributo → 6 · Régimen general con IVA (impuesto 30) → RI 1 · con IVA exento (32) → 4 · otro → no concluyente
  const rg = grab(body, "datosRegimenGeneral")
  const impuestos = rg ? [...rg.matchAll(/<idImpuesto>(\d+)<\/idImpuesto>/g)].map((m) => Number(m[1])) : []
  let condIva = null
  if (grab(body, "datosMonotributo")) condIva = COND_IVA.MONOTRIBUTO
  else if (impuestos.includes(30)) condIva = COND_IVA.RI
  else if (impuestos.includes(32)) condIva = COND_IVA.EXENTO
  const out = { nombre, domicilio, condIva, estado: grab(dg, "estadoClave") }
  cache.set(cuit, out)
  return out
}

// ─── Modo demo: padrón simulado con clientes fijos ──────────────────────────
// CUIT 30/33/34 → empresa Responsable Inscripto (Factura A) · 20/23/27 → monotributista (Factura B)
export const DEMO_PADRON = {
  "30712345671": "TRANSPORTES DEL SUR SA",
  "30719998883": "LOGISTICA PAMPA SRL",
  "30715550012": "DISTRIBUIDORA NORTE SA",
  "33709876541": "CONSTRUCTORA RIO DE LA PLATA SA",
  "20123456786": "GOMEZ MARIA LAURA",
  "27287654329": "FERNANDEZ ANA BELEN",
  "20301112220": "RODRIGUEZ JUAN PABLO",
  "23345678905": "MARTINEZ LUCIA",
}
const EMPRESAS = ["SERVICIOS INTEGRALES SRL", "AGRO LOS ALAMOS SA", "MUDANZAS EXPRESO SRL"], PERSONAS = ["LOPEZ MARTIN", "SOSA CAROLINA", "DIAZ NICOLAS"]
function demoPersona(cuit) {
  const empresa = /^3[034]/.test(cuit), lista = empresa ? EMPRESAS : PERSONAS
  const nombre = DEMO_PADRON[cuit] || lista[[...cuit].reduce((a, d) => a + Number(d), 0) % lista.length]
  return { nombre, domicilio: empresa ? "Av. Corrientes 1234, CABA" : "Thames 456, CABA", condIva: empresa ? COND_IVA.RI : COND_IVA.MONOTRIBUTO, estado: "ACTIVO" }
}
