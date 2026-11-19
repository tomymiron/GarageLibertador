// WSAA — autenticación con ARCA. Igual que previateapi/services/afip/wsaa.js, pero el ticket se guarda
// en datos/ticket-<servicio>.json en vez de MySQL.
//   1. Armamos un TRA (pedido de acceso) para el servicio (wsfe o padrón).
//   2. Lo firmamos (PKCS#7/CMS) con el certificado + clave privada.
//   3. ARCA devuelve token + sign, válidos 12 h → se reusan hasta que vencen.
import fs from "fs"
import path from "path"
import forge from "node-forge"
import axios from "axios"
import { WSAA_URL, CERT_PATH, KEY_PATH, DATOS_DIR, ARCA_ENV, CUIT, assertConfigured } from "./config.js"

const RENOVAR_ANTES_MS = 30 * 60 * 1000

function buildTra(service) {
  const now = Date.now()
  const fmt = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<loginTicketRequest version="1.0"><header><uniqueId>${Math.floor(now / 1000)}</uniqueId><generationTime>${fmt(now - 600000)}</generationTime><expirationTime>${fmt(now + 600000)}</expirationTime></header><service>${service}</service></loginTicketRequest>`
}

function leerCertificado() {
  if (!fs.existsSync(CERT_PATH)) throw new Error(`No encuentro el certificado en ${CERT_PATH} (ver docs/certificado-arca.md, paso 3)`)
  if (!fs.existsSync(KEY_PATH)) throw new Error(`No encuentro la clave privada en ${KEY_PATH} (ver docs/certificado-arca.md, paso 1)`)
  const cert = forge.pki.certificateFromPem(fs.readFileSync(CERT_PATH, "utf8"))
  const key = forge.pki.privateKeyFromPem(fs.readFileSync(KEY_PATH, "utf8"))
  return { cert, key }
}

export function infoCertificado() {
  const { cert } = leerCertificado()
  const cn = cert.subject.getField("CN")?.value
  const serial = cert.subject.getField({ name: "serialName" })?.value || cert.subject.attributes.find((a) => a.type === "2.5.4.5")?.value
  return { cn, serial, emisor: cert.issuer.getField("CN")?.value, desde: cert.validity.notBefore, hasta: cert.validity.notAfter }
}

function firmarCms(xml) {
  const { cert, key } = leerCertificado()
  const p7 = forge.pkcs7.createSignedData()
  p7.content = forge.util.createBuffer(xml, "utf8")
  p7.addCertificate(cert)
  p7.addSigner({
    key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
    authenticatedAttributes: [{ type: forge.pki.oids.contentType, value: forge.pki.oids.data }, { type: forge.pki.oids.messageDigest }, { type: forge.pki.oids.signingTime, value: new Date() }],
  })
  p7.sign({ detached: false })
  return forge.util.encode64(forge.asn1.toDer(p7.toAsn1()).getBytes())
}

const cachePath = (service) => path.join(DATOS_DIR, `ticket-${ARCA_ENV}-${CUIT}-${service}.json`)
const grab = (xml, tag) => xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1]?.trim() ?? null
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")

export async function getTA(service = "wsfe") {
  assertConfigured()
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(service), "utf8"))
    if (new Date(c.expirationTime).getTime() - Date.now() > RENOVAR_ANTES_MS) return c
  } catch {}

  const envelope = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:wsaa="http://wsaa.view.sua.dvadac.desein.afip.gov"><soapenv:Header/><soapenv:Body><wsaa:loginCms><wsaa:in0>${firmarCms(buildTra(service))}</wsaa:in0></wsaa:loginCms></soapenv:Body></soapenv:Envelope>`
  const resp = await axios.post(WSAA_URL, envelope, { headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "" }, timeout: 30000, validateStatus: () => true })
  const body = String(resp.data || "")
  const ret = body.match(/<loginCmsReturn>([\s\S]*?)<\/loginCmsReturn>/)
  if (!ret) {
    const fault = body.match(/<faultstring>([\s\S]*?)<\/faultstring>/)?.[1]
    // "El CEE ya posee un TA valido" → ARCA no da otro ticket hasta que venza el anterior (se perdió el cache local).
    if (fault && /ya posee un TA valido/i.test(fault)) throw new Error(`ARCA dice que ya hay un ticket vigente para ${service} y se perdió el guardado local. Esperá ~10 min y reintentá.`)
    throw new Error(`[WSAA ${service}] ${fault || `HTTP ${resp.status}: ${body.slice(0, 400)}`}`)
  }
  const ta = unescape(ret[1])
  const out = { token: grab(ta, "token"), sign: grab(ta, "sign"), expirationTime: grab(ta, "expirationTime") }
  if (!out.token || !out.sign) throw new Error(`[WSAA ${service}] respuesta sin token/sign`)
  fs.mkdirSync(DATOS_DIR, { recursive: true })
  fs.writeFileSync(cachePath(service), JSON.stringify(out, null, 2), { mode: 0o600 })
  return out
}

export function invalidateTA(service = "wsfe") {
  try { fs.unlinkSync(cachePath(service)) } catch {}
}
