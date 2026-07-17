# Verify Report: `update-flow` (rama `main`, HEAD `121d7eb`)

**Fecha**: 2026-07-17
**Modo**: openspec (artefactos completos: proposal, spec, design, tasks, state.yaml)
**Contexto**: primer `sdd-verify` formal de `update-flow`. El change se implementó,
revisó independientemente varias veces durante `sdd-apply`, y se mergeó a `main`
vía 3 PRs (merge commit, no squash) sin pasar por este gate. Esta es una
verificación real contra el código tal como vive hoy en `main`, no una
re-confirmación de lo que `tasks.md`/`state.yaml` ya narran.
**Veredicto final**: **PASS WITH WARNINGS** — apto para `archive`. 1 CRITICAL
formal (preexistente, ya aceptado explícitamente por el usuario, no bloqueante),
5 WARNING, 2 SUGGESTION.

## Evidencia de ejecución real (esta pasada)

| Comando | Resultado |
|---|---|
| `pnpm test` | ✅ 26/26 verde (0 fail) — 20 casos de `update-helpers.test.ts` (6 `resolveFlowIdentifier` + 7 `applyUpdateAndSave` + 5 `truncateContent` + 2 `exportFlowContent`) + 6 de `read-flow.test.ts` |
| `pnpm run typecheck` (`tsc --noEmit`) | ✅ 0 errores |
| `pnpm run lint` (biome check) | ✅ limpio, 12 archivos |
| `pnpm run build` | ✅ limpio (mcp-server 2.1mb, deploy-runner 9.3mb) |
| `git status` post-build | ✅ sin drift (`bin/deploy-runner.js`/`servers/*.js` sin diff; solo `.atl/` y `docs/assessment.md` sin trackear, no relacionados) |
| CI real en GitHub (run `29590331340`, PR #4 read-flow, contiene el merge de `update-flow` completo) | ✅ lint + typecheck + build + `pnpm test` (26/26) + smoke test (`scripts/smoke-test-tools.mjs`: "Smoke test passed: 4 tools present, each with a non-empty declared schema") — todos verdes sobre el estado real mergeado a `main` |

## 1. Cobertura de escenarios del spec (`specs/update-flow/spec.md`)

| Requisito | Escenario | Evidencia | Estado |
|---|---|---|---|
| Flow Identifier Resolution | Resolve by flowId | `update-helpers.test.ts` ("resolves by flowId") + `index.ts:417-423` llama `checkoutAndLoadFlowByFlowIdAsync` | ✅ PASS |
| Flow Identifier Resolution | Resolve by flowName+flowType | `update-helpers.test.ts` ("resolves by flowName and flowType") + `index.ts:424-428` llama `checkoutAndLoadFlowByFlowNameAsync` | ✅ PASS |
| Flow Identifier Resolution | Missing identifier | `update-flow.ts:134-146` — check manual `Boolean(flowId) === Boolean(flowName)` ANTES del `spawn` (línea 197) | ✅ PASS (comportamiento) — ver WARNING #4 (mecanismo documentado en `spec.md` ya no coincide) |
| Flow Identifier Resolution | Ambiguous identifier | Mismo check manual, rama `flowId ? "not both" : "neither"` | ✅ PASS (comportamiento) — mismo WARNING #4 |
| Non-Destructive Update Workflow | Update without publishing | `applyUpdateAndSave` test "checks in on the happy path" (`publish:false` → `checkInAsync`) | ✅ PASS |
| Non-Destructive Update Workflow | Update and publish | `applyUpdateAndSave` test "publishes on the happy path" (`publish:true` → `publishAsync`) | ✅ PASS |
| Non-Destructive Update Workflow | Never recreates the flow | Inspección de código: cero ocurrencias de `createFlow<Type>Async`/delete-route en `updateFlow()` (`index.ts` completo, `update-helpers.ts` completo) | ✅ PASS (verificación por ausencia, apropiada para este tipo de requisito) |
| Lock Handling | Locked, forceUnlock false | `classifyUpdateError()`'s rama `/locked/i` — **sin test unitario, sin verificación empírica** | 🔴 CRITICAL (ver detalle abajo) |
| Lock Handling | Locked, forceUnlock true | `identifier`+`forceUnlock` se pasan literalmente al SDK (`index.ts:419-428`) — comportamiento visible por lectura de código, pero **sin test ni verificación empírica** de que el SDK realmente fuerza el unlock | 🔴 CRITICAL (mismo ítem) |
| Flow Not Found Handling | Flow does not exist | Verificación empírica real contra org "Calidda" (`tasks.md` 1.6/2.6): texto SDK exacto capturado para ambas rutas (id/name), `classifyUpdateError()` los reconoce | ✅ PASS — ver WARNING #1 (sin regresión automatizada) |
| Orphaned Lock Prevention | Check-in fails after successful checkout | 4 tests unitarios (`applyUpdateAndSave`: mutate/checkIn/publish/double-failure) + confirmado empíricamente 3 veces contra la org real con 3 tipos de fallo distintos (`tasks.md` 1.6) | ✅ PASS — la evidencia más sólida de todo el change |
| NDJSON Protocol | Deploy-runner emits standard NDJSON lines | `emit()` en `index.ts` es la misma función compartida por los 3 modos (`create`/`update`/`read`) | ✅ PASS |
| NDJSON Protocol | update_flow parses NDJSON identically to deploy_flow | Comparación línea por línea `update-flow.ts` vs `deploy-flow.ts`: buffer/split/JSON.parse/try-catch/filtro de stderr (`url.parse()`/`[DEP0169]`) — idénticos | ✅ PASS (por inspección; ninguno de los dos tiene test de esta lógica — deuda preexistente, explícitamente fuera de scope según `design.md` § Architecture Decisions, no introducida por este change) |

## 2. CRITICAL (formal, preexistente, ya aceptado — no bloquea archive)

### Lock Handling: escenarios "locked-by-other-user" sin ninguna evidencia de runtime

`classifyUpdateError()` (`src/deploy-runner/index.ts:337-350`) NO está extraída al
módulo puro `update-helpers.ts` (a diferencia de `resolveFlowIdentifier`/
`applyUpdateAndSave`, que sí lo están precisamente para ser testeables sin
disparar el monkey-patching de `https.request`/`console.log` que `index.ts` hace
al cargar). Como consecuencia, su rama `/locked/i` — la que implementa
literalmente el requisito "Lock Handling" del spec — no tiene:

- Ningún test unitario (no hay archivo `index.test.ts`, ni extracción de la función).
- Ninguna verificación empírica: `state.yaml` (línea 61) documenta explícitamente
  que "flow locked by another user — NOT verified. Requires a second real
  user/OAuth identity holding a conflicting lock; out of scope for solo
  verification per user's explicit decision (2026-07-16)".

Esto es una decisión YA TOMADA y documentada, no un hallazgo nuevo — no la
cuestiono. La reporto en su severidad formal (regla dura del proceso de
verify: "a spec scenario is compliant only when a covering test passed at
runtime") porque es, literalmente, el único requisito del spec sin ninguna
evidencia de ejecución, ni automatizada ni manual. No bloquea `archive`: es una
limitación de infraestructura (no hay una segunda identidad OAuth real
disponible para simular el conflicto), no un defecto de diseño o
implementación — el código en sí (paso de `forceUnlock` al SDK, regex de
clasificación) es razonable y sigue el mismo patrón que sí fue confirmado
empíricamente para `not-found`. Recomiendo dejarlo documentado como limitación
permanente (no "pendiente") en el `archive-report`.

## 3. WARNING

**#1 — `classifyUpdateError()` sin regresión automatizada para NINGUNA de sus
ramas, incluyendo `not-found` (que sí fue confirmada empíricamente una vez).**
El texto SDK real capturado en `tasks.md` 1.6/2.6 (`"Could not find flow with
specified ID. (architect.flow.not.found)"`, `"no matches"`) pasó una sola vez,
de forma manual, contra la org real "Calidda". No quedó como test persistido —
si alguien edita el regex de `classifyUpdateError()` mañana y rompe la
detección de `not-found`, nada lo va a detectar salvo otra corrida manual
contra un org real. Dado que el propio `design.md` ya estableció el patrón de
"extraer a `update-helpers.ts` para poder testear sin efectos secundarios",
sería consistente extraer `classifyUpdateError()` también (es una función pura:
`(err: unknown) => UpdateErrorKind`) y cubrirla con `node:test` usando los
strings SDK reales ya capturados como fixtures.

**#2 — `update-flow.ts` no tiene un archivo de test propio (`update-flow.test.ts`),
a diferencia de `read-flow.ts`.** `read-flow.test.ts` (agregado en el change
`read-flow`, posterior) SÍ cubre exactamente esta clase de bug (`.refine()` /
`ZodEffects` rompiendo `tools/list`) — pero solo para `read_flow`, con un
comentario que cita explícitamente el bug original de `update_flow` (líneas
8-16) sin agregar el test equivalente para `update_flow` mismo. El smoke test
de CI (`scripts/smoke-test-tools.mjs`) SÍ protege a `update_flow` del caso
"schema vacío" (confirmado: `update_flow` está en `EXPECTED_TOOLS` y el run de
CI `29590331340`, sobre el `main` ya mergeado, pasó verde), pero no verifica el
set exacto de claves requeridas (`flowFile`, `flowType`) ni los dos mensajes
distintos de validación manual (`"not both"` / `"neither"`) — esa verificación
sólo existe como corrida manual de una sola vez durante `sdd-apply` (`tasks.md`
2.1, McpServer+Client real sobre `InMemoryTransport`), no persistida.

**#3 — `design.md` § Open Questions nunca se actualizó para reflejar la
resolución parcial real.** Los 2 ítems siguen con checkbox sin marcar (`- [ ]`)
tal como al momento de diseño, pero el primero (`"Exact SDK error text/status
for locked/not-found/type-mismatch"`) está PARCIALMENTE resuelto:
`not-found`/`type-mismatch` confirmados empíricamente; `locked-by-other-user`
sigue abierto (ver CRITICAL arriba). El checkbox no distingue esto — un lector
de `design.md` solo, sin cruzar con `tasks.md`, asumiría que nada se
verificó.

**#4 — `spec.md` § Flow Identifier Resolution cita un mecanismo de
implementación que el código YA NO usa.** El texto dice literalmente: *"MUST
reject any other combination via zod `.refine()` before spawning the
deploy-runner process."* Pero el `.refine()` fue deliberadamente revertido
(bug CRÍTICO real, ya corregido: `ZodEffects` rompía `tools/list`) a un check
manual post-parse en el handler (`update-flow.ts:134-146`), exactamente como
`design.md` § Zod Schema / § "CRITICAL bug found and fixed" documenta con
detalle. El COMPORTAMIENTO exigido por el spec (rechazar antes de spawnear el
proceso) se cumple y está confirmado, pero el texto del spec sigue nombrando un
mecanismo específico (`.refine()`) que ya no existe en el código — desalineado
con su propia fuente de verdad de diseño. Recomiendo actualizar `spec.md` para
decir "via input validation" o similar, sin atarse al mecanismo zod exacto.

**#5 — `skills/write-flow/references/examples/workflow.md` línea 20 sigue
usando `flow.addVariableString("callbackNumber")`, el método inexistente que
la tarea 2.4 dice haber corregido.** La corrección real (confirmada por
lectura de código) sólo tocó la sección "Variables" de
`skills/write-flow/references/sdk-patterns.md` — este archivo de ejemplo
separado, que demuestra exactamente el mismo patrón incorrecto
(`addVariableString`, que no existe en el SDK instalado 0.66.1; sólo existe
`addVariable(name, type, description?)`), quedó sin tocar. Cualquiera que
copie este ejemplo se topará con un error en runtime.

## 4. SUGGESTION

**#1 — `openspec/config.yaml` § `testing` quedó desactualizado.** Sigue
diciendo *"No test runner is installed... zero automated tests"* y
`strict_tdd: false` / `test_command: ""`, pero `update-flow` (Slice A) agregó
`node:test` con un script `pnpm test` real y hoy hay 26 tests pasando. Este
archivo es de `sdd-init` original, previo a este change, y nunca se refrescó.
No afecta el cumplimiento de `update-flow` en sí, pero puede inducir a error a
futuras fases SDD sobre las capacidades reales de testing del proyecto.
Recomiendo re-correr `/sdd-init`.

**#2 — `tasks.md` 1.3 documenta un script de test que ya no es el que está en
`package.json`.** El texto dice `"node --experimental-strip-types --test
src/**/*.test.ts"`; el `package.json` real usa `"node --experimental-strip-types
--test $(find src -name '*.test.ts' | sort)"` (cambiado por el commit
`d1cff39`, de la era `read-flow`, para descubrir archivos `*.test.ts` anidados
que el glob no alcanzaba). Funcionalmente correcto (`pnpm test` corre y pasa
26/26), sólo el texto de `tasks.md` quedó como una foto vieja.

## 5. Nota especial — reordenamiento de `src/mcp-server/index.ts` por el merge de `read-flow`

Confirmado con evidencia directa, no supuesto: `git diff 997c3bf dbc7598 --
src/mcp-server/index.ts` muestra que el merge que trajo `read_flow` sólo
AGREGÓ el import y el bloque de registro de `read_flow` (9 líneas, todas
adiciones, cero eliminaciones) inmediatamente después del bloque de
`update_flow` (líneas 59-69, sin tocar). El corrimiento posicional de
`read_flow` en el archivo no modificó ni un carácter de la config/handler de
`update_flow`. La corrida de CI real sobre ese mismo merge commit (run
`29590331340`) confirma en vivo que `update_flow` sigue anunciando su schema
completo en `tools/list` (smoke test verde) y que los 26 tests siguen
pasando.

## 6. `open_decisions` de `state.yaml` — estado real confirmado

| id | decisión | confirmado en código |
|---|---|---|
| `tool-surface` | `new-tool` | ✅ `update_flow` es un tool MCP dedicado, separado de `deploy_flow` (`src/mcp-server/tools/update-flow.ts`) |
| `test-strategy` | `narrow-node-test` | ✅ sólo existe `update-helpers.test.ts` (lógica pura extraída), no hay instalación de vitest ni suite completa |
| `pr-slicing` | `two-slices-stacked-to-main` | ✅ a nivel de fases (Phase 1 → Phase 2); a nivel de PRs reales terminó en 3 (`slice-a`, `slice-b`, `slice-b-docs`) — el propio `state.yaml` (apply.note) documenta el split adicional código/docs para presupuesto de revisión; no es una contradicción, es un refinamiento explícito y ya registrado |

## 7. ¿Listo para archive?

**Sí.** El código en `main` cumple genuinamente la gran mayoría del spec, con
evidencia real (tests unitarios + verificación empírica contra org real + CI
verde sobre el estado mergeado, no sólo sobre las ramas de feature ya
borradas). Los bugs CRÍTICOS ya documentados en `tasks.md`/`state.yaml` (el
`.refine()`/`ZodEffects` rompiendo `tools/list`, y el `type-mismatch` plegado
en `not-found`) están correctamente reflejados en el código real, confirmados
por lectura directa y por la corrida de CI sobre el commit de merge.

El único CRITICAL formal (Lock Handling sin evidencia) es una limitación
preexistente y ya aceptada explícitamente por decisión del usuario — no una
regresión ni un descubrimiento que requiera reabrir `sdd-apply`. Los 5 WARNING
y 2 SUGGESTION son gaps de cobertura de test / prolijidad documental menores,
ninguno afecta el comportamiento en producción. Recomiendo proceder a
`sdd-archive`, dejando estos 8 hallazgos documentados en el `archive-report`
como deuda conocida (no bloqueante) para una futura pasada.
