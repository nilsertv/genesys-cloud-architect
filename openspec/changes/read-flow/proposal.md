# Proposal: `read_flow` — Exponer un Flow Existente como Contexto de Solo Lectura

## Intent

Quien escribe el TypeScript de `updateFlow(scripting, flow)` para
`update_flow` (ya implementado, PRs #1-3) nunca ve la estructura real del
flow antes de escribirlo — ni states/tasks, ni variables, ni acciones.
Ningún tool cubre esto hoy: `flow_dependencies` solo devuelve metadata +
dependencias externas; el objeto `flow` de `update_flow` se expone
únicamente DENTRO de esa misma invocación atómica, nunca antes, como
contexto. Este change agrega un tool de solo lectura que exporta la
estructura completa del flow en YAML para que el LLM decida qué cambiar
con información completa.

## Scope

### In Scope
- Nuevo modo de lectura en `src/deploy-runner/index.ts`, mismo bootstrap
  de sesión que `buildFlow`/`updateFlow`.
- `archFactoryFlows.loadFlowByFlowIdAsync`/`ByFlowNameAsync` — confirmado
  en `types.d.ts` como SIN checkout/lock, hermano explícito de
  `checkoutAndLoadFlowBy...Async` — + `exportToObjectAsync(cb,
  archEnums.FLOW_FORMAT_TYPES.yaml)` (formato explícito; el default del
  SDK es `architect`, no `yaml`).
- Reutiliza `resolveFlowIdentifier` (ya existe en `update-helpers.ts`).
- Nuevo tool MCP de solo lectura (`readOnlyHint: true`,
  `destructiveHint: false`); nombre y forma de parámetros a confirmar
  (ver Open Decisions en `state.yaml`).
- Parámetro `flowVersion` (`"latest"` default, número, `"debug"`,
  `"published"`).
- `write-flow/SKILL.md` + `sdk-patterns.md`/`gotchas.md`: nueva sección
  sobre cuándo leer antes de escribir un `updateFlow`.

### Out of Scope
- Exponer `flowFormat: "architect"` (formato semi-opaco de backup/restore,
  sin caso de uso claro aquí).
- Cambios a `update_flow`/`deploy_flow`/`flow_dependencies`.
- Approach B (REST export jobs async) y Approach C (checkout+unlock
  inmediato) — evaluados y descartados en exploración.
- Guard de tamaño para flows grandes — diferido a `sdd-design`/`sdd-spec`.
- Verificación empírica de `architect:flow:view` — diferida a `sdd-apply`.

## Capabilities

### New Capabilities
- `read-flow`: exporta la estructura completa de un flow existente en
  YAML sin adquirir lock, vía nuevo tool MCP.

### Modified Capabilities
None.

## Approach

Mismo patrón que `update_flow`: nuevo modo en el deploy-runner + tool MCP
dedicado, no un parámetro sobre un tool existente (los `annotations` MCP
son estáticos por tool; "solo lectura" no puede convivir con un tool de
semántica destructiva). A diferencia de `update_flow`, no hay lock que
gestionar: el SDK expone `loadFlowBy...Async` como hermano sin-checkout de
`checkoutAndLoadFlowBy...Async`, así que el catch path no necesita
`unlockAsync()`.

## Affected Areas

| Area | Impact | Description |
|------|--------|--------------|
| `src/deploy-runner/index.ts` | Modified | Nuevo modo de lectura, sin lock |
| `src/deploy-runner/update-helpers.ts` | Reused | `resolveFlowIdentifier`; posible extracción compartida (a decidir en design) |
| `src/mcp-server/tools/*.ts` | New | Nuevo tool MCP, nombre a confirmar |
| `src/mcp-server/index.ts` | Modified | Registro del nuevo tool |
| `skills/write-flow/*` | Modified | Nueva sección: leer antes de editar |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|--------------|
| YAML de flows grandes/complejos sin tamaño validado | Medium | Guard de tamaño a definir en spec/design |
| Sequence builders no exportan fielmente a YAML (limitación documentada de Genesys) | Low-Med | Documentar en skill; no bloquea el MVP |
| `architect:flow:view` inferido por patrón, no confirmado | Low | Verificar empíricamente en `sdd-apply` |
| `flowVersion: "published"` vs `"latest"` con default silencioso | Low | Exponer como parámetro explícito |

## Rollback Plan

Cambio puramente aditivo: ningún export/tool/schema existente se modifica
in-place. Revertir el registro del nuevo tool + su archivo + el modo de
lectura del deploy-runner deja `update_flow`/`deploy_flow`/
`flow_dependencies` intactos. Al ser solo lectura, no hay estado en la org
que revertir.

## Dependencies

- Ninguna dependencia de otro change en curso; complementa
  conceptualmente a `update-flow` pero es independiente.
- Verificación empírica de `architect:flow:view` durante `sdd-apply`.

## Success Criteria

- [ ] El tool exporta states/tasks/variables/acciones de un flow existente
      sin adquirir lock, verificado contra un org real.
- [ ] Formato YAML confirmado explícitamente (no el default `architect`
      del SDK).
- [ ] `write-flow` documenta cuándo invocar este tool antes de escribir un
      `updateFlow`.
- [ ] Permiso mínimo requerido (`architect:flow:view` u otro) confirmado
      empíricamente.
