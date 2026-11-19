#!/usr/bin/env node
// npm run probar — verifica que todo esté bien configurado, sin emitir nada.
import { ARCA_ENV } from "./config.js"
import { probarConexion } from "./motor.js"

console.log(`\nAmbiente: ${ARCA_ENV}\n`)
for (const p of await probarConexion()) console.log(`${p.ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${p.nombre}\n  \x1b[2m${p.detalle}\x1b[0m`)
console.log()
