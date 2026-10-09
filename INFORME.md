# INFORME DE AUDITORÍA — marianmadridXXX

**Fecha**: 2026-10-09 · **Rama**: `audit/initial` (origin/main en `3ec7579`) · **Alcance**: `src/backend` (29 ficheros, 16.624 líneas) + raíz del proyecto (69 `.js`, 22.370 líneas totales incluyendo tests).

## 1. Tipo de proyecto

Sitio Wix Velo con **Wix CLI a nivel de sitio** (no app de marketplace): `@wix/cli` + Git Integration. Dominio: TPV/cajas, reservas de slots duales, fiscalidad española (Veri*Factu, cadena SHA-256, cierres Z), facturación, M365, asistente IA. 9 módulos `.web.js` expuestos al frontend vía `webMethod()`; el resto son módulos internos de backend (sin `.jsw` — confirmado `find -name "*.jsw"` → 0 resultados).

## 2. Mapa de capas (dependencias internas más referenciadas)

| Módulo | Referenciado desde | Rol |
|---|---:|---|
| `logger.js` | 21 ficheros | Transversal, redacción de secretos |
| `internalConfig.js` | 20 | SSOT de constantes/enums |
| `dataLegacyAdapter.js` | 14 | Adaptador DAL transicional (ver §5) |
| `security.js` | 8 | Autorización (requireCajero/requireAdmin) |
| `booking/bookingCore.js` | 7 | Núcleo de reservas |
| `responseUtils.js` / `mmSecrets.js` | 6 / 6 | Formato de respuesta / nombres de secretos |
| `dataAccess.js` | 4 (directo, named imports) | DAL verificado SDK v2 |

## 3. God files (>40 KB) — split propuesto

| Fichero | Líneas | KB | Split propuesto |
|---|---:|---:|---|
| `booking/bookingSaga.js` | 1.777 | 70 | `booking/saga/{orchestrator,compensation,locks,heartbeat,dualPair}.js` |
| `reservas.web.js` | 1.663 | 59 | Fachada webMethod + `booking/availability.service.js` |
| `cajas.web.js` | 1.607 | 70 | Fachada + `fiscal/{ledger,zClosing,giftCards}.service.js` + `fiscal/fiscalConfig.js` |
| `booking/bookingCore.js` | 1.176 | 50 | Extraer `normalizeError` → `backend/errors.js` (rompe dependencia invertida fiscal→booking) |
| `events.js` | 1.124 | 47 | No evaluado en detalle (pendiente) |
| `eventLog.js` | 973 | 43 | No evaluado en detalle (pendiente) |

**Riesgo del split**: ninguno de estos ficheros tiene tests de caracterización que capturen su comportamiento actual (ver §6). Partirlos sin esa red de seguridad es el principal riesgo de regresión del proyecto — **no se recomienda iniciar el split sin tests previos**.

## 4. Matriz webMethod ↔ permisos

Confirmado por lectura completa de los 9 `.web.js`: **el 100% de los exports invocables desde el frontend están envueltos en `webMethod(Permissions.X, ...)`** (`SiteMember` o `Admin`, nunca `Anyone` sin revisar). Los exports sin `webMethod()` en esos mismos ficheros son funciones internas (`_prefijo` o `*Internal`) usadas solo backend-a-backend — Wix no las expone al cliente.

**`src/backend/permissions.json`** declara `"*": {"*": {anonymous: {invoke: true}}}` (abierto a todos). Este fichero es el mecanismo **legacy de Velo para módulos `.jsw`**; con 0 ficheros `.jsw` en el repo, es **configuración inerte — no gobierna ningún `.web.js`** (cuya autorización ya está resuelta en código, caso por caso). Es decir: **no hay vulnerabilidad activa**, pero el fichero es ruido/deuda — induce a error a quien lo lea pensando que controla algo. Tratamiento recomendado en Fase 2: **eliminarlo** (no editarlo con una matriz nueva), documentando en el commit por qué es seguro borrarlo.

## 5. Imports legacy / deuda técnica identificada

| Hallazgo | Estado |
|---|---|
| `wixData` importado como default de `backend/dataAccess` en 14 ficheros | **Corregido** (commit `3ec7579`, ya en `origin/main`): `dataAccess.js` no tiene default export desde v11.0; se creó `dataLegacyAdapter.js` (adaptador transicional, documentado como deuda a retirar) y se repararon los 14 imports. |
| `import { elevate } from "@wix/sdk"` (patrón no estándar) | **Corregido** en `bookingCore.js`/`bookingSaga.js` → `auth.elevate` de `@wix/essentials` (mismo commit). |
| `marianAssistant.web.js` usa `wix-secrets-backend` (legacy) | **Pendiente.** Único fichero con este import; migración a `@wix/secrets` es mecánica (`getSecret` → `secrets.getSecret`), bajo riesgo. |
| `@wix/sdk` ausente en `package.json` pese a usarse (`events.js`, `createClient`) | **Corregido** (mismo commit). |
| Adaptador `dataLegacyAdapter.js` (nuevo, ~260 líneas) | **Deuda técnica reconocida.** Evita una reescritura de ~70 call-sites en ficheros fiscales críticos sin red de tests. Objetivo final declarado en la cabecera de `dataAccess.js` (regla R4) es eliminarlo migrando los 14 módulos a la API nombrada. No se debe añadir nuevos consumidores. |
| Dos carpetas de test (`__tests__/`, `tests/`) | **No son duplicados independientes**: `tests/*.runner.mjs` son wrappers `node:test` que **importan la lógica de aserciones desde `__tests__/*.js`** (p. ej. `unit.testRunner.runner.mjs` → `../__tests__/unit.testRunner.js`). Es una arquitectura válida pero mal cableada: **ninguna de las dos está conectada a `package.json`** (no existe script `test`). Fix de una línea, sin código nuevo: añadir `"test": "node --test src/backend/tests"`. |
| `package.json`: sin `engines`, sin script `test`/`test:e2e`/`preview`/`publish` | **Parcialmente pendiente.** `lint` y `dev` sí existen. |
| `.eslintrc.json` | **Ya existe** (`plugin:@wix/cli/recommended`), contradice el hallazgo previo de "ausente" en el brief recibido — **no crear uno nuevo**. |
| `.nvmrc` | Ausente. Trivial de añadir si se fija versión de Node en `engines`. |

## 6. Estado de tests

12 ficheros de test (~140 KB), **0 ejecutables hoy** (sin script `test` en `package.json`, sin CI). No cubren ninguno de los god files candidatos a split (§3). Antes de cualquier refactor estructural, hace falta: (a) cablear el runner existente (1 línea), (b) confirmar que pasa en verde tal cual está, (c) solo entonces añadir caracterización puntual de los ficheros a partir.

## 7. Riesgos abiertos (sin tocar código fiscal crítico)

- `dataLegacyAdapter.js::contains()` degrada búsquedas de texto libre (`inventario.web.js`, campo `productName`) de subcadena a solo-prefijo — no hay operador `$contains` en SDK v2. Afecta a la UX de búsqueda de inventario, no a integridad fiscal.
- `booking/bookingCore.js` pedía `suppressHooks: true` sobre `CITAS_COL`; el adaptador ya no lo respeta (los hooks de `data.js` se ejecutan siempre, SSOT-14). Revisar si alguna ruta de negocio asumía la supresión real.
- No se ha auditado aún el contenido semántico de `events.js` ni `eventLog.js` (god files, §3).

## 8. Fases propuestas para despliegue final

| Fase | Rama | Contenido | Riesgo | Bloqueada por |
|---|---|---|---|---|
| **1 — Auditoría** | `audit/initial` | Este informe. Sin cambios de código. | Ninguno | — |
| **2 — Críticos mínimos** | `fix/critical-security` | (a) Eliminar `permissions.json` (confirmado inerte, §4). (b) Cablear `test` en `package.json` (1 línea). (c) Migrar `marianAssistant.web.js` a `@wix/secrets`. | Bajo | Nada |
| **3 — Caracterización** | `test/characterization` | Tests de caracterización SOLO para los god files que se vayan a partir, ejecutando el runner ya existente. Sin tests nuevos en ficheros que no se van a tocar. | Bajo | Fase 2 en verde |
| **4 — Split god files** | `refactor/god-files` | Solo los ficheros con tests de caracterización en verde (Fase 3). Un commit por split; si rompe tests, revertir ese split y seguir con el siguiente. | Medio-alto (código fiscal) | Fase 3 |
| **5 — Retirar adaptador** | `chore/migrate-sdk` | Migrar los 14 módulos de `dataLegacyAdapter` a `dataAccess.js` named imports; borrar el adaptador. Candidato natural a hacerse fichero a fichero dentro de la Fase 4 (mismo split), no como bloque aparte. | Medio (70+ call-sites) | Fase 3 |

**Criterio aplicado en todas las fases**: preferir eliminar/cablear sobre crear. No se propone scaffolding especulativo (CI nuevo, `.eslintrc` nuevo, `.jsw` nuevos) que el repo no tenía ya o no necesita para funcionar.

## 9. Pendiente inmediato recomendado

De mayor a menor relación beneficio/riesgo: **(1)** borrar `permissions.json`, **(2)** cablear script `test`, **(3)** migrar `marianAssistant.web.js`. Los tres son reversibles, no tocan lógica fiscal y no añaden código nuevo de peso. El split de god files (Fase 4) es el único bloque que requiere inversión previa en tests y debe tratarse como proyecto aparte.

## 10. Fase 2 aplicada (rama `fix/critical-security`)

Estado real tras ejecutar, verificado con `node --check` y `npm test`:

- **`permissions.json`**: ya corregido por otra vía antes de iniciar esta fase (commit `acec436` en `main`, ya incorporado por fast-forward). Pasó de wildcard abierto a `anonymous:false` por defecto, con allowlist explícita (`reservas.web.js`, `horario.web.js`) para los dos únicos flujos que de verdad necesitan acceso anónimo (selección de slots públicos, fichaje). **No se ha tocado de nuevo** — el punto 1 del §9 queda sin efecto porque ya estaba resuelto.
- **`marianAssistant.web.js`**: migrado de `wix-secrets-backend` (`getSecret`) a `@wix/secrets` (`secrets.getSecretValue`), mismo patrón ya usado en `cajas.web.js`/`events.js`/`fiscalDocuments.web.js`/`inventario.web.js`/`securityEngine.js`. Único punto de uso, cambio de 2 líneas. **Cerrado.**
- **Script `test`**: cableado a `node --experimental-loader ./src/backend/tests/loader.mjs --test src/backend/tests/*.test.mjs`. **Corrección sobre el plan original**: la idea inicial de "1 línea sin riesgo" era incompleta — los test `.mjs` usan especificadores Velo (`backend/x`) que no resuelven bajo Node plano; el repo ya traía un loader ESM a medida (`src/backend/tests/loader.mjs`) hecho exactamente para esto, pero nadie lo había conectado. Al activarlo salió un mock desactualizado (`@wix/essentials` no exportaba `auth`, remanente de antes de migrar `elevate`→`auth.elevate`) — corregido en el propio loader (archivo de test, no toca código de producción).
- **Resultado real de `npm test` con el fix aplicado**: 40 tests, 22 pasan, 18 fallan. De los 6 ficheros de test, 4 cargan y ejecutan (`controlOperativo.hooks`, `data.hooks`, `fiscalAggregator.read`, `unit.ssot.v5011`); 2 siguen sin cargar (`crons.jobsConfigParity.test.mjs`, `dto.whitelist.test.mjs`) por el mismo motivo: `backend/internalConfig` ya no exporta `MAPA_STAFF_FIELDS` que esos tests importan. Las 18 fallas (13 aserciones + 2 ficheros + 3 de `unit.ssot.v5011`: enums de booking, colecciones SSOT, `EU_VAT_PREFIXES`) son **drift real entre tests y el SSOT actual tras los refactors previos**, no artefactos de este cableado. **No se investigan ni corrigen en esta fase** — requieren decidir si el test está obsoleto o si el código perdió algo; eso es trabajo de Fase 3 (caracterización), no un "crítico de bajo riesgo".

**Commit único de esta fase** (3 ficheros, 6 líneas): `fix/critical-security`.
