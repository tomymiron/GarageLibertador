# Cómo sacar el certificado de ARCA

El facturador habla directo con los servicios web de ARCA (ex AFIP). Para que ARCA acepte sus pedidos necesita un
**certificado digital** a nombre del CUIT del garage, autorizado para **facturación electrónica**. Se hace **una vez**
y dura **2 años**. Cuando vence se repiten los pasos 1 a 4.

> **¿No querés hacerlo a mano?** En [`PROMPT-CLAUDE.md`](./PROMPT-CLAUDE.md) hay un prompt para que Claude Code lo
> haga por vos con la extensión de Chrome: vos solo iniciás sesión en ARCA.

Tiempo estimado: **15 minutos**.

---

## Antes de empezar

| Necesitás | Detalle |
|---|---|
| **Clave fiscal nivel 3** o más | La del titular del CUIT o la del representante legal si es una sociedad. Se sube de nivel desde la app *Mi ARCA* con validación facial. |
| **Responsable Inscripto** | El garage emite Facturas A y B con IVA 21 %. |
| **La Mac con el proyecto** | `cd ~/garage-facturador` y `npm install` hecho. |

```
 Mac                              ARCA (web)
 ───                              ──────────
 1. clave.key + pedido.csr  ──▶   2. Administración de Certificados Digitales
                                     └─ subís pedido.csr, bajás certificado.crt
 certificados/certificado.crt ◀──
                                  3. Administrador de Relaciones
                                     └─ autorizás el certificado para "Facturación Electrónica"
                                  4. (opcional) mismo trámite para "Constancia de Inscripción"
                                  5. Punto de venta nuevo tipo "Web Services"
 6. .env  →  7. npm run probar  ✓
```

---

## 1 · Generar la clave privada y el pedido (en la Mac)

```sh
npm run generar-clave -- 30712345678 "Razón social del garage"
```

Crea dos archivos en `certificados/`:

| Archivo | Qué es | ¿Se comparte? |
|---|---|---|
| `clave.key` | La **clave privada**. Firma cada pedido a ARCA. | **Nunca.** Ni a ARCA, ni por mail, ni a git. Hacele backup en un lugar seguro. |
| `pedido.csr` | El pedido de certificado (CSR). | Sí: es lo que se sube a ARCA. |

> Si `clave.key` ya existe, el script no la pisa. Para generar una nueva, borrala a mano primero, sabiendo que el
> certificado viejo deja de servir.

## 2 · Subir el pedido y descargar el certificado (en ARCA)

1. Entrá a **[arca.gob.ar](https://www.arca.gob.ar)** → *Iniciar sesión* con CUIT y clave fiscal.
2. Buscá el servicio **"Administración de Certificados Digitales"**. Podés usar el buscador de arriba.
   - **Si no aparece**, adherilo: **"Administrador de Relaciones de Clave Fiscal"** → **Adherir servicio** →
     **ARCA** → **Servicios interactivos** → **Administración de Certificados Digitales** → **Confirmar**.
     Cerrá sesión y volvé a entrar para que aparezca.
3. Si representás a una sociedad, elegí la empresa (el garage).
4. **Agregar alias** → alias: `facturador` → en *Archivo*, subí `certificados/pedido.csr` → **Agregar alias**.
5. En la lista, **Ver** al lado de `facturador` → **descargar** el certificado (`facturador_xxxxxxxx.crt`).
6. Movelo a la carpeta del proyecto con el nombre exacto `certificado.crt`:

```sh
mv ~/Downloads/facturador_*.crt ~/garage-facturador/certificados/certificado.crt
```

## 3 · Autorizar el certificado para facturar (en ARCA)

El certificado por sí solo no puede hacer nada: hay que darle permiso para cada servicio.

1. **"Administrador de Relaciones de Clave Fiscal"** → elegí el CUIT del garage → **Nueva Relación**.
2. **Buscar** → **ARCA** → **WebServices** → **Facturación Electrónica**.
3. En *Representante* → **Buscar** → en **Computador Fiscal** elegí `facturador` → **Confirmar**.
4. Queda una relación nueva: *Facturación Electrónica → facturador*.

## 4 · Permiso para el padrón (recomendado)

Sirve para dos cosas:
- La factura sale con el **nombre del cliente**.
- Se verifica que a un Responsable Inscripto le hagas una **A** y a un monotributista una **B**. ARCA rechaza la factura si la condición de IVA no coincide.

Repetí el paso 3, pero en **WebServices** elegí **"Consulta de Constancia de Inscripción"**
(`ws_sr_constancia_inscripcion`). En el listado puede figurar como *"Constancia de Inscripción"* o *"Padrón A5"*.

> Sin este permiso el facturador funciona igual: la Factura A sale sin nombre del cliente y, para una B con CUIT, asume
> Monotributo (configurable con `COND_IVA_B_POR_DEFECTO`).

## 5 · Crear un punto de venta "Web Services" (en ARCA)

Los puntos de venta de *Comprobantes en línea* **no sirven** para los servicios web; hace falta uno propio.

1. **"Administración de puntos de venta y domicilios"** → elegí la empresa.
2. **A/B/M de Puntos de venta** → **Agregar**.
3. **Número**: uno libre (ej. `2`). **Nombre de fantasía**: `Garage Libertador`.
4. **Sistema**: **"Factura Electrónica - Monotributo / Responsable Inscripto - Web Services"**. A veces figura
   como *"RECE para aplicativo y web services"*.
5. **Domicilio**: el del garage → **Aceptar**.

## 6 · Configurar `.env` (en la Mac)

```sh
cp .env.example .env && open -e .env
```

```ini
ARCA_ENV=produccion
CUIT=30712345678
PUNTO_DE_VENTA=2
PRECIO_INCLUYE_IVA=no
RAZON_SOCIAL=Garage Libertador SRL
DOMICILIO_FISCAL=Av. del Libertador 6540, CABA
INGRESOS_BRUTOS=901-123456-7
INICIO_ACTIVIDADES=01/03/2019
```

`RAZON_SOCIAL`, `DOMICILIO_FISCAL`, `INGRESOS_BRUTOS` e `INICIO_ACTIVIDADES` solo se imprimen en el PDF. Están en tu
**constancia de inscripción**.

## 7 · Verificar

```sh
npm run probar
```

```
✓ .env completo                          CUIT 30712345678 · Punto de venta 2
✓ Certificado y clave privada            facturador · CUIT 30712345678 · válido hasta 19/11/2028
✓ Servidores de ARCA                     app OK · db OK · auth OK
✓ Autenticación para facturar (wsfe)     ticket válido hasta …
✓ Punto de venta 2 habilitado para Factura A
✓ Punto de venta 2 habilitado para Factura B
✓ Padrón de ARCA                         tu CUIT figura como GARAGE LIBERTADOR SRL
```

Todo en ✓: ya se puede facturar. `npm run probar` **no emite nada**.

---

## Errores típicos

| El mensaje dice… | Qué pasa | Solución |
|---|---|---|
| `Certificado no emitido por AC de confianza` | Certificado de homologación en producción o al revés | Revisá `ARCA_ENV` y `CERTIFICADO` en `.env` |
| `Computador no autorizado a acceder al servicio` | Falta la relación | Paso 3 (o 4 para el padrón) |
| `El CEE ya posee un TA valido` | Se borró `datos/` con un ticket vigente | Esperá ~10 minutos y reintentá |
| algo sobre el **punto de venta** | No es de tipo Web Services o el número está mal | Paso 5 y `PUNTO_DE_VENTA` |
| `El certificado es del CUIT X, pero en .env pusiste Y` | El CSR se generó con otro CUIT | Repetí desde el paso 1 |
| `Venció el …` | El certificado tiene 2 años | Pasos 1 a 3 de nuevo (alias nuevo o el mismo) |

## Probar sin riesgo: homologación (opcional)

ARCA tiene un ambiente de pruebas donde las facturas no valen. Usa **otro certificado**:

1. Adherí **"WSASS - Autogestión Certificados Homologación"** (Administrador de Relaciones → Adherir servicio).
2. En WSASS: **Nuevo Certificado** → nombre `facturador` → pegá el contenido de `pedido.csr` → guardá el resultado
   como `certificados/certificado-homo.crt`.
3. En WSASS: **Crear autorización a servicio** → ese certificado → servicio **wsfe** (y
   `ws_sr_constancia_inscripcion` si querés el padrón).
4. En `.env`: `ARCA_ENV=homologacion` y `CERTIFICADO=certificados/certificado-homo.crt`. Cualquier punto de venta sirve.

Y si solo querés ver cómo funciona el panel, sin ARCA ni certificado: `npm run demo`.
