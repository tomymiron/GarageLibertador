# Que Claude lo configure por vos

Si no querés hacer [el paso a paso del certificado](./certificado-arca.md) a mano, Claude Code puede hacerlo casi todo
solo: instala el proyecto, genera la clave, entra a ARCA con la **extensión Claude in Chrome**, saca el certificado,
lo autoriza, crea el punto de venta, deja todo en producción y lo verifica.

**Lo único que hacés vos:**

1. **Iniciar sesión en ARCA** en tu Chrome. Claude nunca ve ni escribe tu clave fiscal.
2. **Darle el OK una vez** al plan, antes de que toque nada en ARCA.
3. Contestar si te pregunta algo que no puede saber, como el número de Ingresos Brutos.

## Requisitos

- [Claude Code](https://claude.com/claude-code) instalado.
- La extensión **Claude in Chrome**, conectada a Claude Code. Sin ella Claude hace todo lo local y te guía en ARCA paso
  a paso.
- Clave fiscal **nivel 3** del CUIT del garage.

## Cómo usarlo

1. Abrí una terminal en la carpeta del proyecto y arrancá Claude Code:
   ```sh
   cd ~/garage-facturador && claude
   ```
2. Copiá **todo** el bloque de abajo y pegalo como primer mensaje.

---

```text
Sos el encargado de dejar funcionando en PRODUCCIÓN el facturador electrónico de este repo (Garage Libertador):
emite facturas A/B y notas de crédito en ARCA (ex AFIP) por web services (WSAA + WSFEv1) usando un certificado digital.
Trabajá en la carpeta actual. Leé primero README.md y docs/certificado-arca.md: ahí está el procedimiento oficial que
tenés que seguir; este mensaje agrega cómo hacerlo con la menor intervención humana posible.

OBJETIVO FINAL (definición de "terminado")
- certificados/clave.key y certificados/certificado.crt válidos para el CUIT del garage, en producción.
- El certificado autorizado en ARCA para "Facturación Electrónica" (wsfe) y, si se puede, para
  "Consulta de Constancia de Inscripción" (ws_sr_constancia_inscripcion).
- Un punto de venta tipo "Web Services" creado y cargado en .env.
- .env completo con ARCA_ENV=produccion.
- `npm run probar` con TODOS los pasos en ✓ (el del padrón puede quedar ✗ solo si el usuario decide no autorizarlo).
- El panel corriendo (`npm run panel`) y abierto en el navegador.

REGLAS (no negociables)
1. Nunca pidas, leas, escribas ni guardes la clave fiscal del usuario. El login en ARCA lo hace él en Chrome. Si una
   pantalla pide la clave fiscal, frená y pedile que la complete él.
2. Nunca emitas una factura ni una nota de crédito reales. Para verificar usá solo `npm run probar` y
   `npm run facturar -- <excel> --simular`. Si en algún momento hace falta emitir, preguntá antes.
3. certificados/clave.key es secreta: no la muestres, no la subas a ningún lado, no la commitees. Si ya existe, NO la
   regeneres ni la borres sin preguntar (invalidaría un certificado que ya funciona).
4. Antes de hacer cambios en ARCA, mostrale al usuario UN solo resumen con todo lo que vas a hacer (alias del
   certificado, servicios a autorizar, número y domicilio del punto de venta) y esperá un OK. Con ese OK hacé todo de
   corrido sin volver a preguntar, salvo que algo no coincida con el plan.
5. Si ya existe algo en ARCA (alias "facturador", relaciones, un punto de venta Web Services), reusalo: no dupliques.
6. Las pantallas de ARCA cambian seguido. No dependas de coordenadas fijas: ubicá cada botón por su texto (find /
   read_page). Si después de 2-3 intentos no encontrás algo, describí qué ves y preguntá.
7. No dispares diálogos nativos del navegador (alert/confirm). Si ARCA abre un popup o una pestaña nueva, seguila con
   tabs_context.

FASE 1 · Local (sin preguntar nada)
- Verificá `node -v` (>= 20). Si falta, decile cómo instalarlo (brew install node) y esperá.
- `npm install`.
- Si no existe .env, `cp .env.example .env`.
- Revisá si ya hay certificados/clave.key y certificados/certificado.crt. Si están y `npm run probar` da todo ✓,
  saltá directo a la FASE 5.

FASE 2 · Datos que necesitás (pedilos todos juntos, en un solo mensaje)
- CUIT del garage. Si el usuario no lo sabe, lo vas a leer en ARCA después del login.
- ¿Persona física o sociedad (SRL/SA/SAS)? Si es sociedad, quién inicia sesión (el representante) y qué empresa
  elegir en "representado".
- ¿Los precios del Excel incluyen IVA? Va a PRECIO_INCLUYE_IVA (no = se suma 21 %, si = ya lo incluyen).
- Opcionales para el PDF: Ingresos Brutos e inicio de actividades. La razón social y el domicilio los podés sacar del
  padrón al final, así que no los pidas si no hace falta.
Con el CUIT, generá la clave y el pedido:
  npm run generar-clave -- <CUIT> "<Razón social o nombre>"

FASE 3 · ARCA con Claude in Chrome
- Cargá las herramientas del navegador en una sola llamada a ToolSearch (tabs_context_mcp, tabs_create_mcp, navigate,
  computer, find, read_page, get_page_text, file_upload, form_input). Si la extensión no está disponible, hacé la FASE 3
  guiando al usuario paso a paso con docs/certificado-arca.md y seguí desde la FASE 4.
- Abrí una pestaña nueva en https://www.arca.gob.ar → "Iniciar sesión" y pedile al usuario que entre con su CUIT y
  clave fiscal. Esperá a que te avise que entró; confirmá en la página que la sesión está iniciada y leé el
  CUIT y nombre que muestra.
- Relevá el estado SIN modificar nada:
  a) "Administración de Certificados Digitales": ¿existe? ¿hay un alias "facturador"? (si no existe el servicio, va a
     haber que adherirlo).
  b) "Administrador de Relaciones de Clave Fiscal": ¿qué relaciones de WebServices tiene ya el CUIT?
  c) "Administración de puntos de venta y domicilios" → A/B/M: ¿qué puntos de venta hay y de qué sistema? Elegí el
     primer número libre y el domicilio fiscal para el nuevo.
- Mostrá el resumen (regla 4) y esperá el OK. Después:
  1. Si hace falta, adherí "Administración de Certificados Digitales" (Administrador de Relaciones → Adherir servicio →
     ARCA → Servicios interactivos). ARCA puede pedir cerrar sesión y volver a entrar: en ese caso pedile al usuario
     que vuelva a iniciar sesión.
  2. Certificados Digitales → Agregar alias "facturador" → subí certificados/pedido.csr con file_upload → Agregar alias
     → Ver → descargá el .crt. Encontralo en ~/Downloads (el más nuevo, facturador_*.crt) y movelo a
     certificados/certificado.crt. Verificá con `openssl x509 -in certificados/certificado.crt -noout -subject -enddate`
     que el serialNumber sea "CUIT <CUIT del garage>".
  3. Administrador de Relaciones → Nueva Relación → Buscar → ARCA → WebServices → "Facturación Electrónica" →
     Representante: Buscar → Computador Fiscal → "facturador" → Confirmar.
  4. Lo mismo para "Consulta de Constancia de Inscripción" (ws_sr_constancia_inscripcion). Si no la encontrás con ese
     nombre, buscá "Constancia de Inscripción" o "Padrón A5" dentro de WebServices.
  5. Puntos de venta → Agregar → número elegido · nombre de fantasía "Garage Libertador" · sistema "Factura Electrónica
     - Monotributo / Responsable Inscripto - Web Services" (o "RECE para aplicativo y web services") · domicilio fiscal
     → Aceptar. Anotá el número.
- Antes de salir de ARCA, sacá una captura (o leé el texto) de las relaciones y del punto de venta como evidencia.

FASE 4 · Producción
- Completá .env: ARCA_ENV=produccion, CUIT, PUNTO_DE_VENTA, PRECIO_INCLUYE_IVA, CERTIFICADO y CLAVE_PRIVADA (dejá los
  valores por defecto si los archivos están en certificados/), NOMBRE_COMERCIAL=Garage Libertador.
- `npm run probar`. Si el padrón da ✓, usalo para la razón social y el domicilio:
    node --input-type=module -e 'import { consultarCuit } from "./src/padron.js"; console.log(await consultarCuit(process.env.CUIT_GARAGE))'
  (con CUIT_GARAGE=<cuit> delante) y completá RAZON_SOCIAL y DOMICILIO_FISCAL. Más INGRESOS_BRUTOS e
  INICIO_ACTIVIDADES si el usuario los dio.
- Si algún paso da ✗, usá la tabla "Errores típicos" de docs/certificado-arca.md, corregí y repetí. Ojo: después de
  crear una relación nueva ARCA puede tardar unos minutos en reconocerla. Esperá con Monitor/ScheduleWakeup, no con
  sleep en un bucle.
- Prueba en seco: `npm run facturar -- "ejemplo/Facturacion fin de noviembre (ejemplo).xlsx" --simular`. Tiene que
  mostrar el resumen con los nombres reales de los clientes desde el padrón y NO emitir nada.

FASE 5 · Dejarlo andando
- Arrancá el panel en segundo plano (`npm run panel`). Escucha solo en http://localhost:3737 y abre Safari.
- Preguntá si quiere que arranque solo al prender la Mac. Si dice que sí, creá un LaunchAgent en
  ~/Library/LaunchAgents/com.garagelibertador.panel.plist que corra `node src/server.js` en esta carpeta, con
  RunAtLoad y KeepAlive, y cargalo con launchctl bootstrap gui/$(id -u) <plist>.
- Recordale que el certificado vence en 2 años (decile la fecha exacta del openssl).

INFORME FINAL (corto, en español)
- Qué quedó hecho y la salida de `npm run probar`.
- CUIT, punto de venta, vencimiento del certificado.
- Qué NO se pudo hacer y por qué, si algo quedó afuera.
- Cómo usarlo: doble clic en "Abrir panel.command" o `npm run panel`, subir el Excel, revisar, emitir.
```

---

### Qué esperar

| Momento | Quién |
|---|---|
| Instalar, generar clave y CSR | Claude |
| Iniciar sesión en ARCA | **Vos** |
| Aprobar el plan (una vez) | **Vos** |
| Certificado, relaciones, punto de venta | Claude, en tu Chrome |
| `.env`, verificación, panel | Claude |

Si en algún momento ARCA pide volver a iniciar sesión (pasa después de adherir un servicio nuevo), Claude te avisa y
espera.
