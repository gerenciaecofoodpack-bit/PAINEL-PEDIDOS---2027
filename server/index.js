const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cookieParser = require('cookie-parser');

const config = require('./config');
const bling = require('./blingClient');
const pedidosService = require('./pedidosService');
const { clearTokens } = require('./tokenStore');

const app = express();
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// OAuth: login, callback, status, logout
// ---------------------------------------------------------------------------

app.get('/auth/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie('bling_oauth_state', state, {
    httpOnly: true,
    maxAge: 10 * 60 * 1000,
    sameSite: 'lax',
  });
  res.redirect(bling.buildAuthorizeUrl(state));
});

app.get('/auth/callback', async (req, res) => {
  const { code, state, error, error_description: errorDescription } = req.query;

  if (error) {
    res.status(400).send(
      `Autorização negada ou falhou no Bling: ${error} - ${errorDescription || ''}. Feche esta aba e tente novamente no painel.`
    );
    return;
  }

  // O "state" protege contra CSRF quando o fluxo começa pelo botão "Conectar ao Bling"
  // deste painel (que grava o cookie bling_oauth_state antes de redirecionar). Se o
  // usuário chegou aqui por outro caminho iniciado no próprio Bling (ex.: um link de
  // convite/instalação do aplicativo), não existe esse cookie — nesse caso não há como
  // comparar, então só recusamos quando EXISTE um cookie e ele não bate (indício real de
  // adulteração); a troca do code por token, protegida pelo Client Secret, continua sendo
  // a barreira de segurança principal em ambos os casos.
  const expectedState = req.cookies && req.cookies.bling_oauth_state;
  if (expectedState && state !== expectedState) {
    res.status(400).send('Falha de segurança (state inválido) ao concluir a autorização. Tente novamente.');
    return;
  }
  res.clearCookie('bling_oauth_state');

  if (!code) {
    res.status(400).send('Código de autorização ausente na resposta do Bling.');
    return;
  }

  try {
    await bling.exchangeCodeForToken(code);
    res.redirect('/?conectado=1');
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[auth/callback] Falha ao trocar code por token:', err);
    res.status(502).send(`Não foi possível concluir a conexão com o Bling: ${err.message}`);
  }
});

app.post('/auth/logout', async (req, res) => {
  await clearTokens();
  res.json({ ok: true });
});

app.get('/api/status', async (req, res) => {
  res.json({
    conectado: await bling.isConnected(),
    pollIntervalSeconds: config.pollIntervalSeconds,
  });
});

// ---------------------------------------------------------------------------
// Dados do painel (somente leitura)
// ---------------------------------------------------------------------------

app.get('/api/pedidos', async (req, res) => {
  if (!(await bling.isConnected())) {
    res.status(401).json({
      erro: 'NAO_CONECTADO',
      mensagem: 'Nenhuma conta Bling conectada. Conecte o aplicativo para visualizar os pedidos.',
    });
    return;
  }

  const periodo = String(req.query.periodo || 'todos');
  const de = req.query.de ? String(req.query.de) : undefined;
  const ate = req.query.ate ? String(req.query.ate) : undefined;

  try {
    const painel = await pedidosService.getPainelData({ periodo, de, ate });
    res.json(painel);
  } catch (err) {
    if (err instanceof bling.BlingAuthError) {
      res.status(401).json({
        erro: 'REAUTENTICACAO_NECESSARIA',
        mensagem: 'A conexão com o Bling expirou. É necessário reconectar a conta.',
      });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[GET /api/pedidos] erro:', err);
    res.status(502).json({
      erro: 'FALHA_CONSULTA_BLING',
      mensagem: err.message || 'Não foi possível atualizar os pedidos no momento.',
    });
  }
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Painel de pedidos Bling rodando em http://localhost:${config.port}`);
  if (!config.blingClientId || !config.blingClientSecret || !config.blingRedirectUri) {
    // eslint-disable-next-line no-console
    console.warn(
      '[startup] Credenciais do Bling incompletas. Copie .env.example para .env e preencha BLING_CLIENT_ID, BLING_CLIENT_SECRET e BLING_REDIRECT_URI.'
    );
  }
});
