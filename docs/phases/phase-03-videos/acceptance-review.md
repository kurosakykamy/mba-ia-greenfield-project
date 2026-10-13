# Fase 03 — Auditoria de Conformidade

**Veredito:** ✅ **Pronto para entrega**, com 1 pendência sob responsabilidade do usuário (commit do trabalho).

> **Revisão posterior do usuário encontrou 3 pendências que esta auditoria não cobriu** — `openapi.json` desatualizado, `@ApiBearerAuth` sem nome de scheme e diagrama de arquitetura com "TBD". Todas corrigidas; ver §8. O veredito se mantém após a correção e a reexecução da DoD.

**Data:** 2026-10-13
**Escopo:** os 15 critérios de aceite positivos e as 8 condições de reprova automática do enunciado.
**Método:** evidência por execução sempre que existia comando que comprovasse o comportamento. Auditar comportamento lendo código é a mesma classe de erro que a atividade proíbe ao exigir infraestrutura real nos testes.

**Ambiente da auditoria:** stack completa de pé (6 serviços) e o **worker real** (`npm run worker` no container `video-worker`) consumindo a fila — não o processor instanciado em teste.

---

## Resumo

| Grupo | Atendidos |
|---|---|
| Decisões e planejamento | 3/3 |
| Implementação — feature | 5/5 |
| Implementação — infraestrutura e qualidade | 5/5 |
| Documentação e ferramenta | 2/2 |
| Reprovas automáticas evitadas | 8/8 |

---

## 1. Decisões e planejamento

### 1.1 — `technical-decisions-phase-03-videos.md` com as decisões em aberto resolvidas e justificadas ✅

As cinco decisões exigidas pelo enunciado (fila, estratégia de upload, streaming, processamento/thumbnail, ciclo de status) estão resolvidas, mais três que emergiram do planejamento. Estrutura verificada TD a TD:

| TD | Tema | Options | Recommendation | Decision | Capability |
|----|------|---------|----------------|----------|------------|
| TD-01 | Tecnologia de fila | 3 | ✓ | ✓ A | ✓ |
| TD-02 | Upload de até 10GB | 2 | ✓ | ✓ A | ✓ |
| TD-03 | Gatilho do processamento | 2 | ✓ | ✓ A | ✓ |
| TD-04 | Streaming e download | 2 | ✓ | ✓ A | ✓ |
| TD-05 | Worker e FFmpeg | 2 | ✓ | ✓ A | ✓ |
| TD-06 | Identificador de URL única | 3 | ✓ | ✓ A | ✓ |
| TD-07 | Ciclo de status e falha | 2 | ✓ | ✓ A | ✓ |
| TD-08 | Buckets e chaves de objeto | 2 | ✓ | ✓ A | ✓ |

Nenhuma decisão foi declarada sem alternativa considerada. `status: decided` no frontmatter.

**Nota de rastreabilidade:** a TD-08 carrega um bloco `**Revisions:**` registrando a troca do backend de storage local de MinIO para LocalStack, com a evidência da indisponibilidade da imagem. O corpo original da TD não foi reescrito — a convenção do projeto trata o bloco como log append-only.

### 1.2 — Pasta `docs/phases/phase-03-videos/` com os cinco artefatos ✅

```
context.md          197 linhas
validation.md        63 linhas   status: clean, issue_count: 0
phase-03-videos.md  611 linhas
progress.md         131 linhas   Status: completed, SIs 10/10
library-refs.md     218 linhas
```

**`validation.md` fecha em `clean`** — verificado no frontmatter. As 3 issues da primeira rodada (MD-1, MD-2, AMB-1) estão em `## Resolved Issues` com `resolved_by` apontando para as TDs que as fecharam.

**`library-refs.md`** fixa 8 bibliotecas; todas conferidas uma a uma contra o `package.json` real. Uma divergência foi encontrada **durante esta auditoria** e corrigida: `ioredis` estava registrado como `^5.0.4` (o range pesquisado) enquanto o instalado é `^5.11.1`. Mesma major, mas o artefato deve refletir o instalado.

### 1.3 — Formato do plano ✅

- **10 SIs** numerados `SI-03.1` a `SI-03.10`.
- **Technical Specifications** com as cinco subseções exigidas, todas com conteúdo substantivo:

| Subseção | Conteúdo |
|---|---|
| Data Model | 26 linhas |
| API Contracts | 87 linhas |
| Authorization Matrix | 12 linhas |
| Error Catalog | 9 linhas |
| **Events/Messages** | 20 linhas |

- **Dependency Map** com caminho crítico e SIs paralelizáveis.
- **Deliverables** com checklist de SIs, capacidades, infraestrutura, DoD e documentação.

**Data Model** cobre os 9 campos exigidos pelo enunciado: identificação (`id`), canal dono (`channel_id`), título, status, chave do arquivo (`storage_key`), chave do thumbnail (`thumbnail_key`), duração, metadados e identificador da URL única (`slug`).

**Duas inconsistências encontradas e corrigidas nesta auditoria:** o SI-03.1 ainda descrevia o serviço de storage como `minio` e trazia um critério de aceite com um comando inexistente (`docker compose exec minio mc ready local`). O serviço se chama `storage` e o probe correto é via `curl` ao health do LocalStack.

---

## 2. Implementação — feature

### 2.1 — Upload de até 10GB sem travar a API, com pré-cadastro como rascunho ✅

Fluxo executado de ponta a ponta:

```
POST /videos            → slug=dzBsBDqwF94X, status=draft
  ↑ o vídeo JÁ está no banco como rascunho, antes de qualquer byte subir
PUT direto ao storage   → etag="63fbb711f9383a69d15ef59164c02e8d"
POST /:id/complete      → status=processing
```

Limite de 10 GiB aplicado por DTO (`@Max(10737418240)`) e por recusa de domínio `VIDEO_FILE_TOO_LARGE`; ambos cobertos por teste. O arquivo é fracionado em partes de 100 MiB, cada uma com sua URL pré-assinada — um `PUT` único esbarraria no teto de objeto do S3, abaixo de 10GB.

### 2.2 — Processamento automático: duração, metadados e thumbnail ✅

Executado pelo **worker real** consumindo a fila:

```
duracao = 3s
metadata = {"codec":"h264","width":320,"height":240,"bitrate":181000,"framerate":"15/1"}
thumbnail = gravado no bucket, URL de leitura utilizável
```

`ffprobe` lê direto da URL pré-assinada — o arquivo não é baixado para o disco do worker.

### 2.3 — URL única por vídeo, sem conflito ✅

```sql
UQ_5dbcc1ee100f853490582eccc71 (u) -> UNIQUE (slug)
```

A constraint no banco é a garantia real; o `nanoid` apenas torna a colisão improvável. A retentativa por SAVEPOINT é testada forçando uma colisão real contra o PostgreSQL.

### 2.4 — Streaming e download ✅

```
GET /:slug/stream   → 302 → HTTP/1.1 206 PARTIAL CONTENT
                            Content-Range: bytes 0-99/67875
GET /:slug/download → 302 → Content-Disposition: attachment; filename="Fluxo completo.mp4"
                            67875 bytes recebidos = tamanho original
```

O `Content-Range` prova os dois requisitos de uma vez: só o trecho pedido veio (100 bytes) e o total do arquivo é informado (67875) — isto é, a reprodução começa sem o download completo. Busca para o meio do arquivo coberta por teste separado.

### 2.5 — Ciclo de status refletido no banco ✅

`draft` → `processing` → `ready` observado no banco durante a execução. O caminho de erro é coberto por teste de integração: arquivo inválido leva a `failed` com `failure_reason` preenchido, após esgotar as tentativas, sem bloquear os demais jobs da fila.

---

## 3. Implementação — infraestrutura e qualidade

### 3.1 — Storage, fila e worker subindo via Compose ✅

```
db            Up (healthy)
mailpit       Up (healthy)
nestjs-api    Up
redis         Up (healthy)
storage       Up (healthy)
video-worker  Up
```

Nenhuma configuração de serviço aponta para `localhost`. As duas ocorrências restantes são legítimas: uma está **dentro** do healthcheck do storage (o container checando a si mesmo) e a outra é um comentário no `.env.example` reforçando a regra.

### 3.2 — Migration cria a tabela; entidade ligada ao canal ✅

```
migrations aplicadas:
  CreateUsersAndChannels1775687773260
  CreateAuthTokens1777579850478
  CreateVideos1791848160197

FK: FOREIGN KEY (channel_id) REFERENCES channels(id)
```

O vídeo pertence ao **canal**, não ao usuário, como o enunciado exige.

### 3.3 — Testes nos níveis adequados, verdes ✅

| Nível | Arquivos da fase |
|---|---|
| Unit (`*.spec.ts`) | `storage.util.spec.ts`, `slug.util.spec.ts`, `videos.service.spec.ts` |
| Integration (`*.integration-spec.ts`) | `storage.service`, `video.entity`, `video-processing.processor`, `videos.queue`, `videos.service` |
| E2E (`*.e2e-spec.ts`) | `test/videos.e2e-spec.ts` |

**Zero mocks de storage ou fila nos testes de integração** — verificado arquivo a arquivo. Mocks existem apenas na camada unitária (`videos.service.spec.ts`), onde são esperados para isolar lógica de domínio.

### 3.4 — Definition of Done completa ✅

| Comando | Resultado |
|---|---|
| `npm test -- --runInBand` | **31/31 suítes, 202/202 testes** |
| `npm run test:e2e` | **4/4 suítes, 71/71 testes** |
| `npx tsc --noEmit` | **código 0** |
| `npm run lint` | **0 erros** (1 warning pré-existente da Fase 02) |

Rodados com o worker ativo consumindo a fila em paralelo — o cenário realista.

### 3.5 — Git Flow respeitado ✅

```
branch atual:  feature/phase-03-videos
dev é ancestral de feature/phase-03-videos:  sim
main == origin/main:  sim — nenhum commit local em main
```

---

## 4. Documentação e ferramenta

### 4.1 — `CLAUDE.md` atualizado e coerente com o código ✅

Raiz e `nestjs-project/` atualizados. Conferência item a item:

- Os **5 endpoints** documentados existem no controller, com os decorators correspondentes.
- Os **7 caminhos de arquivo** citados existem.
- Os **9 scripts npm** citados existem no `package.json`.
- Os **6 serviços** do Compose citados existem.
- Os **comandos de verificação** documentados foram executados: `redis-cli ping` → `PONG`; health do storage → `s3: running`; `pg_isready` → `accepting connections`.

### 4.2 — Portabilidade de ferramenta — **não se aplica** ✅

O trabalho foi conduzido no Claude Code. A fundação de IA do repositório (`CLAUDE.md`, `.claude/skills/`, `.claude/agents/`, `.claude/rules/`, `.mcp.json`) é nativa dele e não precisou ser portada.

---

## 5. Reprovas automáticas — verificações independentes

| # | Condição | Veredito | Evidência |
|---|---|---|---|
| 1 | Pular o workflow | ✅ evitada | Os artefatos existem e a ordem de criação segue o pipeline: decisões (17:54) → contexto (17:58) → plano → código → progresso. |
| 2 | Plano sem SIs ou sem Technical Specs | ✅ evitada | 10 SIs `SI-03.x`; as 5 subseções presentes com conteúdo. |
| 3 | `validation.md` não fecha em `clean` | ✅ evitada | `status: clean`, `issue_count: 0`. |
| 4 | Arquivo de 10GB atravessando a API | ✅ evitada | Evidência tripla abaixo. |
| 5 | Fila, worker e storage não reais no Compose | ✅ evitada | 6 serviços de pé; zero mocks nos testes de integração; worker real exercitado. |
| 6 | `tsc` com erro, lint quebrado ou suíte vermelha | ✅ evitada | 202/202, 71/71, tsc 0, lint 0 erros. |
| 7 | Commit direto na `main` | ✅ evitada | `main == origin/main`. |
| 8 | `CLAUDE.md` inconsistente com o código | ✅ evitada | Endpoints, caminhos, scripts, serviços e comandos conferidos um a um. |

### Detalhe da reprova nº 4 — o arquivo não atravessa a API

Três evidências independentes e convergentes:

1. **Para onde a URL pré-assinada aponta:** `host = storage:4566`, não a API.
2. **Nenhum interceptor de upload no código:** busca por `FileInterceptor`, `@UploadedFile`, `multer`, `busboy`, `FilesInterceptor` em todo o `src/` não retorna nada.
3. **O body parser não foi elevado:** o `main.ts` mantém o limite padrão do Express (100 kb), coerente com uma API que nunca recebe arquivos. Se a API recebesse o vídeo, esse limite teria que ser elevado.

---

## 6. Pendência

**O trabalho não está commitado.** 56 arquivos alterados ou novos no working tree da `feature/phase-03-videos`. O git é conduzido manualmente pelo usuário, que também definiu que **nada relacionado ao OpenSpec deve ser commitado** — a pasta `openspec/`, as skills `openspec-*` e `.claude/commands/` aparecem como não rastreados e devem permanecer fora do commit.

Os arquivos da entrega a commitar são os de `docs/` e `nestjs-project/`, mais os dois `CLAUDE.md`.

---

## 7. Correções aplicadas durante esta auditoria

A auditoria não é só leitura — três inconsistências reais foram encontradas e corrigidas:

1. **`library-refs.md` × `package.json`:** `ioredis` registrado como `^5.0.4`, instalado como `^5.11.1`.
2. **SI-03.1 citava o serviço como `minio`:** o serviço se chama `storage` desde a troca registrada em TD-08.
3. **Critério de aceite com comando inexistente:** `docker compose exec minio mc ready local` substituído pelo probe real de health do storage.

Também foi feita uma varredura de menções obsoletas a "MinIO" nos artefatos que descrevem o **estado atual** (`context.md`, `library-refs.md`, `phase-03-videos.md`, `progress.md`), trocadas por linguagem neutra de object storage. O **documento de decisões foi deliberadamente preservado**: ele é o registro histórico da pesquisa, e a convenção do projeto trata `Revisions:` como log append-only — reescrever o corpo original apagaria a rastreabilidade da decisão.


---

## 8. Pendências encontradas em revisão posterior

Uma revisão manual do usuário, feita depois desta auditoria e antes do commit, encontrou três itens que os checks automatizados aqui **não cobriram**. Vale registrar por que escaparam — é a lição mais útil deste documento.

| # | Achado | Por que a auditoria não pegou |
|---|---|---|
| 1 | `openapi.json` sem nenhuma rota de vídeo | A auditoria conferiu que os endpoints existem **no controller** e que a documentação em prosa os descreve. Não conferiu o **artefato gerado** — `openapi.json` é versionado e é o contrato real consumido pelo frontend. |
| 2 | `@ApiBearerAuth()` sem `'access-token'` | A auditoria verificou a *presença* das anotações OpenAPI, não a *correção semântica* delas. O decorator sem argumento emite um scheme (`bearer`) que não existe no documento — erro invisível sem regenerar e inspecionar o JSON. |
| 3 | `software-arch.mermaid` com `Message Queue, "TBD"` | A varredura de consistência cobriu os dois `CLAUDE.md`, não os diagramas que eles referenciam. O `CLAUDE.md` da raiz aponta esse arquivo como referência de arquitetura — ele contradizia o próprio `CLAUDE.md`. |

Mais três divergências menores entre plano e código foram corrigidas na mesma passagem: status code do `/complete` (`200` no plano, `201` no código), comentário falso no `Dockerfile.worker` e `timestamptz` no Data Model (onde o **código estava certo** e o plano é que descrevia errado).

**Lição para auditorias futuras:** verificar a existência de uma anotação não é o mesmo que verificar que ela produz o artefato correto. Onde houver artefato gerado versionado (`openapi.json`, diagramas, schemas), regenerá-lo e comparar com o versionado deve ser um passo explícito.

**DoD reexecutada após as correções:** 31/31 suítes e 202/202 testes; e2e 4/4 e 71/71; `tsc` código 0; lint 0 erros.
