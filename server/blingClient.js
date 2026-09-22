// Cliente HTTP para a API v3 do Bling: autenticação OAuth2 (Authorization Code) e
// chamadas autenticadas, com renovação automática de token e limite de requisições.
//
// Somente-leitura por construção: este módulo só expõe métodos GET. Nenhuma rota deste
// projeto deve chamar POST/PUT/PATCH/DELETE em recursos de pedidos, notas, estoque etc.

const config = require('./config');
const tokenStore = require('./tokenStore');
const { RateLimiter, sleep } = require('./rateLimiter');

const limiter = new RateLimiter(3); // 3 requisições/segundo, limite da conta no Bling

class BlingAuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BlingAuthError';
  }
}

class BlingApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.name = 'BlingApiError';
    this.status = status;
    this.body = body;
  }
}

function basicAuthHeader() {
  const raw = `${config.blingClientId}:${config.blingClientSecret}`;
  return `Basic ${Buffer.from(raw, 'utf-8').toString('base64')}`;
}

function buildAuthorizeUrl(state) {
  const url = new URL(config.bling.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.blingClientId);
  url.searchParams.set('state', state);
  url.searchParams.set('redirect_uri', config.blingRedirectUri);
  return url.toString();
}

async function requestToken(bodyParams) {
  const res = await fetch(config.bling.tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
      Accept: '1.0',
      'enable-jwt': '1',
    },
    body: new URLSearchParams(bodyParams).toString(),
  });

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new BlingAuthError(
      `Falha ao obter token do Bling (HTTP ${res.status}): ${JSON.stringify(json)}`
    );
  }

  const expiresInSeconds = json.expires_in || 21600; // fallback: 6h, padrão comum do Bling
  const tokens = {
    accessToken: json.access_token,
    refreshToken: json.refresh_token,
    tokenType: json.token_type || 'Bearer',
    expiresAt: Date.now() + expiresInSeconds * 1000,
  };
  await tokenStore.saveTokens(tokens);
  return tokens;
}

async function exchangeCodeForToken(code) {
  return requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.blingRedirectUri,
  });
}

async function refreshAccessToken(refreshToken) {
  return requestToken({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}

async function getValidAccessToken({ forceRefresh = false } = {}) {
  const tokens = await tokenStore.getTokens();
  if (!tokens || !tokens.accessToken || !tokens.refreshToken) {
    throw new BlingAuthError('Nenhuma conta Bling conectada. É necessário autorizar o aplicativo.');
  }

  const msUntilExpiry = tokens.expiresAt - Date.now();
  if (forceRefresh || msUntilExpiry < 60 * 1000) {
    try {
      const refreshed = await refreshAccessToken(tokens.refreshToken);
      return refreshed.accessToken;
    } catch (err) {
      // Se a renovação falhar, o token/refresh_token pode ter expirado de fato:
      // sinalizamos como erro de autenticação para o front pedir reconexão.
      throw new BlingAuthError(`Não foi possível renovar o token do Bling: ${err.message}`);
    }
  }
  return tokens.accessToken;
}

async function isConnected() {
  const tokens = await tokenStore.getTokens();
  return Boolean(tokens && tokens.accessToken && tokens.refreshToken);
}

// Executa um GET autenticado contra a API do Bling, com throttle, retry em 429
// e uma única tentativa de renovação de token em caso de 401.
async function apiGet(pathname, searchParams = {}, { _retriedAuth = false, _retryCount = 0 } = {}) {
  const accessToken = await getValidAccessToken();

  const url = new URL(config.bling.apiBaseUrl + pathname);
  for (const [key, value] of Object.entries(searchParams)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const v of value) url.searchParams.append(key, v);
    } else {
      url.searchParams.set(key, String(value));
    }
  }

  const doFetch = () =>
    fetch(url.toString(), {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
        'enable-jwt': '1',
      },
    });

  const res = await limiter.schedule(doFetch);

  if (res.status === 401 && !_retriedAuth) {
    await getValidAccessToken({ forceRefresh: true });
    return apiGet(pathname, searchParams, { _retriedAuth: true, _retryCount });
  }

  if (res.status === 429) {
    if (_retryCount >= 4) {
      throw new BlingApiError('Limite de requisições do Bling atingido repetidamente.', 429);
    }
    const retryAfterHeader = res.headers.get('retry-after');
    const waitMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 1200 * (_retryCount + 1);
    await sleep(waitMs);
    return apiGet(pathname, searchParams, { _retriedAuth, _retryCount: _retryCount + 1 });
  }

  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }

  if (!res.ok) {
    throw new BlingApiError(
      `Erro na API do Bling ao consultar ${pathname} (HTTP ${res.status})`,
      res.status,
      json
    );
  }

  return json;
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  isConnected,
  apiGet,
  BlingAuthError,
  BlingApiError,
};
