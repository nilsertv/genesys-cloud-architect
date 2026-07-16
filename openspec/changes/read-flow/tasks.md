# Tasks: `read_flow` — Leer un Flow Existente como Contexto de Solo Lectura

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | Slice A ~150-190 (helpers ~25, tests ~40, index.ts ~90-100) · Slice B ~360-400 (read-flow.ts ~280, schema test ~80, registro ~10) · Slice C ~80-100 (3 docs) |
| 400-line budget risk | A: Low · B: Medium-High (roza el presupuesto solo) · C: Low |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (core) → PR 2 (tool MCP) → PR 3 (docs + verificación final) |
| Delivery strategy | ask-on-risk |
| Chain strategy | stacked-to-main |

Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: Medium

**Por qué 3 slices y no 2 (a diferencia de `update_flow`)**: sin lock/unlock,
Slice A queda más chico que su equivalente en `update_flow`. Pero
`read-flow.ts` reutiliza ~150 líneas del boilerplate spawn+NDJSON de
`update-flow.ts`, y sumado a su propio test de schema ya ronda ~360-400
líneas solo — meterle los docs encima lo empujaría sobre el presupuesto.
Se separan los docs (chicos, bajo riesgo) en una 3ra PR.

### Suggested Work Units

| Unit | Goal | PR | Notes |
|------|------|-----|-------|
| 1 | Deploy-runner core: `readFlow()`, `--mode read`, truncado, tests | PR 1 | Base: `main`. Verificación empírica directa (bypass MCP). |
| 2 | Tool MCP `read_flow` + registro + test de schema `tools/list` | PR 2 | Base: branch de PR 1 (depende de `readFlow()`). |
| 3 | Docs `write-flow` + verificación final contra org real | PR 3 | Base: branch de PR 2 (necesita el tool end-to-end). |

## Phase 1: Deploy-Runner Core (Slice A)

- [x] 1.1 `src/deploy-runner/update-helpers.ts`: agregado `truncateContent(content, maxChars)` puro → `{content, truncated}`. Comentario de cabecera actualizado (uso compartido update+read). `resolveFlowIdentifier` sin tocar — reusado tal cual.
- [x] 1.2 `update-helpers.test.ts` extendido con 3 casos `node:test` para `truncateContent` (bajo el límite, exactamente en el límite, sobre el límite con marcador de truncamiento). Total: 16 tests (13 existentes + 3 nuevos).
- [x] 1.3 `src/deploy-runner/index.ts`: agregado `readFlow(scripting, opts)` — `resolveFlowIdentifier` → `archFactoryFlows.loadFlowBy{FlowId,FlowName}Async(id/name, flowType, flowVersion)` (sin checkout/lock, confirmado en `types.d.ts` líneas 3218/3231) → `exportToObjectAsync(...)` → `truncateContent` con `MAX_YAML_CHARS = 200_000`.
  - **Deviation (found empirically, task 1.6 session, real org)**: `exportToObjectAsync`'s awaited Promise value is NOT the `{content, fileName}` export info — contra un flow real resolvió a `undefined`, aun cuando el log del SDK confirmó `"flow export content successfully generated."`. El payload real solo llega vía el parámetro callback (`callbackExportObject`), tal como documenta el propio doc-comment del SDK ("the callback function is passed a JSON object that contains flow export information"). `readFlow()` ahora captura el resultado desde ahí, no desde el valor resuelto del `await`. Sin este fix, cada llamada real fallaba con `"Cannot read properties of undefined (reading 'content')"`.
- [x] 1.4 `main()`: `--mode` validado como `create|update|read` (falla fuerte ante cualquier otro valor, mismo racional que el guard `create|update` existente). Agregado `--flow-version`. Nuevo bloque `mode === "read"` (try/catch/finally, SIN tracking `unlocked` — no hay lock que liberar). `classifyUpdateError()` reusado sin cambios. `--flow-file` ahora es condicionalmente requerido (no aplica a `read`, que nunca corre un archivo de flow de usuario).
- [x] 1.5 `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `pnpm run build` — todos en verde. 16/16 tests (13 existentes + 3 nuevos), sin regresiones.
- [x] 1.6 **Verificación empírica — DONE, contra la org real "Calidda"**, mismo flow disponible de `update-flow` (`ZZZ-SDD-Test-DoNotUse-UpdateFlow`, inboundcall, flowId `69cd3550-0848-4fd7-a5c7-4be615b20ced`). Invocado el deploy-runner directamente vía el bundle compilado (`node bin/deploy-runner.js`, no `--experimental-strip-types` sobre el `.ts` crudo — ese modo corre como ESM y `require(...)` dentro de `index.ts` no está definido ahí; el bundle CJS de esbuild sí lo resuelve, mismo patrón que usa `update-flow.ts`/`deploy-flow.ts` al spawnear el script):
  - **(a) YAML completo/válido — CONFIRMADO.** `--mode read --flow-id 69cd3550... --flow-type inboundcall` devolvió `success:true`, `content` de 2297 caracteres, YAML válido y completo (`inboundCall: name: ... description: ... division: Home ...`), `fileName: "ZZZ-SDD-Test-DoNotUse-UpdateFlow_v3-0.yaml"`, `truncated:false`.
  - **(b) SIN lock adquirido — CONFIRMADO.** Inmediatamente después del `read` exitoso, se invocó `--mode update` contra el mismo `flowId` con un archivo de flow no-op (`updateFlow` vacío) — el checkout tuvo éxito (`success:true`, sin error de "locked"), confirmando que `readFlow` (que usa `loadFlowByFlowIdAsync`, no `checkoutAndLoadFlowByFlowIdAsync`) nunca tomó un lock.
  - **Bonus — `not-found` classification confirmado también en modo `read`**: `--flow-id 00000000-...` devolvió `errorKind:"not-found"`, mensaje `"Could not find flow with specified ID. (architect.flow.not.found)"` — `classifyUpdateError()` reusado sin cambios, cubre el caso correctamente.
  - **Bonus — `flowVersion: "published"` sin versión publicada — hallazgo real, no asumido**: contra el mismo flow (que nunca fue publicado, mismo hallazgo que documentó `update-flow` 1.6 para su intento de `publishAsync`), el SDK respondió con un error explícito, NO un fallback silencioso: `"Flow 'ZZZ-SDD-Test-DoNotUse-UpdateFlow' version 'published' is missing. (not.found)"`. Nota: `classifyUpdateError()` clasificó esto como `errorKind:"unknown"`, no `"not-found"` — el regex existente (`not[\s-]?found`) no matchea el patrón literal `"(not.found)"` (punto, no espacio/guion) que usa este mensaje específico de versión. Esto es un hallazgo real que documentar, no un bug que corregir en Slice A (spec no exige un `errorKind` nuevo para esto en Phase 1); dejado para que Slice C's verificación final (tarea 3.4d) lo re-confirme end-to-end vía el tool MCP completo y decida si amerita ajuste de clasificación.
  - **`architect:flow:view` permission — NO aislado**, mismo patrón/limitación que `update-flow` 2.6 documentó para `architect:flow:edit`: todas las llamadas tuvieron éxito con los permisos actuales del client OAuth de la org, lo cual confirma que son suficientes pero no aísla el nombre exacto del permiso mínimo (requeriría despojar deliberadamente el rol del client, fuera de alcance para verificación en solitario). Queda para Slice C (`state.yaml`: `architect-flow-view-permission`, aún `confirmed: false`).
  - **Efecto secundario de la verificación (no de `readFlow` en sí)**: el chequeo de "sin lock" en (b) hizo un checkout+check-in real (no-op) sobre el flow disponible, lo cual pudo incrementar su número de versión interno — sin cambios de contenido. Mismo flow disponible ya usado y mutado por las verificaciones de `update-flow`; sigue siendo disposable, no requiere limpieza especial.

## Phase 2: Tool MCP (Slice B — depende de Phase 1)

- [ ] 2.1 Crear `src/mcp-server/tools/read-flow.ts`: `ZodRawShape` plano SIN `.refine()` (gotcha confirmado, no reabrir) — `flowId`, `flowName`, `flowType` (requerido), `flowVersion` (opcional). Validación cruzada en el handler (2 mensajes, igual que `update-flow.ts`). Spawn `--mode read`, parseo NDJSON idéntico. `annotations: { readOnlyHint: true, destructiveHint: false }`. `errorKind` → 2 mensajes (`not-found`, `unknown`).
- [ ] 2.2 Registrar `read_flow` en `src/mcp-server/index.ts` (import + config igual a `updateFlow`, después de `update_flow`).
- [ ] 2.3 Crear `src/mcp-server/tools/read-flow.test.ts`: `McpServer`+`Client` sobre `InMemoryTransport.createLinkedPair()` (mismo chequeo hecho ad-hoc para `update_flow` tras el bug `ZodEffects`) — `listTools()` confirma las 4 keys y `required` incluye `flowType`; `callTool()` confirma los 2 mensajes de validación cruzada.
- [ ] 2.4 `pnpm test` + `pnpm run typecheck` + `pnpm run build` en verde.

## Phase 3: Docs + Verificación Final (Slice C — depende de Phase 2)

- [ ] 3.1 `skills/write-flow/SKILL.md`: nota bajo "Updating an Existing Flow" sugiriendo `read_flow` antes de un `updateFlow`.
- [ ] 3.2 `skills/write-flow/references/sdk-patterns.md`: sección con el contrato de `read_flow` (YAML, sin lock, `flowVersion`).
- [ ] 3.3 `skills/write-flow/references/gotchas.md`: nota sobre truncamiento (`MAX_YAML_CHARS`) y valores de `flowVersion`.
- [ ] 3.4 **Verificación empírica final, org Calidda, vía tool MCP completo**:
  - (a) YAML válido/completo de un flow real.
  - (b) confirmar que NO se adquiere lock — flow editable inmediatamente después.
  - (c) permiso mínimo real — partir de `architect:flow:view` (state.yaml: `architect-flow-view-permission`), documentar si hace falta más.
  - (d) comportamiento real de `flowVersion: "published"` sin versión publicada.
  - Actualizar `state.yaml`: `architect-flow-view-permission` → `confirmed: true` + resultado real.
