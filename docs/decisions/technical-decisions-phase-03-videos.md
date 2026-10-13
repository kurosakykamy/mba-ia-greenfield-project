---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-10-12
scope_description: "Upload de vídeos de até 10GB sem travar a API, fila de processamento em segundo plano, worker com FFmpeg, URL única por vídeo e streaming/download."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — recebe o novo módulo de vídeos, a fila de processamento, o worker de vídeo e a integração com o object storage. Todas as TDs deste documento pertencem a este subprojeto.
- `next-frontend/` — fora de escopo. A atividade declara explicitamente a Fase 03 como desafio de backend; a interface de upload/reprodução de vídeo fica para fases futuras. Nenhuma TD neste documento.

---

## TD-01: Tecnologia de Fila de Processamento em Segundo Plano

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O `docs/project-plan.md` e o `docs/diagrams/software-arch.mermaid` marcam a Message Queue como "TBD" — é a principal decisão de stack em aberto da fase. O worker precisa consumir trabalhos de processamento de vídeo (extração de metadados, geração de thumbnail) de forma assíncrona, com retentativa em falha transitória e um destino final para trabalhos que falham definitivamente (a atividade exige que "a falha de um vídeo não bloqueie a fila"). Nenhuma fila existe hoje no projeto; o `compose.yaml` atual só tem `nestjs-api`, `db` e `mailpit`.

**Options:**

### Option A: BullMQ + Redis (via `@nestjs/bullmq`)
- Fila baseada em Redis, com integração oficial do NestJS (`@nestjs/bullmq`, `BullModule.registerQueue`, decorator `@Processor` sobre `WorkerHost`). Suporta `attempts` + `backoff` por job, eventos de falha (`@OnQueueFailed`), e uma UI de observação (Bull Board) para inspecionar jobs presos ou falhos.
- **Pros:** Padrão oficial e mais maduro do ecossistema NestJS para filas (316+ exemplos na doc oficial `@nestjs/bull`), retry/backoff configurável nativamente, boa visibilidade operacional via Bull Board, amplamente usado em produção.
- **Cons:** Introduz Redis como peça de infraestrutura nova (quarto serviço no Compose, além de storage e worker), mais um sistema para manter saudável e testar no CI.

### Option B: pg-boss (fila sobre o próprio PostgreSQL)
- Fila implementada inteiramente sobre o PostgreSQL já existente, usando `SELECT ... FOR UPDATE SKIP LOCKED` para processamento concorrente seguro. Suporta `retryLimit` por fila e fila de dead-letter nativa (`deadLetter: 'my-queue-dlq'`).
- **Pros:** Zero infraestrutura nova — reaproveita o `db` que já está saudável no Compose. Modelo transacional familiar (mesma tecnologia que o resto do projeto), reduz a superfície de testes de integração (um serviço a menos para orquestrar).
- **Cons:** Sem pacote de integração oficial do NestJS (precisa de um provider customizado). Fila baseada em polling (não put-pulls via pub/sub nativo), que para alto volume tem menos vazão que Redis — irrelevante na escala desta atividade, mas é uma limitação real do modelo.

### Option C: RabbitMQ (AMQP)
- Broker de mensageria dedicado, com `@nestjs/microservices` oferecendo transporte AMQP nativo.
- **Pros:** Padrão de mercado para filas de trabalho pesadas, modelo de exchanges/routing flexível, suporta DLQ nativamente via `x-dead-letter-exchange`.
- **Cons:** Ceremônia desproporcional ao escopo — uma única fila de processamento de vídeo não precisa de exchanges/routing keys. Mais um serviço de infraestrutura com curva de configuração própria (vhosts, policies) sem ganho concreto sobre as opções A/B para este caso de uso.

**Recommendation:** **A (BullMQ + Redis)** — é o caminho oficial do NestJS (`@nestjs/bullmq`), com retry/backoff declarativo por job e boa observabilidade (Bull Board), que ajuda diretamente no requisito de "o que acontece em caso de falha no processamento" (TD-07). A atividade já prevê a fila como peça de infraestrutura nova e testável via Compose — Redis é a peça mais madura e documentada para esse papel. pg-boss (Option B) é uma alternativa legítima para quem prioriza zero infraestrutura nova, mas a ausência de integração oficial do NestJS a torna mais trabalhosa de manter consistente com o resto do projeto.

**Decision:** **A (BullMQ + Redis via `@nestjs/bullmq`)**

---

## TD-02: Estratégia de Upload de Vídeos de Até 10GB

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O `docs/project-plan.md` (Pontos de Atenção) exige que o upload "não trave o sistema e permita retomar em caso de falha de conexão". O object storage é dado (S3-compatível via MinIO) — a decisão aqui é o protocolo de transferência. Um fato técnico elimina opções pela raiz: uma única operação `PUT` no S3/MinIO tem um teto de objeto de 5GB — abaixo dos 10GB exigidos. Qualquer estratégia de envio único e indivisível (presigned PUT simples, presigned POST) está descartada por construção.

**Options:**

### Option A: Upload multipart com URLs pré-assinadas por parte
- O cliente divide o arquivo em partes (ex.: 50-100MB cada). A API abre um multipart upload (`CreateMultipartUploadCommand`), gera uma URL pré-assinada por parte (`@aws-sdk/s3-request-presigner` + `UploadPartCommand`), o cliente envia cada parte diretamente ao MinIO, e a API finaliza com `CompleteMultipartUploadCommand` após receber os ETags de cada parte.
- **Pros:** Suportado nativamente por S3 e MinIO, sem servidor adicional. O SDK oficial da AWS (v3) documenta o fluxo completo. Resumível por natureza: se uma parte falhar, só ela precisa ser reenviada — as partes já confirmadas permanecem no multipart upload em aberto até o `Complete` ou até expirarem.
- **Cons:** O cliente precisa orquestrar o fracionamento e o reenvio de partes falhas — mais lógica do lado de quem envia (mitigado nesta atividade por não haver UI de vídeo: a orquestração acontece nos testes e2e/documentação da API, não em uma interface real).

### Option B: Protocolo tus (upload resumível)
- Protocolo HTTP aberto para uploads resumíveis por chunks, com um servidor tus dedicado (ex.: `tusd`) armazenando offsets.
- **Pros:** Resumabilidade é o requisito central do protocolo, não um efeito colateral — retomar após queda de conexão é trivial do lado do cliente (clientes tus fazem isso automaticamente).
- **Cons:** MinIO não fala tus nativamente — exigiria um servidor `tusd` adicional como intermediário, que teria que escrever no MinIO por fora (mais uma peça de infraestrutura e mais uma tradução de protocolo). Nenhuma lib tus está no stack atual; adicionaria uma dependência nova sem reaproveitar nada do que o S3-compatível já oferece de graça.

**Recommendation:** **A (Multipart com URLs pré-assinadas)** — usa exatamente a API que S3/MinIO já expõe, documentada pelo SDK oficial (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`), sem introduzir um servidor de protocolo adicional. A resumabilidade exigida pelo `project-plan.md` é satisfeita no nível de parte (reenviar só a parte que falhou), o que é suficiente para o escopo desta fase — Option B resolveria resumabilidade de forma mais granular, mas ao custo de uma peça de infraestrutura (`tusd`) que não se integra diretamente ao MinIO.

**Decision:** **A (Multipart com URLs pré-assinadas por parte)**

---

## TD-03: Gatilho do Processamento Após o Upload

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depende de TD-02. Uma vez que o arquivo está completo no object storage, algo precisa disparar o enfileiramento do trabalho de processamento. Há duas fontes possíveis de verdade: o próprio cliente avisando que terminou, ou o storage notificando a aplicação de que um objeto foi criado.

**Options:**

### Option A: Endpoint de finalização explícito
- O cliente chama um endpoint dedicado (ex.: `POST /videos/:id/complete`) depois de enviar a última parte. A API executa `CompleteMultipartUploadCommand`, confirma a integridade com um `HeadObjectCommand`, transiciona o vídeo para `processing` e enfileira o job.
- **Pros:** A API controla todo o ciclo — autorização, idempotência (chamar duas vezes não deveria duplicar o job) e o instante exato da transição de estado ficam sob o mesmo código que já valida o dono do canal. Não depende de configuração externa do storage.
- **Cons:** Confia no cliente para avisar — se o cliente nunca chamar `/complete` (crash, bug), o vídeo fica para sempre em rascunho com arquivo órfão no storage. Mitigável com um job de limpeza periódico, fora do escopo central desta TD.

### Option B: Notificação de evento do bucket (MinIO Bucket Notifications)
- MinIO publica um evento (`s3:ObjectCreated:*`) para um webhook ou fila quando o objeto é efetivamente gravado, disparando o processamento sem o cliente precisar avisar.
- **Pros:** Verdadeiramente orientado a evento — não depende do cliente completar um passo adicional corretamente.
- **Cons:** Exige configurar notificações no MinIO (webhook endpoint ou integração AMQP/Redis própria do MinIO), adicionando uma superfície de configuração de infraestrutura que não aparece em nenhum outro ponto do projeto. A finalização do multipart upload (`CompleteMultipartUploadCommand`) ainda precisaria ser disparada por alguém — o evento de bucket não substitui essa chamada, só o aviso de "está pronto", portanto não elimina a necessidade de um endpoint de finalização, apenas desloca quando o processamento é dirigido.

**Recommendation:** **A (Endpoint de finalização explícito)** — mantém a autorização e o ciclo de vida do vídeo inteiramente sob o controle da API, que já precisa existir para o `CompleteMultipartUploadCommand` de qualquer forma (Option B não elimina essa chamada). Simplicidade de infraestrutura pesa a favor: nenhuma configuração adicional no MinIO.

**Decision:** **A (Endpoint de finalização explícito)**

---

## TD-04: Estratégia de Streaming

**Scope:** Backend

**Capability:** Transversal — covers: Reprodução via streaming (sem necessidade de download completo); Download do vídeo pelo usuário

**Context:** Esta decisão está **acoplada a TD-02**: se a estratégia de streaming fizer a API intermediar a entrega do vídeo, ela reintroduz na leitura o tráfego de bytes que TD-02 tirou da API na escrita. O `project-plan.md` (Pontos de Atenção) exige que "o vídeo deve começar a ser reproduzido sem que o usuário precise baixar o arquivo inteiro" — ou seja, suporte a requisições de intervalo (`Range` / `206 Partial Content`). A mesma decisão cobre o **download** do arquivo, que é a outra forma de entrega do mesmo objeto ao mesmo consumidor.

**Options:**

### Option A: Redirecionamento para URL pré-assinada de leitura (302)
- A API valida que o vídeo está `ready` e que o requisitante tem acesso (público ou unlisted com link), gera uma URL pré-assinada de leitura com TTL curto (`GetObjectCommand` + `getSignedUrl`), e responde com `302 Found` apontando para ela. O cliente (player) refaz a requisição direto ao MinIO, que atende `Range`/`206` nativamente.
- **Pros:** Mantém a API fora do caminho dos bytes de vídeo — coerente com a decisão de TD-02. MinIO já implementa `Range` corretamente, sem precisar reescrever essa lógica na API. Baixo custo de CPU/banda na API mesmo sob muitos espectadores simultâneos.
- **Cons:** O controle de acesso por requisição fica limitado ao instante em que a URL é gerada (TTL curto mitiga isso) — a API não vê cada byte servido, então contagem de banda real por requisição não é trivial de instrumentar (não é requisito desta fase).

### Option B: Proxy de Range pela API
- A API recebe a requisição com cabeçalho `Range`, busca o intervalo correspondente no MinIO internamente e repassa a resposta ao cliente.
- **Pros:** Controle total por requisição — cada byte servido passa pela API, facilitando auditoria/contagem futura.
- **Cons:** Reintroduz exatamente o problema que TD-02 resolveu: o tráfego de um vídeo de 10GB sendo assistido por múltiplos usuários concorrentes volta a passar pela API, consumindo CPU e banda do processo que também atende todas as outras requisições HTTP do sistema.

**Recommendation:** **A (Redirecionamento 302 para URL pré-assinada)** — é a única opção coerente com a decisão já tomada em TD-02 de manter a API fora do caminho dos bytes. Qualquer estratégia de proxy (Option B) desfaz esse ganho exatamente no lado de leitura, que é o lado com mais concorrência potencial (muitos espectadores por vídeo, contra um único uploader por vídeo).

**Streaming vs. download — mesmo mecanismo, dois comportamentos.** Ambos usam o redirecionamento 302 para URL pré-assinada de leitura. A diferença é um único parâmetro na assinatura: o endpoint de download inclui `response-content-disposition=attachment; filename="..."` na URL pré-assinada, fazendo o navegador baixar o arquivo em vez de reproduzi-lo inline; o endpoint de streaming omite o parâmetro e deixa o MinIO servir `Range`/`206` normalmente. Não há caminho de entrega separado, nem TTL distinto — um mecanismo, dois comportamentos.

**Autorização (resolve AMB-1).** Ambos os endpoints permanecem **autenticados** nesta fase, sob o `JwtAuthGuard` global herdado da Fase 02. "Acesso anônimo à visualização de vídeos" é capability declarada da **Fase 05** no `docs/project-plan.md` — abrir os endpoints agora anteciparia escopo de outra fase. A Fase 05 fará o opt-out via `@Public()` quando a visualização anônima entrar em escopo.

**Decision:** **A (Redirecionamento 302 para URL pré-assinada, com `response-content-disposition=attachment` no download; ambos autenticados nesta fase)**

---

## TD-05: Execução do Worker e Extração de Metadados/Thumbnail

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados); Geração automática de thumbnail a partir de um frame do vídeo

**Context:** O worker roda em container separado (exigido pela atividade e pelo diagrama de arquitetura). Falta decidir como ele é estruturado como processo, e como ele acessa um arquivo de até 10GB para extrair metadados e gerar thumbnail sem precisar baixar o arquivo inteiro para disco local — o que seria caro em tempo e espaço para cada job.

**Options:**

### Option A: Contexto de aplicação Nest standalone + FFmpeg lendo via URL pré-assinada
- O worker é um segundo entrypoint do mesmo codebase NestJS (`NestFactory.createApplicationContext`), reaproveitando `TypeOrmModule`, as entidades e o `ConfigModule` já existentes. Ele consome a fila (TD-01), gera uma URL pré-assinada de leitura para o vídeo, e usa `fluent-ffmpeg`/`ffprobe` apontando **diretamente para essa URL** como entrada — o FFmpeg abre a URL via seu próprio protocolo HTTP interno, sem que o Node.js trate o conteúdo como stream em memória.
- **Pros:** Reaproveita toda a configuração e as entidades já existentes (Data Model, `ConfigType`, conexão ao banco) em vez de duplicá-las em um processo à parte — alinhado à diretriz de "continuidade, não retrabalho" do enunciado. `ffprobe` aceita URLs diretamente como entrada (confirmado na documentação oficial do `fluent-ffmpeg`, que inclusive demonstra extração de metadados a partir de uma URL http remota) — não é preciso baixar os 10GB para o disco do worker antes de processar.
- **Cons:** O worker precisa da imagem com FFmpeg instalado via `apt`, diferente da imagem da API — exige um `Dockerfile` próprio (ou um estágio dedicado), mesmo compartilhando o código-fonte.

### Option B: Script standalone desacoplado do NestJS
- Um processo Node.js simples, sem o container de DI do Nest, falando diretamente com TypeORM/pg e consumindo a fila.
- **Pros:** Menor footprint de inicialização por job (sem bootstrap do framework).
- **Cons:** Duplica configuração (entidades, config de banco, config de storage) que já existe no codebase Nest, ou força a extrair esse código para um pacote compartilhado — complexidade extra sem benefício real na escala desta fase. Vai contra a diretriz do próprio enunciado de reaproveitar os padrões do projeto.

**Recommendation:** **A (Contexto de aplicação Nest + FFmpeg lendo via URL)** — reaproveita integralmente os padrões, entidades e configuração já estabelecidos no projeto (único ponto de verdade para o Data Model), e a leitura via URL pré-assinada evita o custo de baixar arquivos de até 10GB para disco antes de processar, resolvendo tanto a extração de metadados (`ffprobe`) quanto a geração de thumbnail (`screenshots()`) a partir da mesma URL de leitura.

**Decision:** **A (Contexto de aplicação Nest standalone + FFmpeg lendo via URL pré-assinada)**

---

## TD-06: Formato do Identificador de URL Única

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** O `project-plan.md` (Pontos de Atenção) exige uma "URL curta e única que nunca conflite com outro vídeo". É uma decisão cross-component: o identificador aparece na coluna do banco, na rota pública da API, e eventualmente em qualquer link compartilhado — precisa ser curto, URL-safe e ter uma estratégia de colisão resolvida na criação.

**Options:**

### Option A: `nanoid` (identificador aleatório curto, URL-safe)
- Gera uma string aleatória curta (ex.: 10-12 caracteres) usando um alfabeto seguro para URL, com uma coluna `UNIQUE` no banco garantindo a unicidade real.
- **Pros:** Padrão moderno para esse exato caso de uso (slugs curtos e únicos), biblioteca pequena e amplamente adotada, probabilidade de colisão desprezível no comprimento recomendado. A detecção de colisão + retentativa pode reaproveitar o mesmo padrão de SAVEPOINT já implementado em `ChannelsService` para o nickname do canal — decisão de implementação já resolvida em Fase 02, não uma nova TD.
- **Cons:** Não é determinístico nem legível — não transmite nenhuma informação sobre o vídeo (irrelevante para o requisito, que pede apenas unicidade e brevidade).

### Option B: UUID como slug
- Reaproveita o padrão de PK já usado em todas as entidades do projeto (`@PrimaryGeneratedColumn('uuid')`) diretamente como identificador de URL.
- **Pros:** Zero código novo — o `id` já existente serve de slug.
- **Cons:** 36 caracteres não atende "URL curta" exigida explicitamente pelo enunciado; UUIDs são feios e difíceis de compartilhar/digitar.

### Option C: Sequência incremental com hashids
- Um contador incremental (ou o próprio id numérico) codificado via hashids para parecer não-sequencial.
- **Pros:** Curto e determinístico.
- **Cons:** Introduz uma dependência e uma camada de codificação/decodificação sem ganho sobre nanoid; sequências incrementais em sistemas distribuídos exigem coordenação (lock ou sequence do Postgres) que nanoid evita por ser gerado sem estado compartilhado.

**Recommendation:** **A (nanoid)** — é o padrão direto para "identificador curto e único", sem a necessidade de coordenação de sequência (Option C) nem o problema de tamanho do UUID (Option B). A garantia final de unicidade continua sendo a constraint `UNIQUE` do Postgres, com retentativa em colisão seguindo o padrão já resolvido em `ChannelsService`.

**Decision:** **A (nanoid)**

---

## TD-07: Ciclo de Status do Vídeo e Comportamento em Falha

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload; Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Depende de TD-01 (a tecnologia de fila determina o mecanismo de retentativa disponível). O enunciado exige um ciclo rascunho → processando → pronto/erro refletido no banco, e que uma falha em um vídeo não trave o processamento dos demais.

**Options:**

### Option A: Retentativa automática da fila + status `failed` definitivo após esgotar tentativas
- O job de processamento usa a retentativa nativa da fila escolhida em TD-01 (BullMQ: `attempts` + `backoff` exponencial por job; pg-boss: `retryLimit` + fila de dead-letter). Cada falha de um job é isolada — não afeta outros jobs na fila. Ao esgotar as tentativas, o vídeo é marcado `failed` e a causa da falha (mensagem de erro) é persistida no registro do vídeo.
- **Pros:** Usa o mecanismo que a própria fila já oferece (sem reinventar retry/backoff na camada de aplicação), isolamento de falha é uma propriedade nativa de filas de trabalho (um job falho não bloqueia os demais), e a causa persistida no banco atende diretamente o requisito de rastreabilidade de erro.
- **Cons:** Nenhum relevante para o escopo desta fase — é o caminho direto suportado pela fila escolhida.

### Option B: Reprocessamento manual exclusivamente (sem retry automático)
- Toda falha marca o vídeo como `failed` imediatamente, sem tentativa automática; um endpoint administrativo permite reenfileirar manualmente.
- **Pros:** Comportamento previsível e simples de depurar — cada falha é visível imediatamente.
- **Cons:** Falhas transitórias (ex.: uma oscilação momentânea de rede entre o worker e o storage) viram erro permanente desnecessariamente, exigindo intervenção manual para o caso mais comum de falha em sistemas distribuídos.

**Recommendation:** **A (Retentativa automática da fila + `failed` definitivo)** — falhas transitórias (rede, contenção momentânea) são o caso mais comum em processamento assíncrono contra um storage externo, e a fila escolhida em TD-01 já resolve isso nativamente sem código extra. O estado `failed` com causa persistida cobre o caso de falha definitiva exigido pela atividade.

**Decision:** **A (Retentativa automática da fila + status `failed` definitivo)**

---

## TD-08: Organização de Buckets e Chaves de Objeto no Storage

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O object storage em si não é decisão em aberto (S3-compatível via MinIO local, por determinação do projeto), mas **como usá-lo é** — o enunciado da atividade declara explicitamente "o que você decide aqui é como usá-lo (organização de buckets/chaves, upload pré-assinado), não qual storage". A escolha é cross-component: a mesma convenção de chaves aparece no serviço de storage da API, no worker que lê o vídeo e grava o thumbnail, na coluna de chave de storage da migration, e na inicialização de bucket do `compose.yaml`. Divergência entre esses pontos quebra a localização do objeto em runtime.

**Options:**

### Option A: Bucket único com prefixos por tipo de objeto
- Um bucket (`streamtube`) com chaves estruturadas por vídeo: `videos/{videoId}/source.{ext}` para o arquivo original e `videos/{videoId}/thumbnail.jpg` para a miniatura gerada. Todo artefato de um vídeo compartilha o prefixo `videos/{videoId}/`.
- **Pros:** Um único bucket para criar e configurar no Compose. Todos os artefatos de um vídeo ficam sob o mesmo prefixo, o que torna a remoção em cascata uma única operação por prefixo. A chave é derivável do `videoId` sem consulta adicional, mantendo o storage service sem estado.
- **Cons:** Políticas de acesso e de ciclo de vida são uniformes para todo o bucket — se no futuro o thumbnail precisar ser público enquanto o vídeo permanece privado, a distinção teria que ser feita por política de prefixo em vez de por bucket.

### Option B: Buckets separados por tipo (`streamtube-videos` / `streamtube-thumbnails`)
- Dois buckets distintos, cada um com sua própria política de acesso e de ciclo de vida.
- **Pros:** Permite políticas genuinamente diferentes por tipo de artefato (ex.: thumbnail com leitura pública direta, vídeo sempre via URL pré-assinada), e regras de expiração independentes.
- **Cons:** Duas peças de infraestrutura para inicializar e manter em sincronia no Compose e na configuração. A remoção de um vídeo passa a exigir operações em dois buckets. O ganho de políticas distintas é especulativo nesta fase — nenhuma capability da Fase 03 pede acesso público ao thumbnail.

**Recommendation:** **A (Bucket único com prefixos por tipo)** — mantém a infraestrutura mínima (um bucket a inicializar no Compose) e torna o ciclo de vida do vídeo coerente: tudo que pertence a um vídeo vive sob `videos/{videoId}/`, removível de uma vez. A flexibilidade de políticas da Option B resolve um problema que nenhuma capability desta fase apresenta, e pode ser introduzida depois por política de prefixo sem migrar os objetos.

**Complemento — uploads multipart abandonados.** Um upload multipart iniciado e nunca finalizado (cliente que desiste ou falha) deixa partes ocupando espaço no bucket indefinidamente. A convenção adotada é configurar uma regra de expiração de multipart uploads incompletos no bucket, de modo que partes órfãs sejam descartadas automaticamente sem intervenção manual.

**Decision:** **A (Bucket único `streamtube` com prefixos `videos/{videoId}/source.{ext}` e `videos/{videoId}/thumbnail.jpg`)**

**Revisions:**
- 2026-10-12 — Backend S3-compatível local trocado de MinIO para LocalStack (serviço `storage` no Compose, tag `localstack/localstack:4`). Rationale: a imagem `minio/minio` deixou de ser distribuída publicamente no Docker Hub (`pull access denied`), `quay.io/minio/minio` responde 401 e o catálogo `bitnami/minio` foi descontinuado — verificado que não é bloqueio geral de registry, pois `redis:8-alpine` puxa anonimamente. A decisão desta TD é inalterada: o storage continua sendo S3-compatível acessado via `@aws-sdk/client-s3`, com bucket único e a mesma convenção de chaves; apenas o servidor local que implementa a API mudou. LocalStack emula o S3 da AWS, que é o alvo declarado de produção do projeto. A tag é fixada na major 4 porque `latest` passou a apontar para a edição Pro, que exige `LOCALSTACK_AUTH_TOKEN` e sai com código 55 sem licença.

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia de Fila de Processamento | BullMQ + Redis | **A** |
| TD-02 | Backend | Estratégia de Upload de 10GB | Multipart com URLs pré-assinadas | **A** |
| TD-03 | Backend | Gatilho do Processamento | Endpoint de finalização explícito | **A** |
| TD-04 | Backend | Estratégia de Streaming e Download | Redirecionamento 302 para URL pré-assinada | **A** |
| TD-05 | Backend | Execução do Worker e FFmpeg | Contexto Nest standalone + FFmpeg via URL | **A** |
| TD-06 | Backend | Formato do Identificador de URL Única | nanoid | **A** |
| TD-07 | Backend | Ciclo de Status e Comportamento em Falha | Retentativa automática da fila + `failed` definitivo | **A** |
| TD-08 | Backend | Organização de Buckets e Chaves de Objeto | Bucket único com prefixos por tipo | **A** |
