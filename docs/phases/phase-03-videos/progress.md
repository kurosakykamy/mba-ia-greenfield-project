# phase-03-videos — Progress

**Status:** completed
**SIs:** 10/10 completed

### SI-03.1 — Dependências, Namespaces de Configuração e Infraestrutura Docker
- **Status:** completed
- **Tests:** 7/7 passing (env.validation.integration-spec.ts)
- **Observations:**
  - **Object storage trocado de MinIO para LocalStack.** A imagem `minio/minio` não é mais distribuída publicamente no Docker Hub (`pull access denied`), `quay.io/minio/minio` responde 401 e o catálogo `bitnami/minio` foi descontinuado. Confirmado que não era bloqueio geral de registry: `redis:8-alpine` puxou anonimamente na mesma sessão. Decisão do usuário: LocalStack, por emular o S3 da AWS — o alvo de produção declarado. Registrado como `**Revisions:**` em `TD-08`; a decisão da TD (bucket único, convenção de chaves, acesso via `@aws-sdk/client-s3`) não mudou.
  - **Tag do LocalStack fixada na major 4.** A tag `latest` passou a apontar para a edição Pro: sobe, falha a ativação de licença e sai com código 55 (`LOCALSTACK_AUTH_TOKEN` ausente). `localstack/localstack:4` sobe sem licença e fica healthy.
  - `nanoid` instalado na `3.3.20` deliberadamente, não na `6.0.2` — v4+ é ESM-only e o projeto compila CommonJS (evidência no `library-refs.md`).
  - Healthcheck do storage usa `localhost` dentro do próprio container — é o container checando a si mesmo, não comunicação entre serviços; a regra do `CLAUDE.md` continua respeitada.

### SI-03.2 — Entidade Video e Migration
- **Status:** completed
- **Tests:** 10/10 passing (video.entity.integration-spec.ts: 7, migrations.integration-spec.ts: 3). Suíte completa: 24/24 suítes, 155/155 testes; e2e 3/3, 52/52; tsc 0; lint 0 erros.
- **Observations:**
  - **Efeito em cascata da relação bidirecional.** Declarar `@OneToMany(() => Video)` em `Channel` — exigido pela rule `nestjs-entities.md` — quebrou 10 suítes de uma vez com `Entity metadata for Channel#videos was not found`. A rule `typeorm-migrations.md` manda passar arrays explícitos de entidades nos `DataSource` de teste, então todo arquivo que listava `[User, Channel, RefreshToken, VerificationToken]` precisou receber `Video`. Corrigidos 10 arquivos (7 integration specs + 3 module specs). É consequência estrutural de adicionar entidade ligada a outra já existente, não um bug pontual — vale prever isso nas próximas fases que adicionarem entidades relacionadas.
  - **Deadlock no setup do teste de migrations.** O `beforeAll` dropava tabelas com `Promise.all` de `DROP TABLE ... CASCADE`. Com a FK nova `videos → channels`, dois drops concorrentes passaram a disputar lock nas mesmas relações e o PostgreSQL abortou com `deadlock detected`. Serializado em laço `for`. O `Promise.all` já era frágil por construção; a FK nova só tornou a falha determinística.
  - Migration gerada pela CLI do TypeORM, não escrita à mão. O `down()` gerado já remove o tipo enum `videos_status_enum` — a mesma pegadinha que derrubou o baseline na task 1.6, aqui coberta por asserção explícita no teste de reversão.
  - `size_bytes` mapeado como `string` no TypeScript: o driver `pg` devolve `bigint` como string para não perder precisão. O teste verifica que 10 GiB (10737418240) sobrevive ao round-trip sem truncamento.

### SI-03.3 — Serviço de Object Storage
- **Status:** completed
- **Tests:** 16/16 passing (storage.service.integration-spec.ts: 7 contra o LocalStack real, storage.util.spec.ts: 9)
- **Observations:**
  - `forcePathStyle: true` é obrigatório contra storage S3-compatível self-hosted: sem ele o SDK monta URL virtual-host (`bucket.host`), que não resolve no DNS do Compose.
  - O teste de integração exercita o ciclo multipart completo com partes de 5 MiB — abaixo disso o `CompleteMultipartUpload` recusa qualquer parte que não seja a última, por regra do S3.
  - Cobertos por teste os dois comportamentos que sustentam a entrega: `Range: bytes=2-5` devolve `206` com `Content-Range: bytes 2-5/10`, e `response-content-disposition` força `attachment`. São a prova de que streaming e download funcionam pelo mesmo mecanismo.

### SI-03.4 — Registro da Fila de Processamento
- **Status:** completed
- **Tests:** 3/3 passing (videos.queue.integration-spec.ts, contra o Redis real)
- **Observations:**
  - **`@nestjs/bullmq@12` rejeitada em tempo de implementação — é ESM-only.** Declara `"type": "module"` e a condição `require` do exports map aponta para o **mesmo** arquivo ESM, então o Jest falha com `SyntaxError: Unexpected token 'export'`. Downgrade para `^11.0.5` (CommonJS), que mantém o peer `@nestjs/core ^11`. É a mesma classe de problema que eu já havia detectado no `nanoid` durante o `/plan-resolve` — só que esta não apareceu na checagem de `exports` inicial porque a v12 *tem* condição `require`; ela só aponta para o arquivo errado.
  - **`ioredis` precisa ser instalado explicitamente.** O `bullmq@6` o trata como `peerOptional` e não o traz por transitividade; a `Queue` falha em runtime com mensagem explícita. Fixado em `^5.0.4` e não na latest `6.0.0`: o `typeorm@0.3.28` exige `^5.0.4` e a v6 provoca `ERESOLVE`. A v5 é a única que satisfaz bullmq e typeorm ao mesmo tempo, sem recorrer a `--legacy-peer-deps`.
  - `library-refs.md` atualizado com os dois achados e com uma seção nova — *Padrão recorrente — ESM-only quebra este projeto* — consolidando as três libs cuja latest foi rejeitada e o comando de verificação (`npm view <pkg> type exports`) para as próximas fases.
  - `removeOnComplete: false` / `removeOnFail: false` no `defaultJobOptions`: sem isso o BullMQ descarta os jobs e a observabilidade de falha exigida por TD-07 se perde.

### SI-03.5 — Gerador de Identificador de URL Única
- **Status:** completed
- **Tests:** 12/12 passing (slug.util.spec.ts: 3, videos.service.integration-spec.ts: 9)
- **Observations:**
  - Alfabeto do nanoid sem caracteres visualmente ambíguos (`0`/`O`, `1`/`l`/`I`): o slug aparece em links compartilhados e pode ser transcrito à mão.
  - A retentativa de colisão é testada de verdade: o teste força `generateVideoSlug` a devolver um slug já existente e verifica que o SAVEPOINT permite a segunda tentativa. Sem SAVEPOINT o PostgreSQL abortaria a transação inteira — é o mesmo padrão herdado de `ChannelsService`.

### SI-03.6 — Endpoint de Início de Upload
- **Status:** completed
- **Tests:** 19/19 e2e passing (videos.e2e-spec.ts) + 4 unit em videos.service.spec.ts
- **Observations:**
  - O canal é derivado do token via `ChannelsService.findByUserId`, nunca do corpo da requisição. O método novo foi para `ChannelsService` e não para o de vídeos — canais são domínio dele (princípio de responsabilidade única do `CLAUDE.md`).
  - Teste e2e confirma o requisito central: o rascunho existe no banco **antes** de qualquer byte ser enviado.

### SI-03.7 — Endpoint de Finalização de Upload
- **Status:** completed
- **Tests:** coberto em videos.e2e-spec.ts (5 cenários) e videos.service.spec.ts (5 cenários)
- **Observations:**
  - Cobertos os quatro caminhos de recusa do Error Catalog: 403 de outro usuário, 409 em estado inválido, 422 sem objeto no storage (com verificação de que nenhum job é enfileirado e o vídeo continua `draft`), 400 em payload inválido.

### SI-03.8 — Worker de Processamento de Vídeo
- **Status:** completed
- **Tests:** 5/5 passing (video-processing.processor.integration-spec.ts) contra storage, banco e FFmpeg reais
- **Observations:**
  - **FFmpeg adicionado ao `Dockerfile.dev`**, não só ao do worker. A suíte roda no container da API; sem o binário lá, os testes de extração de metadados e thumbnail seriam pulados — justamente a parte mais importante do SI ficaria sem cobertura real.
  - **Fixture de vídeo gerada com FFmpeg** (`testsrc`, 3s, 320x240, 68 KB) em vez de commitar um arquivo grande. Tem duração, stream de vídeo e frame extraível — o suficiente para exercitar o caminho real.
  - `ffprobe` lê direto da URL pré-assinada, confirmando na prática o que `TD-05` assumiu: não é preciso baixar o arquivo para extrair metadados.
  - `screenshots()` só escreve em arquivo (não aceita stream de saída), então o frame vai para um diretório temporário e é lido como Buffer. O que **não** é baixado é o vídeo — a entrada continua sendo a URL.
  - A falha definitiva é distinguida da transitória comparando `job.attemptsMade` com `job.opts.attempts`: marcar `failed` na primeira falha anularia a retentativa que `TD-07` escolheu.
  - **Bug que só a execução real do worker revelou.** O `WorkerModule` registrava apenas `TypeOrmModule.forFeature([Video])`, e o worker não subia: `Entity metadata for Video#channel was not found`. Com `autoLoadEntities`, o TypeORM só carrega entidades que algum módulo registra via `forFeature` — e `Video` tem relação com `Channel`, que tem com `User`. Nenhum teste pegou isso porque os testes de integração montam o próprio `DataSource` com a lista completa de entidades; só rodar `npm run worker` de verdade expôs. Corrigido para `forFeature([Video, Channel, User])`.
  - **Import do `fluent-ffmpeg` deu trabalho.** `import * as` não é chamável sob `nodenext`; `import = require` funciona mas viola a rule de lint; a correção certa foi o default import, que o `esModuleInterop: true` do projeto suporta. Uma tentativa intermediária com cast passou no `tsc` mas quebrou em runtime — pegada só pela suíte completa.

### SI-03.9 — Endpoint de Consulta de Vídeo
- **Status:** completed
- **Tests:** coberto em videos.e2e-spec.ts (3 cenários)
- **Observations:**
  - Teste acompanha o ciclo de status pelo endpoint (`draft` → `processing`), provando que o estado exposto corresponde ao estágio real.

### SI-03.10 — Endpoints de Streaming e Download
- **Status:** completed
- **Tests:** coberto em videos.e2e-spec.ts (6 cenários)
- **Observations:**
  - O e2e vai além do 302: segue o `Location` e verifica que a URL resultante devolve `206` com `Content-Range`, que o trecho tem exatamente o tamanho pedido e que o total é maior — isto é, o arquivo inteiro não veio.
  - Busca no meio do arquivo (`bytes=5000-5099`) testada separadamente, cobrindo o requisito de não transferir os trechos anteriores.
  - Download verifica `Content-Disposition: attachment` e que o tamanho recebido bate com o da fixture.

---

## Notas de divergência do guia de testes

- O `testing-guide-nestjs-project` descreve object storage como "Local Filesystem" — a seção é anterior à decisão desta fase. `phase-03-videos/TD-02` e `TD-08` decidiram object storage S3-compatível, e o enunciado da atividade proíbe mockar o que o Compose oferece de verdade. Os testes de integração de storage rodam contra o storage real do Compose (LocalStack, após a troca registrada em `TD-08` → `Revisions`). A seção de fila do guia já previa "Real message broker in Docker (TBD)", coerente com `TD-01`.

---

## Definition of Done (final)

| Verificação | Resultado |
|---|---|
| `npm test -- --runInBand` | 31/31 suítes, 202/202 testes |
| `npm run test:e2e` | 4/4 suítes, 71/71 testes |
| `npx tsc --noEmit` | código 0 |
| `npm run lint` | 0 erros (1 warning pré-existente da Fase 02) |

Baseline no início da fase: 24 suítes / 155 testes (unit+integração) e 3 suítes / 52 testes (e2e).

## Ajustes de infraestrutura de teste feitos durante a fase

- **`testTimeout: 30000` em `test/jest-e2e.json`.** O `AppModule` passou a subir `BullModule` (conexão Redis) e `StorageModule` (que cria bucket e aplica lifecycle no `onModuleInit`), e o boot ultrapassou o timeout padrão de 5s do Jest. O `auth.e2e-spec.ts` quebrou com 43 falhas de `beforeAll` — não por interferência de dados, mas por tempo. Passa isolado e falhava em conjunto, o que inicialmente parecia contaminação entre suítes.
- **`cleanAllTables` passou a limpar `videos` primeiro**, em ordem reversa de dependência (`videos` → `channels` → `users`).
- **Asserções de fila deixaram de depender de `waiting`.** Três testes verificavam o job publicado consultando apenas o estado `waiting`. Quando o worker real sobe contra o mesmo Redis, ele consome o job em milissegundos e a asserção vira corrida — a suíte quebrou exatamente assim ao rodar com o worker ligado. Agora os testes buscam em todos os estados (`waiting`, `active`, `completed`, `failed`, `delayed`) e filtram pelo `videoId`: o que importa é que o job foi publicado com o payload e a política corretos, não em que estado ele está naquele instante. A suíte completa foi reexecutada **com o worker ativo** para confirmar.

## Verificação funcional de ponta a ponta

Executada com a stack completa de pé e o **worker real** (`npm run worker` no container `video-worker`) consumindo a fila — não o processor instanciado em teste:

```
1) registro + confirmação por e-mail + login
2) POST /videos                → slug=QgkGEmeTepAQ, status=draft
3) rascunho já no banco ANTES de qualquer byte do arquivo subir
4) PUT do arquivo DIRETO ao storage pela URL pré-assinada (a API não participa)
5) POST /videos/:id/complete   → status=processing, job publicado
6) worker processa             → status=ready
   duracao=3s  metadata={"codec":"h264","width":320,"height":240,"bitrate":181000,"framerate":"15/1"}
   thumbnail gravado no bucket
7) GET /videos/:slug/stream    → 302 → HTTP 206 PARTIAL CONTENT
                                       Content-Range: bytes 0-99/67875
8) GET /videos/:slug/download  → 302 → Content-Disposition: attachment; filename="Fluxo completo.mp4"
                                       67875 bytes recebidos (= tamanho original)
```

**Nota de ambiente local:** as URLs pré-assinadas apontam para `storage:4566`, o nome do serviço do Compose — correto pela regra do `CLAUDE.md` e necessário para a comunicação entre containers, mas não resolvível a partir do host Windows. A verificação acima roda de dentro da rede do Compose. Em produção o `STORAGE_ENDPOINT` é o endpoint público do S3 e a questão não existe; num frontend local seria preciso expor um endpoint alcançável pelo navegador.

## Correções de revisão pré-entrega

Revisão feita pelo usuário antes do commit apontou pendências que a auditoria automatizada não cobriu. Todas corrigidas:

1. **`openapi.json` estava desatualizado** — o arquivo versionado ainda era o da Fase 02, sem nenhuma das 5 rotas de vídeo. A rule `nestjs-controllers.md` chama esse arquivo de "o contrato consumido pelo frontend Next.js" e trata endpoint não documentado como PR incompleto. Faltou rodar `npm run openapi:export` ao final da fase. Regenerado; as 5 rotas estão presentes.

2. **`@ApiBearerAuth()` sem o nome do scheme** em `videos.controller.ts`. O default do decorator é `bearer`, mas o `DocumentBuilder` registra o scheme como `access-token` — então as rotas de vídeo saíam com `security: [{ bearer: [] }]`, apontando para um scheme inexistente no documento, e o botão Authorize do Swagger não se aplicava a elas. A rule especifica `@ApiBearerAuth('access-token')` literalmente, e o `auth.controller.ts` (implementação de referência citada pela rule) já fazia certo. Corrigido e confirmado no documento regenerado: as 5 rotas agora usam `access-token`, igual a `/auth/me`.

3. **`docs/diagrams/software-arch.mermaid` desatualizado** — ainda dizia `Message Queue, "TBD"` e `"S3 or MinIO"`. O `CLAUDE.md` da raiz aponta esse diagrama como referência de arquitetura, então ele contradizia o próprio `CLAUDE.md`. Atualizado para `BullMQ over Redis` e `S3-compatible (LocalStack locally, AWS S3 in production)`.

4. **Status code do `/complete`**: o plano dizia `200`, o código devolve `201` (default do NestJS para `@Post`). Corrigido no plano, com nota explicando por que o `201` foi mantido em vez de forçar `@HttpCode(200)`.

5. **Comentário falso no `Dockerfile.worker`**: afirmava que "a imagem da API não instala ffmpeg", o que deixou de ser verdade quando o `Dockerfile.dev` passou a instalá-lo para os testes. Reescrito para descrever a situação real e por que os dois arquivos seguem separados.

6. **`timestamptz` no Data Model do plano**: a migration gera `TIMESTAMP` sem timezone, seguindo o precedente das Fases 01/02. Aqui o **código estava certo** e o plano é que descrevia errado. Corrigido o plano.

**DoD reexecutada após as correções:** 31/31 suítes e 202/202 testes; e2e 4/4 e 71/71; `tsc` código 0; lint 0 erros.

**Ponto não corrigido, por decisão deliberada:** os Deliverables do plano seguem desmarcados enquanto o `progress.md` reporta 10/10. O `progress.md` é o artefato que a skill `implement` possui e mantém; os Deliverables são o checklist original do `plan-build`. Marcar nos dois lugares criaria rastreio duplicado sujeito a divergir.
