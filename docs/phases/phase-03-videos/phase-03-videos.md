---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-10-12T17:58:26-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-10-12T17:57:35-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-12T17:54:56-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar a fundação de vídeo do StreamTube: armazenamento de arquivos em object storage S3-compatível, fila de processamento em segundo plano com worker dedicado, upload de vídeos de até 10GB sem que o arquivo atravesse a API, pré-cadastro do vídeo como rascunho ao iniciar o upload, processamento automático que extrai duração/metadados e gera thumbnail, URL única por vídeo, e entrega por streaming e download.

---

## Step Implementations

### SI-03.1 — Dependências, Namespaces de Configuração e Infraestrutura Docker

**Description:** Instala as bibliotecas da fase e sobe a infraestrutura nova (object storage, fila e worker) no Compose, com os namespaces de configuração e a validação de ambiente correspondentes.

**Technical actions:**

1. Instalar as dependências nas versões fixadas em `library-refs.md`: `@nestjs/bullmq`, `bullmq`, `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`, `fluent-ffmpeg`, `nanoid@^3.3.20` (v4+ é ESM-only e quebra em CommonJS) e `@types/fluent-ffmpeg` como devDependency.
2. Criar `src/config/storage.config.ts` e `src/config/queue.config.ts` com `registerAs`, seguindo a convenção de namespaces herdada da Fase 01 (per `phase-01-configuracao-base/TD-03`).
3. Estender `src/config/env.validation.ts` com as variáveis novas de storage e fila, com defaults apontando para os nomes de serviço do Compose.
4. Adicionar os serviços `storage`, `redis` e `video-worker` ao `nestjs-project/compose.yaml`, com `healthcheck` e `depends_on: service_healthy` no padrão já usado pelo `db`; criar `Dockerfile.worker` com FFmpeg instalado via `apt` (per `phase-03-videos/TD-05`).
5. Atualizar `nestjs-project/.env.example` com as variáveis novas, usando nomes de serviço do Compose como host — nunca `localhost`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `env.validation.ts` | Integration: schema aceita as vars novas e aplica defaults | `src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- `docker compose ps` mostra os seis serviços (`nestjs-api`, `db`, `mailpit`, `storage`, `redis`, `video-worker`) com status running.
- `docker compose exec nestjs-api curl -sf http://storage:4566/_localstack/health` confirma que o storage aceita conexões.
- `docker compose exec redis redis-cli ping` responde `PONG`.
- Nenhuma configuração de serviço em `compose.yaml` ou `.env.example` aponta para `localhost` ou `127.0.0.1`.
- O container `video-worker` tem `ffmpeg` e `ffprobe` disponíveis no PATH.

---

### SI-03.2 — Entidade Video e Migration

**Description:** Cria a entidade de vídeo ligada ao canal e a migration versionada correspondente, estabelecendo a persistência sobre a qual todo o resto da fase opera.

**Technical actions:**

1. Criar `src/videos/entities/video.entity.ts` com todos os campos do `### Data Model` — atenção a `size_bytes` como `bigint` (um arquivo de 10GB estoura `int`) e ao enum nativo de `status`.
2. Criar `src/videos/videos.constants.ts` com o enum `VideoStatus` (`draft`, `processing`, `ready`, `failed`) usando `as const`, conforme a convenção de constantes do projeto.
3. Declarar o lado `@OneToMany(() => Video, (video) => video.channel)` em `src/channels/entities/channel.entity.ts` — a rule `nestjs-entities.md` exige ambos os lados da relação.
4. Gerar a migration via `npm run migration:generate` e conferir que ela cria o tipo enum, a tabela `videos`, a FK para `channels` e os índices (`unique` em `slug`, index em `channel_id` e `status`); garantir que o `down()` remove o tipo enum explicitamente.
5. Criar `src/videos/videos.module.ts` registrando `TypeOrmModule.forFeature([Video])` e importá-lo em `AppModule`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: constraints, defaults, FK para `channels`, unicidade de `slug` | `src/videos/entities/video.entity.integration-spec.ts` |
| migration `CreateVideos` | Integration: runner aplica e reverte limpo | `src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.1 (as dependências e o ambiente precisam existir antes)

**Acceptance criteria:**

- `npm run migration:run` aplica a migration em banco zerado sem erro, e `npm run migration:revert` a reverte sem deixar o tipo enum órfão.
- Inserir um vídeo com `channel_id` inexistente é recusado por violação de chave estrangeira.
- Inserir dois vídeos com o mesmo `slug` é recusado por violação de unicidade.
- Um vídeo criado sem `status` explícito nasce com `draft`.
- Um valor de `size_bytes` igual a 10737418240 é persistido e lido sem truncamento.

---

### SI-03.3 — Serviço de Object Storage

**Description:** Encapsula o acesso ao storage S3-compatível — abertura e finalização de multipart upload, geração de URLs pré-assinadas e verificação de objeto — atrás de um serviço injetável.

**Technical actions:**

1. Criar `src/storage/storage.module.ts` e `src/storage/storage.service.ts`, com o `S3Client` configurado a partir de `storage.config` (endpoint do object storage, `forcePathStyle: true`, credenciais).
2. Implementar as operações de upload: `createMultipartUpload`, `getPresignedPartUrls` (via `getSignedUrl` sobre `UploadPartCommand`, per `phase-03-videos/TD-02`), `completeMultipartUpload` e `abortMultipartUpload`.
3. Implementar as operações de leitura e verificação: `headObject` (confirmação de presença/tamanho) e `getPresignedReadUrl(key, { attachmentFilename? })` — o parâmetro opcional acrescenta `response-content-disposition=attachment` e é o que distingue download de streaming (per `phase-03-videos/TD-04`).
4. Implementar `putObject` para o worker gravar o thumbnail, e `buildVideoKey`/`buildThumbnailKey` centralizando a convenção de chaves `videos/{videoId}/source.{ext}` e `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-08`).
5. Implementar a inicialização do bucket no bootstrap do módulo: criar o bucket se ausente e aplicar a regra de expiração de multipart uploads incompletos (per `phase-03-videos/TD-08`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `StorageService` | Integration contra o object storage real do Compose: ciclo multipart completo, `headObject`, URLs pré-assinadas de leitura (com e sem `attachment`) | `src/storage/storage.service.integration-spec.ts` |
| `buildVideoKey` / `buildThumbnailKey` | Unit: convenção de chaves | `src/storage/storage.util.spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Um objeto enviado em múltiplas partes e finalizado via `completeMultipartUpload` é recuperável íntegro do bucket.
- `headObject` sobre uma chave inexistente sinaliza ausência sem lançar erro não tratado.
- Uma URL pré-assinada de leitura gerada para um objeto existente permite baixá-lo sem credenciais adicionais.
- Uma URL pré-assinada gerada com `attachmentFilename` responde com cabeçalho `Content-Disposition: attachment`.
- Uma requisição com cabeçalho `Range` à URL pré-assinada devolve `206 Partial Content` com apenas o intervalo pedido.
- O bucket existe após a subida da aplicação, mesmo partindo de um volume de storage vazio.

---

### SI-03.4 — Registro da Fila de Processamento

**Description:** Registra a fila `video-processing` com a política de retentativa da fase, deixando o produtor injetável no módulo de vídeos.

**Technical actions:**

1. Registrar `BullModule.forRootAsync` em `AppModule` com `inject: [queueConfig.KEY]`, apontando a conexão Redis para o nome do serviço do Compose (per `phase-03-videos/TD-01`).
2. Registrar a fila com `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE, defaultJobOptions: { attempts: 3, backoff: { type: 'exponential', delay: 5000 } } })` conforme a tabela de retentativa do `### Events/Messages`.
3. Adicionar `VIDEO_PROCESSING_QUEUE` e `VIDEO_PROCESS_JOB` a `src/videos/videos.constants.ts` com `as const`, evitando literais duplicados entre produtor e consumidor.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Registro da fila | Integration contra o Redis real do Compose: job enfileirado é recuperável com as opções de retentativa aplicadas | `src/videos/videos.queue.integration-spec.ts` |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- Um job publicado na fila `video-processing` é recuperável com `attempts` igual a 3 e backoff exponencial configurado.
- A aplicação sobe com a fila registrada sem erro de resolução de dependência.

---

### SI-03.5 — Gerador de Identificador de URL Única

**Description:** Produz o identificador curto e único de cada vídeo, com tratamento de colisão no padrão já estabelecido pelo projeto.

**Technical actions:**

1. Criar `src/videos/slug.util.ts` expondo a geração via `nanoid` no comprimento definido no `### Data Model` (per `phase-03-videos/TD-06`).
2. Implementar a criação do vídeo com retentativa em colisão de `slug` usando SAVEPOINT/ROLLBACK TO SAVEPOINT dentro da transação, replicando o padrão de `ChannelsService` — o PostgreSQL aborta a transação inteira em violação de constraint, então a retentativa ingênua falharia (per `phase-02-auth/TD-10`, convenção herdada).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `slug.util.ts` | Unit: formato e comprimento do identificador gerado | `src/videos/slug.util.spec.ts` |
| Retentativa em colisão | Integration contra o banco real: colisão forçada resolve em novo `slug` sem abortar a transação | `src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- Cada vídeo criado recebe um `slug` não vazio, URL-safe e distinto dos demais.
- Uma colisão de `slug` forçada durante a criação resulta em um vídeo persistido com identificador diferente, sem erro propagado ao chamador.
- Criar muitos vídeos em sequência não produz `slug` repetido.

---

### SI-03.6 — Endpoint de Início de Upload

**Description:** Entrega `POST /videos` — pré-cadastra o vídeo como rascunho e devolve as URLs pré-assinadas por parte, de modo que o arquivo vá direto do cliente ao storage.

**Technical actions:**

1. Criar `src/videos/dto/create-video.dto.ts` com as regras do `#### Validation Rules` — `title`, `filename`, `size_bytes` (teto de 10737418240) e `content_type` (deve começar com `video/`).
2. Implementar `VideosService.initiateUpload(channelId, dto)` — cria o vídeo em `draft` com `slug` e `storage_key`, abre o multipart upload no storage e persiste o `upload_id` retornado.
3. Gerar as URLs pré-assinadas por parte, calculando a quantidade de partes a partir de `size_bytes` e do tamanho de parte configurado (per `phase-03-videos/TD-02`).
4. Criar `src/videos/videos.controller.ts` com a rota `POST /videos`, derivando o canal do usuário autenticado via `@CurrentUser()` — o canal nunca vem do corpo da requisição.
5. Criar as exceções de domínio da fase em `src/common/exceptions/domain.exception.ts` e mapeá-las no `DomainExceptionFilter` conforme o `### Error Catalog`.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.initiateUpload` | Unit: cálculo de partes, montagem da chave, validação de limite | `src/videos/videos.service.spec.ts` |
| `VideosService.initiateUpload` | Integration contra banco e object storage reais: rascunho persistido e multipart aberto | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos` | E2E: 201 com partes pré-assinadas; 400 acima do limite; 401 sem token | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.3, SI-03.5

**Acceptance criteria:**

- `POST /videos` com corpo válido retorna `201` com `id`, `slug`, `status: "draft"`, `upload_id` e a lista de partes pré-assinadas.
- O vídeo já consta no banco com `status` igual a `draft` imediatamente após a resposta, antes de qualquer byte do arquivo ser enviado.
- O vídeo criado pertence ao canal do usuário autenticado, derivado do token.
- `POST /videos` com `size_bytes` acima de 10737418240 retorna `400` com `errorCode: "VIDEO_FILE_TOO_LARGE"`.
- `POST /videos` sem token retorna `401` e nenhum vídeo é criado.
- Enviar uma parte do arquivo para a URL pré-assinada grava o conteúdo no storage sem que a requisição passe pela API.

---

### SI-03.7 — Endpoint de Finalização de Upload

**Description:** Entrega `POST /videos/:id/complete` — conclui o multipart, confirma a integridade do objeto, transiciona o vídeo para `processing` e enfileira o processamento.

**Technical actions:**

1. Criar `src/videos/dto/complete-upload.dto.ts` validando o array de partes (`part_number` inteiro ≥ 1, `etag` não vazio).
2. Implementar `VideosService.completeUpload(userId, videoId, dto)` — valida posse do vídeo e estado `draft`, chama `completeMultipartUpload` e confirma presença e tamanho via `headObject` (per `phase-03-videos/TD-03`).
3. Transicionar o vídeo para `processing`, persistir `size_bytes` confirmado, limpar `upload_id`, e publicar o job `video.process` na fila com o payload `{ videoId }` conforme o `### Events/Messages`.
4. Adicionar a rota `POST /videos/:id/complete` ao controller, aplicando as recusas do `### Error Catalog` para posse, estado e objeto incompleto.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.completeUpload` | Unit: transições de estado e recusas (não-dono, estado inválido) | `src/videos/videos.service.spec.ts` |
| `VideosService.completeUpload` | Integration contra banco, storage e fila reais: job publicado e estado persistido | `src/videos/videos.service.integration-spec.ts` |
| `POST /videos/:id/complete` | E2E: 200 com `processing`; 403 de outro usuário; 409 em estado inválido; 422 sem objeto no storage | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- `POST /videos/:id/complete` com as partes corretas retorna `201` com `status: "processing"` e um job presente na fila `video-processing`.
- O arquivo fica recuperável íntegro do storage após a finalização.
- `POST /videos/:id/complete` sobre vídeo de outro usuário retorna `403` com `errorCode: "VIDEO_NOT_OWNED"` e o estado do vídeo permanece inalterado.
- `POST /videos/:id/complete` sobre vídeo que não está em `draft` retorna `409` com `errorCode: "VIDEO_INVALID_STATE"`.
- Finalizar quando o objeto não está presente no storage retorna `422` com `errorCode: "VIDEO_UPLOAD_INCOMPLETE"`, o vídeo permanece em `draft` e nenhum job é enfileirado.

---

### SI-03.8 — Worker de Processamento de Vídeo

**Description:** Entrega o worker em container separado que consome a fila, extrai duração e metadados, gera o thumbnail e conduz o vídeo a `ready` ou `failed`.

**Technical actions:**

1. Criar `src/worker.ts` como segundo entrypoint via `NestFactory.createApplicationContext(WorkerModule)`, reaproveitando entidades, `ConfigModule` e `TypeOrmModule` do codebase (per `phase-03-videos/TD-05`); adicionar o script npm correspondente.
2. Criar `src/videos/video-processing.processor.ts` com `@Processor(VIDEO_PROCESSING_QUEUE)` estendendo `WorkerHost`, implementando `process(job)` a partir do `videoId` do payload — relendo o estado do vídeo no banco, não confiando em dados do payload.
3. Extrair duração e metadados com `ffprobe` apontando para a **URL pré-assinada de leitura** do objeto, sem baixar o arquivo para disco local (per `phase-03-videos/TD-05`).
4. Gerar o thumbnail com `screenshots()` a partir de um frame do vídeo e gravá-lo no storage sob `videos/{videoId}/thumbnail.jpg`; persistir `duration_seconds`, `metadata`, `thumbnail_key` e transicionar para `ready`.
5. Implementar o tratamento de falha definitiva via `@OnQueueFailed`: ao esgotar as tentativas, marcar `status: failed` e persistir `failure_reason` (per `phase-03-videos/TD-07`).

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingProcessor` | Integration contra fila, storage e banco reais, com fixture de vídeo curto: vídeo chega a `ready` com duração, metadados e thumbnail | `src/videos/video-processing.processor.integration-spec.ts` |
| Caminho de falha | Integration: arquivo inválido leva a `failed` com `failure_reason`, sem bloquear os demais jobs | `src/videos/video-processing.processor.integration-spec.ts` |

A fixture é um clipe de poucos segundos — suficiente para ter duração, stream de vídeo e um frame extraível, sem inflar o repositório.

**Dependencies:** SI-03.7

**Acceptance criteria:**

- Um vídeo cujo upload foi finalizado chega a `status: "ready"` com `duration_seconds` preenchido e coerente com o arquivo.
- O `metadata` persistido contém os dados técnicos do stream de vídeo (codec, largura, altura).
- Existe um objeto de thumbnail no storage sob a chave registrada em `thumbnail_key`, recuperável como imagem.
- O processamento ocorre sem que o arquivo de vídeo seja copiado integralmente para o disco do worker.
- Um arquivo inválido leva o vídeo a `status: "failed"` com `failure_reason` preenchido, após esgotar as tentativas configuradas.
- Uma falha em um vídeo não impede que outros jobs enfileirados sejam processados.

---

### SI-03.9 — Endpoint de Consulta de Vídeo

**Description:** Entrega `GET /videos/:slug` — expõe os metadados do vídeo pelo identificador de URL única, permitindo acompanhar o ciclo de status.

**Technical actions:**

1. Implementar `VideosService.findBySlug(slug)` com recusa `VIDEO_NOT_FOUND` quando o identificador não resolve.
2. Adicionar a rota `GET /videos/:slug` ao controller, devolvendo a forma de resposta definida no `### API Contracts`.
3. Incluir `thumbnail_url` como URL pré-assinada de leitura do thumbnail, quando `thumbnail_key` estiver preenchido.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.findBySlug` | Unit: resolução e recusa | `src/videos/videos.service.spec.ts` |
| `GET /videos/:slug` | E2E: 200 com os campos do contrato; 404 para slug inexistente; status reflete o estágio | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.2

**Acceptance criteria:**

- `GET /videos/:slug` de um vídeo existente retorna `200` com `id`, `slug`, `title`, `status`, `duration_seconds`, `metadata` e `created_at`.
- `GET /videos/:slug` com identificador inexistente retorna `404` com `errorCode: "VIDEO_NOT_FOUND"`.
- O `status` retornado corresponde ao estágio real do vídeo em cada ponto do ciclo (`draft`, `processing`, `ready`).
- Um vídeo pronto retorna `thumbnail_url` utilizável para obter a imagem.

---

### SI-03.10 — Endpoints de Streaming e Download

**Description:** Entrega `GET /videos/:slug/stream` e `GET /videos/:slug/download` — a reprodução por trechos e o download do arquivo, ambos sem que os bytes atravessem a API.

**Technical actions:**

1. Implementar `VideosService.getPlaybackUrl(slug, { asAttachment })` — recusa `VIDEO_NOT_READY` quando o vídeo não está em `ready` e `VIDEO_NOT_FOUND` quando o slug não resolve; gera a URL pré-assinada de leitura com TTL curto (per `phase-03-videos/TD-04`).
2. Adicionar a rota `GET /videos/:slug/stream` ao controller respondendo `302` com `Location` apontando para a URL pré-assinada, deixando o storage atender `Range`/`206`.
3. Adicionar a rota `GET /videos/:slug/download` usando o mesmo mecanismo com `response-content-disposition=attachment; filename="{title}.{ext}"` — um mecanismo, dois comportamentos.

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService.getPlaybackUrl` | Unit: recusas por estado e montagem do parâmetro de anexo | `src/videos/videos.service.spec.ts` |
| `GET /videos/:slug/stream` | E2E: 302 para vídeo pronto; requisição com `Range` à URL resultante devolve `206` com o trecho e o tamanho total corretos | `test/videos.e2e-spec.ts` |
| `GET /videos/:slug/download` | E2E: 302 cuja URL responde com `Content-Disposition: attachment`; 409 para vídeo não pronto | `test/videos.e2e-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `GET /videos/:slug/stream` de um vídeo pronto retorna `302` com `Location` para uma URL pré-assinada válida.
- Uma requisição com cabeçalho `Range` à URL de streaming devolve `206 Partial Content` com apenas o intervalo pedido e o tamanho total do arquivo informado.
- Uma requisição de um trecho no meio do arquivo é atendida sem transferir os trechos anteriores.
- `GET /videos/:slug/download` entrega o arquivo completo com `Content-Disposition: attachment`.
- `GET /videos/:slug/stream` e `GET /videos/:slug/download` de um vídeo em `processing` retornam `409` com `errorCode: "VIDEO_NOT_READY"`.
- Ambos os endpoints sem token retornam `401`.

---

## Technical Specifications

### Data Model

#### Video

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated (`@PrimaryGeneratedColumn('uuid')`) |
| slug | varchar(16) | unique, not null — identificador de URL única, gerado por `nanoid` (per `phase-03-videos/TD-06`) |
| title | varchar(255) | not null |
| channel_id | uuid | FK → `channels.id`, not null — o vídeo pertence ao canal, não ao usuário |
| status | enum | not null, default `draft` — valores: `draft`, `processing`, `ready`, `failed` (per `phase-03-videos/TD-07`) |
| storage_key | varchar(512) | nullable — chave do objeto de vídeo: `videos/{videoId}/source.{ext}` (per `phase-03-videos/TD-08`) |
| thumbnail_key | varchar(512) | nullable — chave do thumbnail: `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-08`) |
| upload_id | varchar(255) | nullable — `UploadId` do multipart upload em aberto (per `phase-03-videos/TD-02`); limpo após `CompleteMultipartUpload` |
| duration_seconds | int | nullable — preenchido pelo worker via `ffprobe` (per `phase-03-videos/TD-05`) |
| metadata | jsonb | nullable — metadados técnicos extraídos (codec, largura, altura, bitrate, framerate) |
| size_bytes | bigint | nullable — tamanho do arquivo confirmado via `HeadObject` na finalização |
| failure_reason | text | nullable — causa persistida quando `status = failed` (per `phase-03-videos/TD-07`) |
| created_at | timestamp | `@CreateDateColumn()` |
| updated_at | timestamp | `@UpdateDateColumn()` |

**Relations:** `Channel` has many `Video` (one-to-many); `Video` belongs to `Channel` via `channel_id` (`@ManyToOne` + `@JoinColumn({ name: 'channel_id' })`, com o lado `@OneToMany` declarado em `Channel` conforme a rule `nestjs-entities.md`).

**Indexes:**
- unique on `slug` — garante a unicidade da URL exigida pela capability; é a garantia real por trás do `nanoid` (per `phase-03-videos/TD-06`).
- index on `channel_id` — suporta a listagem de vídeos por canal.
- index on `status` — suporta consultas por estado durante o processamento.

**Notas de modelagem:**

- `size_bytes` é `bigint` e não `int`: um arquivo de 10GB (≈1,07 × 10¹⁰ bytes) estoura o limite de `int` do PostgreSQL (2.147.483.647). Usar `int` aqui truncaria o tamanho do caso de uso central da fase.
- `storage_key` e `thumbnail_key` são deriváveis de `id` pela convenção de `TD-08`, mas ficam persistidos para que a localização do objeto não dependa de recomputar a convenção em cada leitura — e para que uma futura mudança de convenção não invalide objetos já gravados.
- `status` usa enum nativo do PostgreSQL, seguindo o precedente de `verification_tokens_type_enum` (Fase 02). A migration deve criar e remover o tipo explicitamente no `up`/`down`.

### API Contracts

#### POST /videos (SI-03.6)

Inicia o upload: cria o vídeo como rascunho e abre o multipart upload no storage, devolvendo as URLs pré-assinadas por parte.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- title: string, required — min 1, max 255 caracteres
- filename: string, required — nome original do arquivo; sua extensão compõe a `storage_key`
- size_bytes: number, required — tamanho declarado do arquivo, inteiro positivo, max 10737418240 (10 GiB)
- content_type: string, required — MIME type do vídeo

**Response 201:**
- id: string (uuid)
- slug: string
- status: string — sempre `draft` nesta resposta
- upload_id: string — `UploadId` do multipart upload
- parts: array — uma entrada por parte, cada uma com:
  - part_number: number — 1-indexado, conforme exigido pelo S3
  - url: string — URL pré-assinada do `UploadPartCommand` daquela parte

**Error responses:**
- 400 VIDEO_FILE_TOO_LARGE: quando `size_bytes` excede o limite de 10 GiB
- 400 validation error: quando o corpo falha na validação de schema
- 401 (guard global): quando não há token válido

---

#### POST /videos/:id/complete (SI-03.7)

Finaliza o upload: conclui o multipart no storage, confirma a presença do objeto e enfileira o processamento.

**Request headers:**
- Content-Type: application/json
- Authorization: Bearer {access_token}

**Request body:**
- parts: array, required — uma entrada por parte enviada, cada uma com:
  - part_number: number, required
  - etag: string, required — `ETag` devolvido pelo storage no upload daquela parte

**Response 201:**
- id: string (uuid)
- slug: string
- status: string — `processing` após a finalização bem-sucedida

_O `201` é o default do NestJS para `@Post`. Mantido em vez de forçar `@HttpCode(200)`: a finalização do upload de fato materializa o objeto no storage, então `201` é semanticamente defensável e evita um decorator a mais._

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o vídeo não existe
- 403 VIDEO_NOT_OWNED: quando o vídeo pertence ao canal de outro usuário
- 409 VIDEO_INVALID_STATE: quando o vídeo não está em `draft`
- 422 VIDEO_UPLOAD_INCOMPLETE: quando o objeto não está presente/íntegro no storage após o `CompleteMultipartUpload`
- 400 validation error: quando o corpo falha na validação de schema

---

#### GET /videos/:slug (SI-03.9)

Retorna os metadados públicos do vídeo pelo seu identificador de URL única.

**Request headers:**
- Authorization: Bearer {access_token}

**Response 200:**
- id: string (uuid)
- slug: string
- title: string
- status: string — `draft` | `processing` | `ready` | `failed`
- duration_seconds: number | null
- metadata: object | null
- thumbnail_url: string | null — URL pré-assinada de leitura do thumbnail, quando existir
- created_at: string (ISO-8601)

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `slug` não corresponde a nenhum vídeo

---

#### GET /videos/:slug/stream (SI-03.10)

Entrega o vídeo para reprodução. Responde com redirecionamento para a URL pré-assinada; o storage atende `Range`/`206` nativamente (per `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: URL pré-assinada de leitura (`GetObjectCommand`), TTL curto

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `slug` não corresponde a nenhum vídeo
- 409 VIDEO_NOT_READY: quando o vídeo não está em `ready`

---

#### GET /videos/:slug/download (SI-03.10)

Entrega o arquivo para download. Mesmo mecanismo do streaming, com `response-content-disposition=attachment` acrescentado na assinatura (per `phase-03-videos/TD-04`).

**Request headers:**
- Authorization: Bearer {access_token}

**Response 302:**
- Location: URL pré-assinada de leitura com `response-content-disposition=attachment; filename="{title}.{ext}"`

**Error responses:**
- 404 VIDEO_NOT_FOUND: quando o `slug` não corresponde a nenhum vídeo
- 409 VIDEO_NOT_READY: quando o vídeo não está em `ready`

---

#### Validation Rules — VideosModule

- `title`: obrigatório, string, min 1, max 255.
- `filename`: obrigatório, string, max 255.
- `size_bytes`: obrigatório, inteiro, min 1, max 10737418240 (10 GiB). O teto é o requisito da fase; o piso evita abrir multipart para arquivo vazio.
- `content_type`: obrigatório, string, deve começar com `video/`.
- `parts[].part_number`: obrigatório, inteiro, min 1 (o S3 numera partes a partir de 1, não de 0).
- `parts[].etag`: obrigatório, string não vazia.

Todas as regras são aplicadas por DTOs `class-validator` através do `ValidationPipe` global (`whitelist: true`, `forbidNonWhitelisted: true`, `transform: true`), conforme a convenção herdada da Fase 02.

### Authorization Matrix

Todos os endpoints desta fase ficam sob o `JwtAuthGuard` global herdado da Fase 02 — nenhum recebe `@Public()`. "Acesso anônimo à visualização" é capability declarada da Fase 05 (per `phase-03-videos/TD-04`).

| Endpoint | Anonymous | Authenticated (não-dono) | Owner (dono do canal) |
|----------|-----------|--------------------------|----------------------|
| POST /videos | ✗ | ✓ (cria no próprio canal) | ✓ |
| POST /videos/:id/complete | ✗ | ✗ | ✓ |
| GET /videos/:slug | ✗ | ✓ | ✓ |
| GET /videos/:slug/stream | ✗ | ✓ | ✓ |
| GET /videos/:slug/download | ✗ | ✓ | ✓ |

**Notas:**

- `POST /videos` não tem noção de "não-dono": o vídeo é sempre criado no canal do usuário autenticado, derivado do token. Não há parâmetro de canal no corpo da requisição.
- `POST /videos/:id/complete` é a única operação restrita ao dono — finalizar o upload de um vídeo alheio é recusado com `VIDEO_NOT_OWNED` (per spec `video-upload`, requisito "Upload restrito ao dono do canal").
- As rotas de leitura são abertas a qualquer usuário autenticado porque a visibilidade por vídeo (público/unlisted) é capability da Fase 04 — nesta fase não há distinção de visibilidade a aplicar.

### Error Catalog

Formato de resposta herdado da Fase 02 (`{ statusCode, error, message }`), produzido pelo `DomainExceptionFilter` global a partir de exceções de domínio lançadas pelo service (per `phase-02-auth/TD-07`). Services nunca lançam exceções HTTP do NestJS.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| VIDEO_NOT_FOUND | 404 | `slug` ou `id` não corresponde a nenhum vídeo |
| VIDEO_NOT_OWNED | 403 | Usuário autenticado tenta finalizar upload de vídeo de outro canal |
| VIDEO_INVALID_STATE | 409 | Transição de estado inválida (ex.: finalizar upload de vídeo que não está em `draft`) |
| VIDEO_NOT_READY | 409 | Reprodução ou download solicitado para vídeo que não está em `ready` |
| VIDEO_UPLOAD_INCOMPLETE | 422 | Objeto ausente ou incompleto no storage no momento da finalização |
| VIDEO_FILE_TOO_LARGE | 400 | `size_bytes` declarado excede o limite de 10 GiB |

### Events/Messages

Fila implementada com BullMQ sobre Redis, via `@nestjs/bullmq` (per `phase-03-videos/TD-01`). Uma única fila nesta fase.

#### video.process

Fila: `video-processing`.

**Payload:**

```json
{ "videoId": "uuid" }
```

O payload carrega apenas o identificador — o worker relê o estado atual do vídeo no banco. Enviar os dados do vídeo no payload criaria uma cópia que pode divergir entre o enfileiramento e o processamento (ex.: título editado nesse intervalo).

**Producer:** `VideosService` (per `phase-03-videos/TD-03`) — publica no endpoint de finalização do upload, depois de confirmar a presença do objeto no storage e transicionar o vídeo para `processing`.

**Consumer:** `VideoProcessingProcessor` no container `video-worker` (per `phase-03-videos/TD-05`) — classe com `@Processor('video-processing')` estendendo `WorkerHost`, implementando `process(job)`.

**Trigger:** chamada bem-sucedida de `POST /videos/:id/complete`.

**Delivery semantics:** at-least-once. O worker deve ser idempotente por `videoId` — reprocessar um vídeo já `ready` sobrescreve thumbnail e metadados com o mesmo resultado, sem efeito colateral.

**Retentativa e falha** (per `phase-03-videos/TD-07`):

| Parâmetro | Valor | Origem |
|-----------|-------|--------|
| `attempts` | 3 | `defaultJobOptions` da fila |
| `backoff` | exponencial, delay inicial 5000ms | `defaultJobOptions` da fila |
| Falha definitiva | Vídeo marcado `failed` + `failure_reason` persistido | Handler `@OnQueueFailed` quando `job.attemptsMade` atinge `attempts` |

Lançar um erro dentro de `process()` marca o job como falho e dispara a retentativa conforme `attempts`/`backoff` — é o mecanismo nativo do BullMQ, confirmado na documentação oficial do `@nestjs/bullmq` (ver `library-refs.md`). A falha de um job é isolada: não bloqueia os demais na fila.

---

## Dependency Map

```
SI-03.1 (root) — Dependências, config e infraestrutura Docker
├── SI-03.2 — Entidade Video e Migration (entidade precisa das deps instaladas)
│   ├── SI-03.5 — Gerador de slug único (opera sobre a entidade)
│   │   └── SI-03.6 — Endpoint de início de upload — depende de SI-03.3 + SI-03.5
│   │       └── SI-03.7 — Endpoint de finalização — depende de SI-03.4 + SI-03.6
│   │           └── SI-03.8 — Worker de processamento (consome o job que SI-03.7 publica)
│   │               └── SI-03.10 — Streaming e download (só servem vídeo em `ready`)
│   └── SI-03.9 — Endpoint de consulta (independente do upload; só precisa da entidade)
├── SI-03.3 — Serviço de object storage (precisa do SDK e do storage de pé)
└── SI-03.4 — Registro da fila (precisa do BullMQ e do Redis de pé)
```

**Caminho crítico:** `SI-03.1 → SI-03.2 → SI-03.5 → SI-03.6 → SI-03.7 → SI-03.8 → SI-03.10`. É a espinha dorsal do fluxo de vídeo: sem entidade não há upload; sem upload finalizado não há processamento; sem processamento não há vídeo pronto para servir.

**Paralelizáveis:** `SI-03.3` e `SI-03.4` dependem apenas de `SI-03.1` e podem ser implementados em qualquer ordem entre si. `SI-03.9` depende apenas de `SI-03.2` e pode ser implementado a qualquer momento depois dela — não bloqueia nem é bloqueado pelo caminho de upload.

---

## Deliverables

- [ ] SI-03.1 — Dependências, Namespaces de Configuração e Infraestrutura Docker
- [ ] SI-03.2 — Entidade Video e Migration
- [ ] SI-03.3 — Serviço de Object Storage
- [ ] SI-03.4 — Registro da Fila de Processamento
- [ ] SI-03.5 — Gerador de Identificador de URL Única
- [ ] SI-03.6 — Endpoint de Início de Upload
- [ ] SI-03.7 — Endpoint de Finalização de Upload
- [ ] SI-03.8 — Worker de Processamento de Vídeo
- [ ] SI-03.9 — Endpoint de Consulta de Vídeo
- [ ] SI-03.10 — Endpoints de Streaming e Download

**Capacidades da fase** (rastreadas aos bullets do `docs/project-plan.md`):

- [ ] Serviço de armazenamento de arquivos (vídeos e thumbnails) — bucket e convenção de chaves operantes
- [ ] Serviço de processamento em segundo plano (filas) — fila real consumida por worker dedicado
- [ ] Upload de vídeos de até 10GB sem impacto na performance — arquivo não atravessa a API
- [ ] Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- [ ] Processamento automático do vídeo após upload (extração de duração e metadados)
- [ ] Geração automática de thumbnail a partir de um frame do vídeo
- [ ] URL única por vídeo, sem conflito com outros vídeos
- [ ] Reprodução via streaming (sem necessidade de download completo)
- [ ] Download do vídeo pelo usuário

**Infraestrutura:**

- [ ] Object storage, fila e worker sobem via `docker compose up -d` junto com API, banco e mail (seis serviços saudáveis)
- [ ] Nenhuma configuração de serviço aponta para `localhost` — sempre o nome do serviço do Compose
- [ ] Migration cria a tabela `videos` com chave estrangeira para `channels`

**Full test suites** (todos os comandos rodam dentro do container, per `nestjs-project/CLAUDE.md`):

- [ ] Testes de unidade e integração passam (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] Testes e2e passam (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type-check passa com código 0 (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passa (`docker compose exec nestjs-api npm run lint`)

**Documentação:**

- [ ] `CLAUDE.md` da raiz e de `nestjs-project/` atualizados com a seção de vídeos, coerentes com o código entregue
- [ ] `docs/phases/phase-03-videos/progress.md` com status e resultado de testes por SI
