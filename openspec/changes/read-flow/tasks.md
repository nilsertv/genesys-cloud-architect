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

- [x] 2.1 Creado `src/mcp-server/tools/read-flow.ts`: `ZodRawShape` plano SIN `.refine()` (gotcha confirmado, no reabierto) — `flowId`, `flowName` (ambos opcionales), `flowType` (requerido), `flowVersion` (opcional, string simple, sin enum cerrado — la SDK es la fuente de verdad del error, per spec.md corregido). Validación cruzada en el handler (2 mensajes distintos, "neither was given" vs. "not both", idéntico texto a `update-flow.ts` post-fix). Spawn `node <deployScriptPath> --mode read --flow-type T [--flow-id I | --flow-name N] [--flow-version V]`, parseo NDJSON idéntico al patrón de `update-flow.ts` (buffer de líneas, `type:"log"`/`type:"result"`, timeout de 120s, filtro de stderr `url.parse()`/`[DEP0169]`). `annotations: { title: "Read Flow", readOnlyHint: true, destructiveHint: false }` (a diferencia de `update_flow`, `destructiveHint: true`). `ERROR_KIND_MESSAGES` mapea solo `not-found` a un mensaje distinto; `locked-by-other-user`/`type-mismatch`/`unknown` caen al mensaje crudo del SDK (nunca colapsados a un genérico) — el tipo del campo cubre las 4 variantes de `UpdateErrorKind` porque `read` reusa `classifyUpdateError()` sin cambios, aunque `locked-by-other-user` es inalcanzable en este modo (nunca hay lock). Sin `flowFile`/`forceUnlock`/`publish` (no aplican a lectura). En éxito, el texto devuelto es `resultLine.content` (el YAML tal cual, incluyendo el marcador de truncamiento si `truncateContent` lo agregó en el deploy-runner) — sin envoltorio adicional, siguiendo literalmente el data flow de `design.md` ("devuelve content como texto").
- [x] 2.2 Registrado `read_flow` en `src/mcp-server/index.ts` (import + misma config `{ region, clientId, clientSecret, deployScriptPath: envVars.DEPLOY_SCRIPT_PATH }` que especifica `design.md`).
  - **Deviation (branch-state, no de diseño)**: `design.md` especifica registrar `read_flow` inmediatamente después de `update_flow`, pero `update_flow` (Slice B de `openspec/changes/update-flow`) NO existe en esta rama — `feat/read-flow-slice-a` solo depende de `feat/update-flow-slice-a` (Slice A/PR #1, solo el core del deploy-runner), según la corrección de rama ya documentada en `state.yaml`. Se registró `read_flow` después de `test_bot_flow` (el último tool existente en este branch) con un comentario explícito en el código señalando el reordenamiento pendiente cuando ambas ramas converjan. No se trajo `update-flow.ts` desde otra rama para no duplicar trabajo de otro PR en este.
- [x] 2.3 Creado `src/mcp-server/tools/read-flow.test.ts`: `McpServer`+`Client` sobre `InMemoryTransport.createLinkedPair()` (`@modelcontextprotocol/sdk/client/index.js` + `@modelcontextprotocol/sdk/inMemory.js`). Suite 1 (`tools/list`): confirma las 4 keys exactas (`flowId`, `flowName`, `flowType`, `flowVersion`), `required: ["flowType"]`, y `readOnlyHint:true`/`destructiveHint:false`. Suite 2 (`callTool`): confirma los 2 mensajes de validación cruzada por separado y que son textualmente distintos entre sí (test explícito anti-colapso). 6 tests nuevos, todos verdes.
- [x] 2.4 `pnpm test` (26/26 verde: 20 existentes + 6 nuevos), `pnpm exec tsc --noEmit` (0 errores), `pnpm run build` (limpio), `pnpm run lint` (limpio, tras `lint:fix` de un solo wrap de línea en el test nuevo).
  - **Deviation (bugfix necesario, fuera del scope original de 2.1-2.3 pero bloqueante para verificar 2.3)**: el script `"test"` de `package.json` era `node --experimental-strip-types --test src/**/*.test.ts`. Ese glob se expande en `sh` (el shell que usan los scripts de npm/pnpm) SIN soporte de `**` recursivo real — solo matcheaba archivos `*.test.ts` un nivel bajo `src/`. `read-flow.test.ts` vive en `src/mcp-server/tools/` (2 niveles), así que `pnpm test` lo omitía en silencio (exit 0, "20 tests" en vez de 26) sin ningún error visible. Confirmado empíricamente: `sh -c 'echo src/**/*.test.ts'` expande a un solo archivo literal. Corregido a `node --experimental-strip-types --test $(find src -name '*.test.ts' | sort)`, que sí recorre recursivamente y NO recoge falsos positivos (se probó también `node --experimental-strip-types --test` sin argumentos — el auto-discovery nativo de Node SÍ recorre recursivo, pero también ejecuta accidentalmente `src/mcp-server/tools/test-bot-flow.ts` como suite vacía porque su nombre matchea el patrón `test-*` de Node, un falso positivo no relacionado con este cambio; el `find` explícito por sufijo `.test.ts` evita ese ruido). Nota: `.github/workflows/ci.yml` en esta rama (heredado de `update-flow-slice-a`) todavía NO invoca `pnpm test` — ese `run: pnpm test` se agregó recién en `update-flow-slice-b-docs` (commit `f316a2e`, aún no en esta rama) — así que este bug no rompía CI hoy, pero sí afectaba la verificación local y habría afectado a `sdd-verify`/CI en cuanto se combinen las ramas.

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
