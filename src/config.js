// Configuración — todo sale del archivo .env (copiar .env.example → .env y completar).
import path from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true })

const env = (k, def = "") => (process.env[k] ?? def).toString().trim()
const abs = (p) => (p ? (path.isAbsolute(p) ? p : path.join(ROOT, p)) : "")

export const ARCA_ENV = env("ARCA_ENV", "homologacion")
export const IS_PROD = ARCA_ENV === "produccion"
// demo = no toca ARCA: CAEs y clientes inventados, para ver cómo funciona el panel sin certificado.
export const IS_DEMO = ARCA_ENV === "demo"

export const WSAA_URL = IS_PROD ? "https://wsaa.afip.gov.ar/ws/services/LoginCms" : "https://wsaahomo.afip.gov.ar/ws/services/LoginCms"
export const WSFE_URL = IS_PROD ? "https://servicios1.afip.gov.ar/wsfev1/service.asmx" : "https://wswhomo.afip.gov.ar/wsfev1/service.asmx"
export const PADRON_URL = IS_PROD ? "https://aws.afip.gov.ar/sr-padron/webservices/personaServiceA5" : "https://awshomo.afip.gov.ar/sr-padron/webservices/personaServiceA5"

export const CUIT = IS_DEMO ? "20111111112" : env("CUIT").replace(/\D/g, "")
export const PTO_VTA = IS_DEMO ? 1 : parseInt(env("PUNTO_DE_VENTA", "0"), 10)
export const CERT_PATH = abs(env("CERTIFICADO", "certificados/certificado.crt"))
export const KEY_PATH = abs(env("CLAVE_PRIVADA", "certificados/clave.key"))

// true → el "Precio Unitario" del Excel ya tiene el IVA adentro. false → es neto y se le suma el 21%.
export const PRECIO_INCLUYE_IVA = /^(s|si|sí|true|1)$/i.test(env("PRECIO_INCLUYE_IVA", "no"))

// Si el padrón de ARCA no responde, condición IVA que se asume para un CUIT con Factura B (6 = Monotributo).
export const COND_IVA_B_POR_DEFECTO = parseInt(env("COND_IVA_B_POR_DEFECTO", "6"), 10)

export const EMISOR = {
  cuit: CUIT,
  nombreComercial: env("NOMBRE_COMERCIAL", "Garage Libertador"),
  razonSocial: IS_DEMO ? "Garage Libertador" : env("RAZON_SOCIAL", "Garage Libertador"),
  domicilio: env("DOMICILIO_FISCAL"),
  iibb: env("INGRESOS_BRUTOS"),
  inicioActividad: env("INICIO_ACTIVIDADES"),
  condIva: env("CONDICION_IVA", "IVA Responsable Inscripto"),
}

export const DATOS_DIR = path.join(ROOT, "datos")
export const FACTURAS_DIR = path.join(ROOT, IS_DEMO ? "facturas-demo" : "facturas")

// ─── Tablas oficiales WSFEv1 ────────────────────────────────────────────────
export const CBTE_TIPO = { A: 1, B: 6 }
// Nota de crédito de la misma letra que la factura que anula (igual que previateapi: NC_FOR_FACTURA)
export const NC_TIPO = { A: 3, B: 8 }
export const DOC_TIPO = { CUIT: 80, DNI: 96, CONSUMIDOR_FINAL: 99 }
export const ALIC_IVA_21 = 5
export const CONCEPTO_SERVICIOS = 2
// CondicionIVAReceptorId (RG 5616) — FEParamGetCondicionIvaReceptor
export const COND_IVA = { RI: 1, EXENTO: 4, CONSUMIDOR_FINAL: 5, MONOTRIBUTO: 6 }
export const COND_IVA_LABEL = { 1: "IVA Responsable Inscripto", 4: "IVA Sujeto Exento", 5: "Consumidor Final", 6: "Responsable Monotributo" }

export function assertConfigured() {
  const faltan = []
  if (CUIT.length !== 11) faltan.push("CUIT")
  if (!PTO_VTA) faltan.push("PUNTO_DE_VENTA")
  if (faltan.length) throw new Error(`Falta completar en .env: ${faltan.join(", ")}`)
}
