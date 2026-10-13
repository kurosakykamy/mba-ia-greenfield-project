---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-10-11T23:51:01-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-12T17:54:56-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-10-11T23:51:01-03:00"
  docs/phases/phase-02-auth/context.md: "2026-10-11T23:51:01-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-10-11T23:51:01-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade público/unlisted e fluxo de publicação (Fase 04). Player, página de visualização, contagem de views e sugestões (Fase 05). Likes, comentários e inscrições (Fase 06). Qualquer interface de vídeo em `next-frontend/`.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo não faz parte desta fase; a entrega é backend, worker e infraestrutura.

**Sequencing notes:** Depende das Fases 01 e 02 (ambiente Docker, config namespaces, migrations versionadas, auth com guard JWT global, entidade `Channel` com relação 1:1 a `User`). O vídeo pertence ao canal (`channels.id`), não ao usuário.

**Neighbors (for boundary detection only):**

- **Fase 02 — Cadastro, Login e Gerenciamento de Conta:** entrega o canal criado automaticamente por usuário, que é o dono dos vídeos desta fase.
- **Fase 04 — Gerenciamento de Vídeos e Canal:** consome a entidade de vídeo desta fase para edição, categorias, visibilidade e painel do canal.

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia de Fila de Processamento em Segundo Plano | decided | A (BullMQ + Redis via `@nestjs/bullmq`) | `@nestjs/bullmq`, `bullmq` |
| phase-03-videos/TD-02 | phase | Backend | Estratégia de Upload de Vídeos de Até 10GB | decided | A (Multipart com URLs pré-assinadas por parte) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-03 | phase | Backend | Gatilho do Processamento Após o Upload | decided | A (Endpoint de finalização explícito) | — |
| phase-03-videos/TD-04 | phase | Backend | Estratégia de Streaming e Download | decided | A (Redirecionamento 302 para URL pré-assinada; download força anexo; ambos autenticados) | `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` |
| phase-03-videos/TD-05 | phase | Backend | Execução do Worker e Extração de Metadados/Thumbnail | decided | A (Contexto Nest standalone + FFmpeg lendo via URL pré-assinada) | `fluent-ffmpeg`, `@types/fluent-ffmpeg` |
| phase-03-videos/TD-06 | phase | Backend | Formato do Identificador de URL Única | decided | A (nanoid) | `nanoid@^3` (v4+ é ESM-only) |
| phase-03-videos/TD-07 | phase | Backend | Ciclo de Status do Vídeo e Comportamento em Falha | decided | A (Retentativa automática da fila + status `failed` definitivo) | — |
| phase-03-videos/TD-08 | phase | Backend | Organização de Buckets e Chaves de Objeto | decided | A (Bucket único `streamtube` com prefixos por tipo) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase)

_Versões concretas e notas de compatibilidade em `library-refs.md` (resolvidas via registry npm dentro do container e verificadas via context7)._

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-08 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-03, phase-03-videos/TD-05, phase-03-videos/TD-07 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-05 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04 _(Transversal)_ |
| Download do vídeo pelo usuário | phase-03-videos/TD-04 _(Transversal)_ |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** BullMQ + Redis — é o caminho oficial do NestJS (`@nestjs/bullmq`), com retry/backoff declarativo por job e boa observabilidade (Bull Board), que ajuda diretamente no requisito de "o que acontece em caso de falha no processamento" (TD-07). A atividade já prevê a fila como peça de infraestrutura nova e testável via Compose — Redis é a peça mais madura e documentada para esse papel. pg-boss (Option B) é uma alternativa legítima para quem prioriza zero infraestrutura nova, mas a ausência de integração oficial do NestJS a torna mais trabalhosa de manter consistente com o resto do projeto.

**Libraries:** —

### phase-03-videos/TD-02

**Recommendation:** Multipart com URLs pré-assinadas — usa exatamente a API que o S3 já expõe, documentada pelo SDK oficial (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), sem introduzir um servidor de protocolo adicional. A resumabilidade exigida pelo `project-plan.md` é satisfeita no nível de parte (reenviar só a parte que falhou), o que é suficiente para o escopo desta fase — Option B resolveria resumabilidade de forma mais granular, mas ao custo de uma peça de infraestrutura (`tusd`) que não se integra diretamente ao object storage S3-compatível.

**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** Endpoint de finalização explícito — mantém a autorização e o ciclo de vida do vídeo inteiramente sob o controle da API, que já precisa existir para o `CompleteMultipartUploadCommand` de qualquer forma (Option B não elimina essa chamada). Simplicidade de infraestrutura pesa a favor: nenhuma configuração adicional no object storage.

**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** Redirecionamento 302 para URL pré-assinada — é a única opção coerente com a decisão já tomada em TD-02 de manter a API fora do caminho dos bytes. Qualquer estratégia de proxy (Option B) desfaz esse ganho exatamente no lado de leitura, que é o lado com mais concorrência potencial (muitos espectadores por vídeo, contra um único uploader por vídeo). Streaming e download usam o **mesmo** mecanismo, diferindo por um parâmetro: o download inclui `response-content-disposition=attachment` na URL pré-assinada; o streaming omite e deixa o object storage servir `Range`/`206`. Ambos permanecem **autenticados** nesta fase sob o `JwtAuthGuard` global — "acesso anônimo" é capability da Fase 05.

**Libraries:** `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`

### phase-03-videos/TD-05

**Recommendation:** Contexto de aplicação Nest + FFmpeg lendo via URL — reaproveita integralmente os padrões, entidades e configuração já estabelecidos no projeto (único ponto de verdade para o Data Model), e a leitura via URL pré-assinada evita o custo de baixar arquivos de até 10GB para disco antes de processar, resolvendo tanto a extração de metadados (`ffprobe`) quanto a geração de thumbnail (`screenshots()`) a partir da mesma URL de leitura.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** nanoid — é o padrão direto para "identificador curto e único", sem a necessidade de coordenação de sequência (Option C) nem o problema de tamanho do UUID (Option B). A garantia final de unicidade continua sendo a constraint `UNIQUE` do Postgres, com retentativa em colisão seguindo o padrão já resolvido em `ChannelsService`.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Retentativa automática da fila + `failed` definitivo — falhas transitórias (rede, contenção momentânea) são o caso mais comum em processamento assíncrono contra um storage externo, e a fila escolhida em TD-01 já resolve isso nativamente sem código extra. O estado `failed` com causa persistida cobre o caso de falha definitiva exigido pela atividade.

**Libraries:** —

### phase-03-videos/TD-08

**Recommendation:** Bucket único com prefixos por tipo — mantém a infraestrutura mínima (um bucket a inicializar no Compose) e torna o ciclo de vida do vídeo coerente: tudo que pertence a um vídeo vive sob `videos/{videoId}/`, removível de uma vez. Chaves: `videos/{videoId}/source.{ext}` e `videos/{videoId}/thumbnail.jpg`. Uploads multipart abandonados são descartados por regra de expiração configurada no bucket, evitando partes órfãs acumulando espaço.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced with registerAs) — Namespaced config factories keep each domain's configuration in its own file under `src/config/`, injected via `ConfigType<typeof xxxConfig>`.

**Libraries:** `@nestjs/config@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-10

**Recommendation:** Option A — A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning. Relevant to Phase 03 as the precedent for collision-retry on a unique slug column (`ChannelsService` uses SAVEPOINT-based retry), the same pattern TD-06 reuses for the video URL identifier.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `inject: [databaseConfig.KEY]`, `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Domain errors are custom `Error` subclasses thrown by services and mapped to HTTP by a global exception filter — services never throw NestJS HTTP exceptions. _(from phase 02)_
- Request payloads are validated by `class-validator` DTOs through the global `ValidationPipe` (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`). _(from phase 02)_
- Every endpoint is protected by the global `JwtAuthGuard` (`APP_GUARD`) by default; public endpoints opt out explicitly with the `@Public()` decorator. _(from phase 02)_
- Schema changes always ship as a versioned migration in `src/database/migrations/`; `synchronize` is never used. _(from phase 02)_
- Unique-slug collisions are resolved by retry inside a transaction using SAVEPOINT/ROLLBACK TO SAVEPOINT, since PostgreSQL aborts the transaction on constraint violation. _(from phase 02)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` não estava inicializado naquela fase; entregue depois em `phase-02-auth-frontend`. |

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|-----------|--------|-----------|---------|
| _None._ | | | |

## Testing Requirements

### nestjs-project

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type. Esta fase introduz artefatos novos cujos níveis de teste seguem a mesma pirâmide das fases anteriores:

| Artifact type | Required layers |
|---------------|-----------------|
| Entidade de vídeo + migration | Integration (`*.integration-spec.ts`) contra o `db` real |
| Service de vídeos (lógica de domínio, ciclo de status) | Unit (`*.spec.ts`) com colaboradores mockados + Integration contra banco real |
| Cliente de object storage | Integration contra o object storage real do Compose |
| Produtor/consumidor da fila | Integration contra a fila real do Compose |
| Worker de processamento (FFmpeg) | Integration exercitando storage + fila reais, com fixture de vídeo curto |
| Controller / endpoints HTTP | E2E (`*.e2e-spec.ts`) via supertest em `nestjs-project/test/` |
| Gerador de identificador de URL única | Unit (`*.spec.ts`) |

**Restrição da atividade:** fila e storage não podem ser mockados onde o Compose os oferece de verdade — "não mocke o que dá para testar de verdade com a infra do Compose". Mock é aceitável apenas na camada unitária, para isolar lógica de domínio.

**Execução:** integração e e2e compartilham o banco e exigem `--runInBand` (ver `nestjs-project/CLAUDE.md`).
