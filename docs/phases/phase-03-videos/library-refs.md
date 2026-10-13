---
libs:
  - name: "@nestjs/bullmq"
    version: "^11.0.5"
    td: phase-03-videos/TD-01
  - name: "bullmq"
    version: "^6.3.13"
    td: phase-03-videos/TD-01
  - name: "ioredis"
    version: "^5.11.1"
    td: phase-03-videos/TD-01
  - name: "@aws-sdk/client-s3"
    version: "^3.1150.0"
    td: phase-03-videos/TD-02
  - name: "@aws-sdk/s3-request-presigner"
    version: "^3.1150.0"
    td: phase-03-videos/TD-02
  - name: "fluent-ffmpeg"
    version: "^2.1.3"
    td: phase-03-videos/TD-05
  - name: "@types/fluent-ffmpeg"
    version: "^2.1.28"
    td: phase-03-videos/TD-05
  - name: "nanoid"
    version: "^3.3.20"
    td: phase-03-videos/TD-06
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-10-12T17:52:00-03:00"
---

# phase-03-videos — Library References

Versões resolvidas contra o registry npm de dentro do container (`nestjs-api`, Node v25.6.0) em 2026-10-12, e verificadas por compatibilidade com o stack instalado (`@nestjs/core@11.1.16`, TypeScript `module: nodenext`, `target: ES2023`).

## Runtime do ambiente

| Item | Valor | Origem |
|------|-------|--------|
| Node | v25.6.0 | `node -v` dentro do container |
| `@nestjs/core` | 11.1.16 | instalado |
| Compilação | CommonJS (`module: nodenext` + pacote sem `"type": "module"`) | `tsconfig.json` |

---

## TD-01 — Fila (BullMQ + Redis)

### `@nestjs/bullmq@^11.0.5` ⚠️ versão deliberadamente não-latest

Integração oficial do NestJS para BullMQ. Fornece `BullModule.registerQueue()`, o decorator `@Processor` e a classe abstrata `WorkerHost` cujo método `process(job)` é o ponto de entrada do consumidor.

**A última versão é a 12.0.0, e ela foi rejeitada em tempo de implementação.** Mesma classe de problema do `nanoid` abaixo: a v12 declara `"type": "module"` e sua condição `require` aponta para o **mesmo arquivo ESM**, o que a torna inutilizável sob CommonJS. O sintoma é um erro de parsing no Jest, não um erro de resolução:

```
SyntaxError: Unexpected token 'export'
  node_modules/@nestjs/bullmq/dist/index.js:1
  export { getQueueToken, JOB_REF } from '@nestjs/bull-shared';
```

Evidência (`npm view <pkg> type exports`):

| Versão | `type` | Condição `require` do exports map | Veredito |
|--------|--------|-----------------------------------|----------|
| `@nestjs/bullmq@12.0.0` | `module` | aponta para `./dist/index.js` — o **mesmo** arquivo ESM | Quebra em CommonJS |
| `@nestjs/bullmq@11.0.5` | ausente (= CommonJS) | `main: dist/index.js` em CJS | Funciona |

**Compatibilidade verificada da v11.0.5** (`npm view @nestjs/bullmq@11.0.5 peerDependencies`):

```
bullmq:         ^3.0.0 || ^4.0.0 || ^5.0.0 || ^6.0.0
@nestjs/core:   ^10.0.0 || ^11.0.0
@nestjs/common: ^10.0.0 || ^11.0.0
```

O projeto usa `@nestjs/core@11.1.16` → dentro do range. O `bullmq@^6` fixado abaixo → dentro do range. A v11 perde apenas o suporte declarado a um futuro NestJS 12, irrelevante aqui.

**API relevante (confirmada via context7):**

- Registro: `BullModule.registerQueue({ name, defaultJobOptions: { attempts, backoff } })`.
- Consumidor: classe com `@Processor('<queue>')` estendendo `WorkerHost`, implementando `async process(job: Job<T>): Promise<R>`.
- Semântica de falha: **lançar um erro dentro de `process()` marca o job como falho e dispara a retentativa conforme `attempts`/`backoff`** — é o mecanismo que TD-07 usa. O valor resolvido vira o `returnvalue` do job.
- Observação de falha: decorator `@OnQueueFailed()` para reagir a `(job, err)`.

### `bullmq@^6.3.13`

Engine da fila. `engines: { node: '>=14.17.0' }` → compatível com Node 25.

### `ioredis@^5.11.1` — dependência opcional que **precisa** ser instalada

O `bullmq@6` trata o `ioredis` como `peerOptional` e **não o traz por transitividade**. Sem instalação explícita, a construção da `Queue` falha em runtime (não em build):

```
BullMQ could not load the optional 'ioredis' package.
Install it with `npm install ioredis`, or provide a different Redis client instance.
```

**A versão é forçada pela v5, não pela latest.** A `ioredis@6.0.0` é a mais recente, mas entra em conflito de peer com o `typeorm` já instalado:

| Consumidor | Range exigido | `ioredis@5.11.1` | `ioredis@6.0.0` |
|-----------|---------------|------------------|------------------|
| `bullmq@6.3.13` | `>=5.0.0` (peerOptional) | ✓ | ✓ |
| `typeorm@0.3.28` | `^5.0.4` (peerOptional) | ✓ | ✗ `ERESOLVE` |

A v5 é a única que satisfaz os dois simultaneamente. Instalar a v6 exigiria `--legacy-peer-deps`, o que mascararia o conflito em vez de resolvê-lo.

### Redis

Serviço de infraestrutura, não dependência npm — entra no `compose.yaml` como container (imagem oficial `redis`). O `@nestjs/bullmq` se conecta via as opções de conexão passadas ao `BullModule.forRoot()`. **Host deve ser o nome do serviço do Compose, nunca `localhost`** (regra do `CLAUDE.md`).

---

## TD-02 / TD-04 / TD-08 — Object storage (S3-compatível)

### `@aws-sdk/client-s3@^3.1150.0`

Cliente S3 oficial (AWS SDK v3, modular). Usado contra o object storage S3-compatível do Compose (LocalStack) via `endpoint` customizado + `forcePathStyle: true`.

**Comandos relevantes ao fluxo multipart de TD-02:**

- `CreateMultipartUploadCommand` — abre o upload e devolve o `UploadId`.
- `UploadPartCommand` — uma parte por vez; é este comando que é **pré-assinado** por parte.
- `CompleteMultipartUploadCommand` — finaliza, recebendo os `ETag` de cada parte.
- `AbortMultipartUploadCommand` — descarta um upload incompleto.
- `HeadObjectCommand` — confirma presença/integridade do objeto (usado no endpoint de finalização de TD-03).
- `GetObjectCommand` — base da URL pré-assinada de leitura (TD-04).

### `@aws-sdk/s3-request-presigner@^3.1150.0`

Pacote separado que gera as URLs pré-assinadas — em v3 isso **não** está no cliente (diferente do v2, que tinha `getSignedUrl()` no próprio client).

**API confirmada via context7:**

```typescript
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const url = await getSignedUrl(client, command, { expiresIn: 3600 });
```

`expiresIn` é opcional e **o default é 900 segundos**. A doc confirma que o mesmo `getSignedUrl` serve para qualquer comando S3 — é assim que TD-02 pré-assina `UploadPartCommand` e TD-04 pré-assina `GetObjectCommand`.

**Nota de versionamento:** o AWS SDK v3 publica todos os subpacotes em lockstep. `client-s3` e `s3-request-presigner` devem ser mantidos na mesma versão para evitar divergência de middleware.

**Não usar `@aws-sdk/lib-storage` (`Upload`)** neste fluxo: aquela classe faz o multipart **a partir do processo Node que a chama** — ou seja, o arquivo passaria pela API, exatamente o que TD-02 proíbe. Ela é a ferramenta certa para upload server-side (o worker gravando o thumbnail), não para o upload do usuário.

---

## TD-05 — Processamento de vídeo

### `fluent-ffmpeg@^2.1.3` + `@types/fluent-ffmpeg@^2.1.28`

Wrapper com API fluente sobre o binário do FFmpeg. Não embute o FFmpeg — **o binário precisa existir na imagem do worker** (instalado via `apt` no Dockerfile do worker).

**API confirmada via context7:**

- Metadados: `ffmpeg.ffprobe(input, (err, metadata) => ...)`. O retorno traz `metadata.format.duration` (duração do container, em segundos) e `metadata.streams[]` com `codec_name`, `width`, `height`, `bit_rate`, `r_frame_rate` por stream.
- Thumbnail: `.screenshots({ timestamps, filename, folder, size })`.

**Dois detalhes que a documentação oficial confirma e que sustentam TD-05:**

1. **`ffprobe` aceita URL remota como entrada.** O próprio exemplo de estrutura de saída da doc usa `"filename": "http://download.blender.org/.../BigBuckBunny_320x180.mp4"` — ou seja, extrair metadados de uma URL pré-assinada é uso documentado, não gambiarra. É o que evita baixar 10GB por job.
2. **`screenshots()` não funciona sobre input stream** ("Will not work on input streams", na doc). Isso **reforça** a escolha de TD-05 de passar a URL como input em vez de encanar um stream do Node para o FFmpeg — pela URL, o FFmpeg abre a conexão HTTP por conta própria e busca só os bytes de que precisa.

Para redimensionar o thumbnail, usar a opção `size` de `screenshots()` — a doc avisa explicitamente para **não** usar o método `.size()` em conjunto.

---

## TD-06 — Identificador de URL única

### `nanoid@^3.3.20` ⚠️ versão deliberadamente não-latest

**A última versão é a 6.0.2, e ela foi rejeitada.** Motivo: `nanoid@6` é **ESM puro** e este projeto compila para CommonJS.

Evidência (`npm view <pkg> exports`):

| Versão | `exports["."]` tem condição `require`? | Veredito |
|--------|----------------------------------------|----------|
| `nanoid@6.0.2` | **Não** — só `types`, `browser`, `default`, `react-native` | Quebra em `require()` |
| `nanoid@3.3.20` | **Sim** — `require: { types: './index.d.cts', default: './index.cjs' }` | Funciona em CJS |

A v3 ainda declara `"main": "index.cjs"`, confirmando o duplo suporte. Como o `tsconfig.json` usa `module: nodenext` sem `"type": "module"` no `package.json`, a saída compilada é CommonJS e só a v3 resolve.

**Alternativa considerada e descartada:** usar `nanoid@6` com `await import()` dinâmico. Rejeitada por introduzir assincronia e uma borda ESM/CJS numa operação que é puramente síncrona e trivial (gerar uma string curta) — complexidade sem retorno.

**Uso:** `nanoid(size)` gera identificador URL-safe. A unicidade real é garantida pela constraint `UNIQUE` da coluna no Postgres; o `nanoid` apenas torna a colisão improvável. Colisão é tratada por retentativa, seguindo o padrão de SAVEPOINT já estabelecido em `ChannelsService` (Fase 02).

---

## Resumo para `package.json`

```jsonc
// dependencies
"@nestjs/bullmq": "^11.0.5",  // v11 obrigatória — v12 é ESM-only
"bullmq": "^6.3.13",
"ioredis": "^5.11.1",          // peer opcional do bullmq; v5 por conflito com typeorm
"@aws-sdk/client-s3": "^3.1150.0",
"@aws-sdk/s3-request-presigner": "^3.1150.0",
"fluent-ffmpeg": "^2.1.3",
"nanoid": "^3.3.20",          // v3 obrigatória — v4+ é ESM-only

// devDependencies
"@types/fluent-ffmpeg": "^2.1.28"
```

Infraestrutura (containers, não npm): **Redis** (TD-01) e **LocalStack S3** (TD-02/04/08), ambos no `compose.yaml`, acessados pelo nome do serviço do Compose.

---

## Padrão recorrente — ESM-only quebra este projeto

Três das bibliotecas acima tiveram a versão mais recente rejeitada **pelo mesmo motivo**: o projeto compila para CommonJS (`module: nodenext` sem `"type": "module"` no `package.json`), e pacotes ESM-only falham nele — às vezes só em runtime ou sob o Jest, não no `tsc`.

| Lib | Latest | Fixada | Sintoma se usasse a latest |
|-----|--------|--------|----------------------------|
| `nanoid` | 6.0.2 | `^3.3.20` | Sem condição `require` no exports map |
| `@nestjs/bullmq` | 12.0.0 | `^11.0.5` | `SyntaxError: Unexpected token 'export'` no Jest |
| `ioredis` | 6.0.0 | `^5.0.4` | `ERESOLVE` por conflito de peer com `typeorm` |

**Verificação antes de adicionar qualquer lib nova:** rodar `npm view <pkg> type exports` e conferir se existe condição `require` apontando para um arquivo `.cjs` distinto do ESM. Um `"type": "module"` cuja condição `require` aponta para o mesmo arquivo do `import` é ESM-only disfarçado — o caso do `@nestjs/bullmq@12`.
