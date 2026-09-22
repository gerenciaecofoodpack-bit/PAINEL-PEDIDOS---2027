# Painel de Pedidos — Bling

Painel operacional somente-leitura que consulta os pedidos de venda no Bling, agrupa por
situação e mostra em cards/colunas, com atualização automática. **Não altera nada no Bling**
— o backend só faz chamadas `GET`.

## Como funciona

```
Bling (API v3) --GET--> Backend (Node/Express) --agrupa por situação--> Frontend (painel)
```

- O backend autentica no Bling via OAuth2 (Authorization Code), guarda o token (em arquivo
  local por padrão, ou num Redis gratuito da Upstash se configurado — veja "Publicar na web"
  abaixo) e renova automaticamente.
- Busca os pedidos de venda com paginação completa (`GET /pedidos/vendas`) e resolve o nome
  de cada situação via `GET /situacoes/modulos/{id}` (a listagem de pedidos só traz o ID da
  situação, não o nome).
- **Bloqueado x BLOQUEADO**: se a API retornar as duas grafias como situações distintas (IDs
  diferentes), o painel as funde numa única coluna "BLOQUEADO" apenas para exibição — o valor
  original de cada pedido no Bling não é alterado. Nenhuma outra situação é presumida
  equivalente a outra.
- O `Client Secret` nunca é exposto ao navegador: todas as chamadas à API do Bling acontecem
  no backend.

## Pré-requisitos

- Node.js 18 ou superior.
- Um aplicativo cadastrado no Bling (**Configurações → Aplicativos**, ou
  `https://developer.bling.com.br/aplicativos`) com:
  - Client ID
  - Client Secret
  - URL de callback (redirect URI) configurada — precisa ser **idêntica** à que você colocar
    no `.env` (`BLING_REDIRECT_URI`), incluindo `http`/`https` e path.

## Configuração

1. Instale as dependências:
   ```bash
   npm install
   ```
2. Copie o arquivo de exemplo de variáveis de ambiente e preencha com suas credenciais:
   ```bash
   cp .env.example .env
   ```
   - `BLING_CLIENT_ID` / `BLING_CLIENT_SECRET`: do aplicativo criado no Bling.
   - `BLING_REDIRECT_URI`: deve bater exatamente com a URL de callback cadastrada no Bling.
     Em desenvolvimento local, normalmente `http://localhost:3000/auth/callback`. Em produção,
     use o endereço público final do sistema (HTTPS), ex.:
     `https://painel.suaempresa.com.br/auth/callback`.
   - `PORT`: porta do servidor local (padrão 3000).
   - `SESSION_SECRET`: string aleatória qualquer, usada só para assinar o cookie de proteção
     CSRF do login (não é senha de nada). Gere uma com:
     ```bash
     node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
     ```
   - `POLL_INTERVAL_SECONDS`: intervalo de atualização automática do painel (padrão 30s).

3. Suba o servidor:
   ```bash
   npm start
   ```
4. Abra `http://localhost:3000` (ou a porta configurada) no navegador e clique em
   **"Conectar ao Bling"**. Você será redirecionado para autorizar o aplicativo; ao concluir,
   volta automaticamente para o painel já carregando os pedidos.

## Publicar na web (para exibir numa TV)

O painel guarda um token e faz chamadas periódicas ao Bling, então precisa de um servidor
rodando o tempo todo — não dá para publicar só como um site estático. Estas instruções usam o
plano **gratuito** do [Render](https://render.com), que só libera a criação manual de um
**"Web Service"** (o fluxo "Blueprint" e o disco persistente ficam reservados para planos
pagos).

**Passo a passo:**

1. **Suba o código para o GitHub** (não precisa saber Git: dá para criar o repositório e
   arrastar os arquivos direto pelo navegador):
   - Crie uma conta em [github.com](https://github.com) se ainda não tiver.
   - Clique em "New repository", dê um nome (ex.: `bling-painel`) e marque como **privado**.
   - Na tela do repositório vazio, use "uploading an existing file" e arraste todo o conteúdo
     da pasta do projeto (não precisa da pasta `node_modules`, ela não deve ir).

2. **Crie o Web Service no Render:**
   - No painel do Render, clique em **"New +"** → **"Web Service"**.
   - Conecte sua conta do GitHub e selecione o repositório `bling-painel`.
   - Configure:
     - **Name**: `bling-painel` (ou o nome que preferir — isso define parte da URL final).
     - **Language/Runtime**: `Node`.
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
     - **Instance Type**: `Free`.
   - Antes de criar, clique em **"Advanced"** (ou role até "Environment Variables") e adicione:
     - `BLING_CLIENT_ID` — do aplicativo cadastrado no Bling.
     - `BLING_CLIENT_SECRET` — idem.
     - `BLING_REDIRECT_URI` — deixe qualquer valor por enquanto (ex.: `https://exemplo.com/auth/callback`); você volta aqui no passo 4.
     - `SESSION_SECRET` — qualquer string aleatória longa.
     - `POLL_INTERVAL_SECONDS` — `30`.
   - Clique em **"Create Web Service"**. O primeiro deploy leva alguns minutos.

3. **Anote a URL pública** que o Render deu ao serviço, algo como
   `https://bling-painel-xxxx.onrender.com` (aparece no topo da página do serviço).

4. **Feche o círculo do redirect URI:**
   - No painel do Bling (`https://developer.bling.com.br/aplicativos`), edite o aplicativo e
     configure a URL de callback exatamente como:
     `https://bling-painel-xxxx.onrender.com/auth/callback`
   - No Render, vá na aba **"Environment"** do serviço e edite `BLING_REDIRECT_URI` com esse
     mesmo valor. Salve — o serviço reinicia sozinho (~1 minuto).
   - As duas URLs (Bling e Render) precisam ser **idênticas**, caractere por caractere.

5. **Conecte a conta uma única vez:** abra a URL pública no navegador, clique em
   **"Conectar ao Bling"** e autorize.

6. **Na TV:** abra a mesma URL num navegador (Smart TV, um Chromecast/Fire Stick/mini-PC
   ligado na TV), adicionando `?tv=1` no final
   (`https://bling-painel-xxxx.onrender.com/?tv=1`). Clique no botão **"Modo TV"** no canto
   (some quase todo, só aparece ao passar o mouse) para ocultar os controles e entrar em tela
   cheia. `Esc` volta ao normal a qualquer momento.

### Sobre o plano gratuito do Render (leia antes de deixar rodando sem supervisão)

O plano free tem duas limitações que afetam este painel:

- **"Dorme" sem acesso**: se ninguém abrir o painel por ~15 minutos, o serviço hiberna e a
  próxima requisição demora ~30-60s para responder (ele "acorda"). **Na prática, com a TV
  ligada e a aba aberta fazendo a atualização automática a cada 30s, isso não deve acontecer**
  — o próprio painel mantém o serviço acordado sozinho.
- **Sem disco persistente**: por padrão, o token de acesso ao Bling é salvo num arquivo que
  **some** toda vez que o serviço reinicia (hibernou e acordou de novo, você editou uma
  variável de ambiente, o Render fez uma manutenção, etc.). Quando isso acontece, o painel
  passa a pedir para reconectar a conta — alguém precisa abrir a tela e clicar em "Conectar ao
  Bling" de novo.

Se isso for um problema para o seu caso (TV sem ninguém por perto para reconectar), você tem
duas opções, sem custo:

**Opção A — Upstash Redis grátis (recomendada):** guarda o token num banco gratuito externo
(nunca expira, sem cartão de crédito), então ele sobrevive a qualquer reinício do Render.
1. Crie uma conta grátis em [upstash.com](https://upstash.com) → "Create Database" → tipo
   **Redis**, plano **Free**, qualquer região.
2. Na página do banco criado, copie os valores **"UPSTASH_REDIS_REST_URL"** e
   **"UPSTASH_REDIS_REST_TOKEN"** (aba "REST API").
3. No Render, vá em **Environment** do serviço `bling-painel` e adicione essas duas variáveis
   com os valores copiados. Salve (reinicia sozinho).
4. Abra o painel e clique em "Conectar ao Bling" mais uma vez — daqui em diante o token
   persiste para sempre, mesmo com reinícios.

**Opção B — aceitar o plano free como está:** não faça nada extra. Funciona bem no dia a dia
(a TV com a aba aberta mantém o serviço acordado); só será preciso reconectar manualmente de
vez em quando (ex.: depois de uma manutenção do Render). Se isso acontecer com frequência
incômoda, migre para a Opção A ou para um plano pago do Render (que já inclui disco
persistente, veja `render.yaml`).

## Uso

- Os pedidos são exibidos agrupados por situação, em colunas — inclusive situações sem
  nenhum pedido no momento (aparecem com contagem 0).
- **Pesquisar pedido ou cliente**: filtro instantâneo sobre os pedidos já carregados.
- **Período**: "Todo o período" (padrão), Hoje, Ontem, Últimos 7 dias, Últimos 30 dias, ou
  período personalizado. Ao mudar o período, o backend consulta o Bling já filtrando por
  `dataInicial`/`dataFinal` na própria API, evitando carregar pedidos desnecessários.
  (A API do Bling recusa intervalos maiores que 1 ano.)
- **Atualizar agora**: força uma nova consulta imediata. Além disso, o painel atualiza
  sozinho a cada `POLL_INTERVAL_SECONDS` segundos.
- Se o Bling ficar indisponível ou a API retornar erro, o painel **mantém os últimos dados
  válidos na tela** e mostra um aviso com a hora da última atualização bem-sucedida e um
  botão "Tentar novamente". Se a autenticação expirar (token/refresh token inválidos), o
  painel pede para reconectar a conta.
- **Modo TV**: botão no topo (ou `?tv=1` na URL) que esconde pesquisa/filtros e pede tela
  cheia — pensado para deixar a tela ligada numa TV da produção sem ninguém interagindo.
  `Esc` sai da tela cheia e do Modo TV.

## Notas sobre a API do Bling (v3)

Confirmado na documentação/OpenAPI oficial (`https://developer.bling.com.br/referencia`) em
2026-09-22:

- Autenticação: OAuth2, Authorization Code. `authorize` em
  `https://www.bling.com.br/Api/v3/oauth/authorize`, troca/renovação de token em
  `POST https://api.bling.com.br/Api/v3/oauth/token` (Basic Auth com `client_id:client_secret`
  em base64, corpo `application/x-www-form-urlencoded`).
- Listagem de pedidos: `GET /pedidos/vendas`, paginado via `pagina`/`limite` (até 100 por
  página), com filtros `dataInicial`/`dataFinal` (entre outros). O item retornado traz
  `situacao: { id, valor }` — **sem o nome** da situação.
- Nomes de situação (inclusive as personalizadas da conta): `GET /situacoes/modulos` (acha o
  módulo "Vendas") e depois `GET /situacoes/modulos/{idModuloSistema}` (lista `{id, nome,
  cor}`). O backend cacheia esse resultado por 10 minutos.
- Limites da conta: 3 requisições/segundo e 120.000/dia (o backend já respeita isso com um
  limitador de taxa interno). Passar desses limites pode levar a bloqueio temporário do IP.

## Estrutura do projeto

```
server/
  index.js            rotas HTTP (OAuth + /api/status + /api/pedidos)
  config.js           variáveis de ambiente e endpoints da API do Bling
  blingClient.js       OAuth2 + chamadas GET autenticadas + limitador de taxa
  rateLimiter.js       limitador de 3 req/s
  situacoesService.js  resolve nomes de situação e normaliza Bloqueado/BLOQUEADO
  pedidosService.js    paginação completa + agrupamento por situação
  tokenStore.js         persistência do token (arquivo local ou Upstash Redis, se configurado)
public/
  index.html / styles.css / app.js   painel (frontend estático, sem build step)
```

## Segurança

- Por padrão, `server/.data/tokens.json` guarda o access/refresh token localmente — mantenha
  o servidor em um ambiente controlado e não versione essa pasta (já está no `.gitignore`).
- Se usar Upstash (veja acima), o token fica no banco Redis da sua conta Upstash — trate as
  credenciais `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` como segredos.
- `.env` também está no `.gitignore` — nunca faça commit dele.
