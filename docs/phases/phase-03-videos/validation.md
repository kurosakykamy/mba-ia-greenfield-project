---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-12T17:58:19-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-12T17:54:56-03:00"
issues:
  - id: MD-1
    status: resolved
    summary: "Capability 'Serviço de armazenamento de arquivos' sem TD; organização de buckets/chaves indecidida"
    resolved_by: phase-03-videos/TD-08
  - id: MD-2
    status: resolved
    summary: "Capability 'Download do vídeo pelo usuário' não citada no Capability de nenhuma TD"
    resolved_by: phase-03-videos/TD-04
  - id: AMB-1
    status: resolved
    summary: "Modelo de autorização de reprodução/download não definido (autenticado vs público)"
    resolved_by: phase-03-videos/TD-04
advisories: []
---

# phase-03-videos — Validation

## Findings

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **MD-1** _(resolved_by phase-03-videos/TD-08)_ — A capability "Serviço de armazenamento de arquivos (vídeos e thumbnails)" não era citada no campo `Capability:` de nenhuma TD, e a organização de buckets/chaves — declarada decisão em aberto pelo próprio enunciado da atividade — permanecia indecidida. Resolvido pela criação da **TD-08: Organização de Buckets e Chaves de Objeto no Storage**, decidida como bucket único `streamtube` com prefixos `videos/{videoId}/source.{ext}` e `videos/{videoId}/thumbnail.jpg`, mais regra de expiração para uploads multipart abandonados.

- **MD-2** _(resolved_by phase-03-videos/TD-04)_ — A capability "Download do vídeo pelo usuário" não era citada no `Capability:` de nenhuma TD. Resolvido estendendo o campo da TD-04 para `Transversal — covers:` incluindo ambos os bullets de entrega, e registrando na Recommendation como o download se distingue do streaming: mesmo mecanismo de redirecionamento 302 para URL pré-assinada, com `response-content-disposition=attachment` acrescentado na assinatura do download. Um mecanismo, dois comportamentos — sem caminho de entrega duplicado.

- **AMB-1** _(resolved_by phase-03-videos/TD-04)_ — O modelo de autorização para reprodução e download não era determinável a partir do escopo: a convenção herdada da Fase 02 protege todo endpoint por padrão, mas "acesso anônimo" é capability declarada da Fase 05. Resolvido registrando na TD-04 que **ambos os endpoints permanecem autenticados nesta fase**, sob o `JwtAuthGuard` global; a Fase 05 fará o opt-out via `@Public()` quando a visualização anônima entrar em escopo. Abrir agora anteciparia escopo de outra fase.
