# Verify Report: `read-flow` (rama `feat/read-flow-slice-a`)

**Fecha**: 2026-07-16
**Modo**: openspec (artefactos completos: proposal, spec, design, tasks, state.yaml)
**Veredicto final**: **PASS WITH WARNINGS**

## Corrección de recuento

El spec.md tiene **7 Requirements / 12 Scenarios** (`grep -c "^#### Scenario"` = 12,
`grep -c "^### Requirement"` = 7), no "8 requisitos, 15 escenarios" como indicaba el
brief de esta verificación. Conteo real usado abajo.

## Completeness (tasks.md)

14/14 tareas marcadas `[x]` — las 14 están **genuinamente implementadas**, confirmado
contra código real, no solo la marca de checkbox:

| Fase | Tareas | Estado |
|---|---|---|
| Phase 1 (Slice A — core) | 1.1–1.6 | ✅ Verificado contra código (`update-helpers.ts`, `index.ts`) |
| Phase 2 (Slice B — tool MCP) | 2.1–2.4 | ✅ Verificado contra código (`read-flow.ts`, `index.ts` registro) |
| Phase 3 (Slice C — docs) | 3.1–3.4 | ✅ Verificado contra `skills/write-flow/**` |

## Evidencia de ejecución real

| Comando | Resultado |
|---|---|
| `pnpm test` | ✅ 26/26 verde (0 fail) — coincide exactamente con lo declarado en tasks.md 2.4/3.4 |
| `pnpm exec tsc --noEmit` | ✅ 0 errores |
| `pnpm run lint` (biome check) | ✅ limpio |
| `pnpm run build` | ✅ limpio (mcp-server 2.1mb, deploy-runner 9.3mb) |
| `git status` post-build | ✅ sin cambios no deseados en el repo |

`package.json`'s `"test"` script confirmado como
`node --experimental-strip-types --test $(find src -name '*.test.ts' | sort)` — el fix
de descubrimiento recursivo (commit `d1cff39`) está aplicado y funcionando; recoge
`src/mcp-server/tools/read-flow.test.ts` (2 niveles de profundidad) sin problema.

`.github/workflows/ci.yml` en esta rama, confirmado, **todavía no invoca `pnpm test`**
— consistente con lo documentado en `state.yaml` (ese paso llegó en
`update-flow-slice-b-docs`, commit `f316a2e`, no presente en esta rama). No es un
hallazgo nuevo, ya está correctamente reflejado.

## Matriz de cumplimiento de escenarios (12/12)

| # | Requirement | Scenario | Evidencia | Estado |
|---|---|---|---|---|
| 1 | Flow Identifier Resolution | Resolve by flowId | Unit test (`resolveFlowIdentifier`) + empírico real (1.6a, 3.4a, vía `--flow-id`) | ✅ COMPLIANT |
| 2 | Flow Identifier Resolution | Resolve by flowName and flowType | Solo unit test de `resolveFlowIdentifier` (función pura); el camino real `readFlow()` → `loadFlowByFlowNameAsync` **nunca fue ejercitado**, ni por test ni empíricamente — las 2 rondas de verificación empírica (1.6, 3.4) usaron `--flow-id` exclusivamente | ⚠️ **GAP — ver WARNING #1** |
| 3 | Flow Identifier Resolution | Missing or ambiguous identifier | `read-flow.test.ts` (2 mensajes distintos, `callTool`) + `resolveFlowIdentifier` unit tests | ✅ COMPLIANT |
| 4 | Read-Only Export Workflow | Successful export, no side effects | Empírico real, 2 rondas (1.6a/b, 3.4a/b) — YAML completo confirmado, ausencia de lock confirmada (`--mode update` inmediato después tuvo éxito) | ✅ COMPLIANT (fuerte) |
| 5 | Flow Not Found Handling | Flow does not exist | Empírico real (1.6 bonus, 3.4 bonus) + `classifyUpdateError` (deuda de test de mapeo `errorKind`/NDJSON ya aceptada explícitamente, tarea 2.4 — no reabierta aquí) | ✅ COMPLIANT |
| 6 | Flow Not Found Handling | flowType mismatch (unverified) | spec.md exige literalmente "MUST be confirmed empirically during sdd-apply, not assumed" — **ninguna llamada con `flowName` + `flowType` incorrecto aparece en tasks.md**; 1.6/3.4 solo prueban `--flow-id` | ❌ **NO CUMPLIDO — ver CRITICAL #1** |
| 7 | Flow Version Parameter | Default and valid explicit versions | Solo `"latest"` (omitido, éxito) confirmado; `"debug"` y un número de versión explícito **nunca fueron ejercitados** (ni éxito ni fallo) | ⚠️ **GAP — ver WARNING #2** |
| 8 | Flow Version Parameter | Invalid version value rejected by SDK | El propio spec designa el hallazgo `flowVersion:"published"` como la evidencia confirmatoria de este escenario, y fue re-confirmado end-to-end en 3.4d | ✅ COMPLIANT |
| 9 | Flow Version Parameter | Published requested but none exists | Empírico real, 2 rondas (1.6 bonus, 3.4d) — error explícito del SDK, no fallback silencioso | ✅ COMPLIANT |
| 10 | MCP Tool Annotations | Tool metadata reflects non-destructive intent | `read-flow.test.ts` (`readOnlyHint:true`, `destructiveHint:false`) | ✅ COMPLIANT |
| 11 | NDJSON Protocol | Deploy-runner emits standard NDJSON lines | Empírico end-to-end (3.4, vía el tool MCP real + spawn real) — el parseo funcionó correctamente en los 4 casos probados | ✅ COMPLIANT |
| 12 | Output Size Guard | Large flow export (deferred to design) | Mecanismo de truncamiento unit-testeado exhaustivamente (`truncateContent`: bajo/en/sobre el límite, `maxChars<=0`); el valor concreto `MAX_YAML_CHARS=200_000` sigue sin validar contra un flow grande real — **ya documentado como riesgo abierto en `design.md`/`gotchas.md`, no es hallazgo nuevo** | ✅ COMPLIANT (mecanismo probado; constante es deuda ya aceptada) |

**10/12 COMPLIANT, 2 GAP (WARNING), 1 no cumplido contra su propio MUST (CRITICAL)**
— nota: el escenario #6 se cuenta aparte como CRITICAL porque el propio spec lo exige
como bloqueante ("not assumed"), no como un WARNING más.

## Fidelidad a design.md

Las 3 desviaciones ya conocidas y aceptadas están **correctamente reflejadas**, confirmado
por lectura directa del código:
- Bug de `exportToObjectAsync` (el valor resuelto del `await` es `undefined`; el payload
  real llega solo por el callback) — documentado en el doc-comment de `exportFlowContent`
  (`update-helpers.ts`) y en el de `readFlow()` (`index.ts`), y cubierto por un unit test
  específico (`"resolves with the callback's payload, not the awaited return value"`).
- `flowVersion` sin enum cerrado — `z.string().min(1).optional()` en `read-flow.ts`,
  coincide con `design.md`'s Zod Schema y con `spec.md` post-fix (commit `b2e1005`).
- Registro de `read_flow` después de `test_bot_flow` en vez de después de `update_flow`
  — comentario explícito en `src/mcp-server/index.ts` (líneas 67-72) documentando la
  razón (branch-state) y el reordenamiento pendiente.

No se encontraron desviaciones NUEVAS no documentadas entre código y `design.md`.

## Consistencia entre artefactos

- La contradicción `spec.md` vs. `design.md` sobre `.refine()`/enum cerrado de
  `flowVersion` fue efectivamente corregida (commit `b2e1005`, confirmado por diff:
  `spec.md` + `state.yaml`, +45/-20 líneas). `spec.md` actual (leído completo) exige
  `ZodRawShape` plano sin `.refine()` y `flowVersion` como string abierto — coincide
  con `design.md` y con el código real.
- No se encontró ninguna otra contradicción entre `spec.md`/`design.md`/`tasks.md`/código
  en esta pasada.

## `open_decisions` de `state.yaml`

| id | `confirmed` | ¿Genuinamente implementado así? |
|---|---|---|
| `tool-name` (`read_flow`) | `true` | ✅ — tool registrado literalmente como `"read_flow"` |
| `flow-format-param` (yaml fijo) | `true` | ✅ — `archEnums.FLOW_FORMAT_TYPES.yaml` hardcodeado, sin parámetro `flowFormat` en el schema |
| `size-guard-strategy` (truncar en 200_000) | `true` | ✅ — `MAX_YAML_CHARS = 200_000` en `index.ts`, mecanismo unit-testeado |
| `resolve-flow-identifier-sharing` (reuso sin extraer) | `true` | ✅ — `resolveFlowIdentifier` importado tal cual desde `update-helpers.ts`, header comment actualizado como se describe |
| `architect-flow-view-permission` | `false` | ✅ **correctamente documentado como no-verificable**, no como un olvido — nota detallada y honesta explicando por qué (requeriría un segundo cliente OAuth deliberadamente despojado, fuera de alcance para verificación en solitario) |

Los 4 `confirmed: true` están genuinamente implementados tal como se declaran. El único
`confirmed: false` está correctamente tratado como lo que es: un límite honesto de la
verificación en solitario, no un descuido.

## Issues

### CRITICAL

1. **Escenario "flowType mismatch" (Requirement: Flow Not Found Handling) sin la
   verificación empírica que el propio `spec.md` exige como bloqueante.**
   `spec.md` línea 71-72 dice textualmente: *"AND MUST be confirmed empirically during
   `sdd-apply`, not assumed."* Ninguna de las 2 rondas de verificación empírica
   (tasks.md 1.6, 3.4) invocó `read_flow`/`readFlow()` con `flowName` + un `flowType`
   que no corresponde al flow real — ambas rondas usan `--flow-id` exclusivamente en
   los 4 sub-casos que documentan (YAML válido, sin lock, not-found, `published` sin
   publicar). A diferencia de `architect-flow-view-permission` (que sí quedó
   honestamente abierto en `state.yaml` con `confirmed:false` y una nota explicando el
   límite), este gap **no está reflejado como pendiente en ningún artefacto** — ni en
   `open_decisions`, ni como nota en tasks.md señalando que quedó sin confirmar. El
   riesgo funcional real es bajo (hay precedente directo y confirmado: `update_flow`
   ya probó el comportamiento análogo de `checkoutAndLoadFlowBy...Async` con
   `flowName`+`flowType` incorrecto), pero el propio spec pidió explícitamente NO
   asumir por analogía, y eso es justamente lo que terminó ocurriendo sin quedar
   documentado como tal.
   **Acción recomendada**: 1 llamada adicional y barata contra el mismo flow
   disponible (`ZZZ-SDD-Test-DoNotUse-UpdateFlow`, ya disposable) con `flowName`
   correcto + un `flowType` incorrecto (p. ej. `"digitalbot"` en vez de
   `"inboundcall"`), documentar el resultado en `tasks.md`/`state.yaml`. Si el
   resultado confirma el fold-into-not-found esperado, esto se resuelve en minutos sin
   reabrir una ronda completa de `sdd-apply`.

### WARNING

1. **Escenario "Resolve by flowName and flowType" (Requirement: Flow Identifier
   Resolution) — camino real hacia `loadFlowByFlowNameAsync` nunca ejercitado.**
   `resolveFlowIdentifier`'s rama `byName` está bien cubierta a nivel de función pura
   (`update-helpers.test.ts`), pero ningún test ni verificación empírica confirma que
   `readFlow()` (`index.ts`) efectivamente invoca `archFactoryFlows.loadFlowByFlowNameAsync`
   cuando se le pasa `flowName`+`flowType` — las 2 rondas empíricas (1.6, 3.4) usaron
   `--flow-id` en sus 4 sub-casos documentados. Riesgo funcional bajo (el cableado es
   un ternario trivial: `identifier.kind === "byId" ? loadFlowByFlowIdAsync : loadFlowByFlowNameAsync`),
   pero es una rama de código sin evidencia de ejecución real, ni mockeada ni contra la
   org real. Se puede cerrar con la misma llamada extra sugerida en CRITICAL #1 (que
   ya usa `flowName`), más una segunda con `flowName` + `flowType` CORRECTO para
   confirmar el camino de éxito.

2. **Escenario "Default and valid explicit versions" (Requirement: Flow Version
   Parameter) — solo 2 de 4 valores cubiertos, y uno de ellos solo en su rama de
   fallo.** Confirmado empíricamente: `flowVersion` omitido (`"latest"` por defecto,
   éxito) y `"published"` (pero únicamente su rama de fallo, sobre un flow nunca
   publicado). `"debug"` y un número de versión de commit explícito **nunca fueron
   probados**, ni en su rama de éxito ni en la de fallo. El spec agrupa los 4 valores
   en un solo escenario que exige que TODOS "MUST pass ... and that version MUST be
   requested from the SDK" — con 2 de 4 sin ninguna evidencia, el escenario no está
   completamente probado tal como está redactado.

### SUGGESTION

1. **`tasks.md` 1.2 declara un conteo de tests desactualizado.** Dice *"Total: 16 tests
   (13 existentes + 3 nuevos)"* para `update-helpers.test.ts`, pero ese número quedó
   stale después de la deviation documentada en 2.4 (commit `b218a57`, que agregó 2
   tests más de guard `maxChars<=0` para `truncateContent` + 2 de `exportFlowContent`).
   El archivo real tiene hoy 20 tests (confirmado por `pnpm test`), no 16. No es un
   error funcional — 2.4/3.4 sí reportan el rollup final correcto (20 existentes + 6
   nuevos de `read-flow.test.ts` = 26, que coincide exactamente con la ejecución real)
   — es solo una nota histórica de 1.2 que no se actualizó retroactivamente. Cosmético,
   no bloquea archive.

2. **Costo-beneficio de cerrar los 2 gaps de arriba antes de archivar.** El flow de
   prueba disponible (`ZZZ-SDD-Test-DoNotUse-UpdateFlow`) sigue siendo el mismo
   disposable ya mutado repetidamente por las verificaciones previas de `update-flow` y
   `read-flow`. Cerrar CRITICAL #1 y WARNING #1/#2 costaría ~3-4 llamadas adicionales
   al tool/deploy-runner contra ese mismo flow (una con `flowName`+`flowType`
   incorrecto, una con `flowName`+`flowType` correcto, una con `--flow-version debug`,
   una con un número de versión explícito) — más barato que reabrir `sdd-apply`
   completo, y cerraría la brecha entre lo que `spec.md` exige y lo que quedó
   verificado.

## ¿Listo para archive?

**No sin resolver el CRITICAL.** El bloqueo real es puntual y barato de cerrar (no
requiere cambios de código, solo 1-4 llamadas empíricas adicionales documentadas), pero
tal como está, la Escenario "flowType mismatch" de `spec.md` — que el propio spec marca
como bloqueante ("MUST be confirmed... not assumed") — no tiene evidencia de haberse
cumplido, y ese vacío no quedó honestamente reflejado como pendiente en ningún
artefacto (a diferencia de `architect-flow-view-permission`, que sí lo está). Los 2
WARNING (flowName end-to-end, flowVersion debug/numérico) no son bloqueantes por sí
solos, pero conviene cerrarlos en la misma pasada ya que comparten la misma causa raíz
(las 2 rondas de verificación empírica se concentraron exclusivamente en `--flow-id` +
`flowVersion` por defecto/`published`).

Todo lo demás — tests (26/26), typecheck, lint, build, fidelidad a `design.md`,
consistencia entre artefactos, y el estado real de los 5 `open_decisions` — está limpio
y no bloquea archive.
