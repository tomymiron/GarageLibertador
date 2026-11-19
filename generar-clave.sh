#!/bin/sh
# Genera la clave privada y el pedido de certificado (CSR) que se sube a ARCA.
# Uso: npm run generar-clave -- <CUIT> "<Razón social>"
set -e
CUIT=$(echo "$1" | tr -cd '0-9')
NOMBRE=${2:-Garage}
[ ${#CUIT} -eq 11 ] || { echo "Uso: npm run generar-clave -- 20123456789 \"Razón social\""; exit 1; }
cd "$(dirname "$0")/certificados"
if [ -f clave.key ]; then echo "Ya existe certificados/clave.key — no la piso. Si de verdad querés una nueva, borrala a mano primero."; exit 1; fi
openssl genrsa -out clave.key 2048
chmod 600 clave.key
openssl req -new -key clave.key -subj "/C=AR/O=${NOMBRE}/CN=facturador/serialNumber=CUIT ${CUIT}" -out pedido.csr
echo ""
echo "Listo:"
echo "  certificados/clave.key   → CLAVE PRIVADA. No se comparte ni se sube a ningún lado."
echo "  certificados/pedido.csr  → esto es lo que subís a ARCA (paso 2 de docs/certificado-arca.md)."
