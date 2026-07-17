# Verify Report: `read-flow` (rama `feat/read-flow-slice-a`)

**Fecha**: 2026-07-16 (re-verificación de cierre, sobre `cbffcdc`)
**Modo**: openspec (artefactos completos: proposal, spec, design, tasks, state.yaml)
**Veredicto final**: **PASS WITH WARNINGS** (0 CRITICAL, 0 WARNING nuevos bloqueantes, 2 SUGGESTION)

Esta es una re-verificación de cierre, no una auditoría completa nueva. La
pasada anterior (commit previo a `cbffcdc`, ver historial de este mismo
archivo) encontró 1 CRITICAL + 2 WARNING + 1 SUGGESTION, todos gaps de
verificación empírica. `sdd-apply` (commit `cbffcdc`, tarea `tasks.md` 3.5)
cerró los 4 con 5 llamadas empíricas reales adicionales contra la org real
"Calidda", vía el tool MCP completo (sin bypass del deploy-runner). Esta
pasada confirma, con evidencia propia, que el cierre fue efectivo.

## 1. Escenario "flowType mismatch" (CRITICAL original)

`spec.md` líneas 68-77 ya no dice "(unverified — expected fold into
not-found)"; dice "(confirmed — folds into not-found)" y documenta
inline: `flowName: "ZZZ-SDD-Test-DoNotUse-UpdateFlow"` + `flowType:
"outboundcall"` (en vez del real `"inboundcall"`) → `errorKind:
"not-found"`.

`tasks.md` 3.5(a) reporta la misma llamada, el mismo `flowName`, el mismo
`flowType` incorrecto, y el mismo resultado textual (`isError: true`, el
mensaje mapeado exacto de `ERROR_KIND_MESSAGES["not-found"]`). Confirmé
que ese string literal existe hoy en `src/mcp-server/tools/read-flow.ts`
líneas 35-36 y coincide carácter por carácter con lo citado en `tasks.md`.

**Veredicto**: CERRADO correctamente. Hay un `errorKind` concreto
(`"not-found"`), no una afirmación vacía de "se espera que". `spec.md` y
`tasks.md` son consistentes entre sí (mismo `flowName`, mismo `flowType`,
mismo resultado).

## 2. Escenario "Resolve by flowName and flowType" (WARNING #1 original)

`tasks.md` 3.5(b): `tool.handler({ flowName: "ZZZ-SDD-Test-DoNotUse-UpdateFlow",
flowType: "inboundcall" })` (tipo correcto) devolvió YAML de 2297
caracteres, idéntico byte a byte al obtenido vía `flowId` en 1.6/3.4a —
confirma que `readFlow()` invoca `loadFlowByFlowNameAsync`, no solo
`loadFlowByFlowIdAsync`. Antes de este cierre, esa rama de código solo
tenía cobertura de unit test sobre `resolveFlowIdentifier` (función pura),
nunca del wiring real.

**Veredicto**: CERRADO. Camino real ejercitado por primera vez,
consistente con lo declarado.

## 3. Escenario "Default and valid explicit versions" (WARNING #2 original)

`spec.md` líneas 88-101 ahora documenta los 4 valores de `flowVersion`:
omitido/`"latest"` (éxito), número explícito `"3.0"` (éxito, YAML
idéntico), `"debug"` y `"published"` (ambos SDK 404 explícito en este
flow desechable, sin sesión de debug activa ni versión publicada — rama
de fallo, no de éxito).

`tasks.md` 3.5(c) reporta las mismas 2 llamadas nuevas (`flowVersion:
"debug"` → 404 explícito `"version 'debug' is missing. (not.found)"`;
`flowVersion: "3.0"`, tomado del `fileName` real ya observado en 1.6/3.4,
no inventado → éxito, YAML idéntico de 2297 caracteres). Mismos números,
mismo `flowId`, sin contradicciones entre `spec.md` y `tasks.md`.

**Veredicto**: CERRADO. Los 4 valores tienen evidencia empírica real; 2
en su rama de éxito, 2 en su rama de fallo (documentado explícitamente
como limitación del flow desechable disponible, no como gap sin
explorar).

## 4. Conteo de tests en `tasks.md` 1.2 (SUGGESTION original)

`tasks.md` 1.2 tiene ahora una "Nota retroactiva (sdd-verify, 2026-07-16)"
que corrige el conteo histórico de 16 a 20 tests para
`update-helpers.test.ts`, aclarando que el rollup final (20+6=26) ya
estaba bien reportado en 2.4/3.4.

Confirmé con `pnpm test` real (no solo lectura del texto):

```
ℹ tests 26
ℹ suites 6
ℹ pass 26
ℹ fail 0
```

`update-helpers.test.ts` aporta 20 (6 `resolveFlowIdentifier` + 7
`applyUpdateAndSave` + 5 `truncateContent` + 2 `exportFlowContent`),
`read-flow.test.ts` aporta 6. Coincide exactamente.

**Veredicto**: CERRADO.

## Evidencia de ejecución real (esta pasada, HEAD = `cbffcdc`)

| Comando | Resultado |
|---|---|
| `pnpm test` | ✅ 26/26 verde (0 fail) |
| `pnpm exec tsc --noEmit` | ✅ 0 errores |
| `pnpm run lint` (biome check) | ✅ limpio |
| `pnpm run build` | ✅ limpio (mcp-server 2.1mb, deploy-runner 9.3mb) |
| `git status` post-build | ✅ sin cambios no deseados en el repo (solo `.atl/` y `docs/assessment.md`, no relacionados con este change) |

## Repaso liviano del resto del spec (sin re-auditar desde cero)

Confirmé por lectura de código (no solo por confiar en el texto) que las
partes que ya habían pasado en la primera verificación siguen intactas:

- `readOnlyHint: true` / `destructiveHint: false` presentes en
  `read-flow.ts` líneas 104-105.
- `inputSchema` sigue siendo un `ZodRawShape` plano, comentario explícito
  contra `.refine()` en las líneas 49-50.
- Protocolo NDJSON (`type: "log"` / `type: "result"`) sin cambios.
- `state.yaml`: los 5 `open_decisions` siguen consistentes con el código
  (`architect-flow-view-permission` sigue honestamente `confirmed: false`
  con nota explicando el límite, tal como en la pasada anterior — no
  reabierto).
- La deuda técnica aceptada explícitamente por el usuario (falta de test
  para el mapeo `errorKind`/NDJSON del handler, `tasks.md` 2.4) sigue
  documentada igual, no reabierta.

No se encontraron regresiones.

## Hallazgo nuevo, no bloqueante (fuera del scope de las 4 cierres pedidos)

### SUGGESTION (nueva)

**Dos escenarios de `spec.md` retienen etiquetas "(unverified)"/lenguaje
"MUST be confirmed" a pesar de que su evidencia ya existe en `tasks.md`
desde antes de esta ronda de cierre — inconsistencia cosmética
preexistente, no introducida por `cbffcdc`.**

Confirmado por `git show cbffcdc -- specs/read-flow/spec.md`: el diff de
cierre tocó únicamente los escenarios "flowType mismatch" y "Default and
valid explicit versions". Los siguientes 2 escenarios NO fueron tocados
y siguen con texto textualmente sin actualizar:

1. **"Invalid version value rejected by the SDK"** (`spec.md` líneas
   103-111): dice *"the exact `errorKind` classification is unverified —
   confirm empirically during `sdd-apply` ... filed under `"unknown"`
   pending Slice C review"*. Pero Slice C (`tasks.md` 3.4d) SÍ revisó esto
   y confirmó `errorKind: "unknown"` end-to-end vía el tool MCP completo
   — el texto nunca se actualizó para reflejar que la revisión pendiente
   ya ocurrió.
2. **"Published requested but none exists (unverified)"** (`spec.md`
   líneas 112-115): el título y el cuerpo siguen diciendo "UNVERIFIED —
   MUST be confirmed during `sdd-apply`, not assumed to fall back
   silently". Pero esto ya está confirmado en `tasks.md` 1.6 (bonus) y
   3.4d: el SDK devuelve un error explícito 404, no un fallback
   silencioso — dato real, no supuesto.

Estos 2 casos ya habían sido evaluados como ✅ COMPLIANT en la matriz de
la verificación original (filas 8 y 9), apoyándose en la evidencia real de
`tasks.md`, a pesar de que el texto de `spec.md` seguía sin actualizar —
es decir, este gap de documentación existe desde antes del cierre de
`cbffcdc` y nunca formó parte de los 4 ítems que esa pasada de `sdd-apply`
debía cerrar. No es deuda técnica reabierta ni una decisión ya aceptada
que se esté cuestionando — es una observación nueva sobre prolijidad
documental. **No bloquea `archive`**: la evidencia real ya existe y ya fue
validada por partida doble (verify original + esta re-verificación); solo
el texto de `spec.md` quedó desalineado con su propia evidencia. Se
recomienda un ajuste cosmético de texto (quitar "(unverified)"/"MUST be
confirmed" y reemplazar por "CONFIRMED" con la cita del hallazgo real,
igual que se hizo para los otros 2 escenarios) en algún momento, pero no
amerita reabrir `sdd-apply`.

## ¿Listo para archive?

**Sí.** Los 4 ítems que motivaron la ronda anterior de cierre
(`sdd-apply` commit `cbffcdc`) están genuinamente cerrados con evidencia
empírica real, verificada de forma independiente en esta pasada (no solo
confiando en que el reporte anterior decía que estaba cerrado):

- CRITICAL (flowType mismatch): CERRADO, `errorKind` concreto documentado
  y consistente entre `spec.md`/`tasks.md`.
- WARNING #1 (flowName+flowType end-to-end): CERRADO.
- WARNING #2 (flowVersion debug/número explícito): CERRADO.
- SUGGESTION (conteo de tests stale): CERRADO.

`pnpm test` (26/26), `pnpm exec tsc --noEmit` (0 errores), `pnpm run
lint` (limpio) y `pnpm run build` (limpio) confirmados por ejecución real
en esta pasada, no solo por lectura de `tasks.md`. Ninguna regresión
encontrada en el resto del spec.

El único hallazgo nuevo es una SUGGESTION cosmética (2 escenarios de
`spec.md` con lenguaje "(unverified)" desactualizado pese a tener
evidencia real ya documentada en `tasks.md`) — no bloqueante, no
relacionado con los 4 ítems que se pidió cerrar, y no reabre ninguna
decisión ya aceptada.
