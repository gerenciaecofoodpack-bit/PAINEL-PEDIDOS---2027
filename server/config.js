require('dotenv').config();

function required(name) {
  const value = process.env[name];
  if (!value) {
    // eslint-disable-next-line no-console
    console.warn(`[config] Variável de ambiente ${name} não definida. Configure o arquivo .env (veja .env.example).`);
  }
  return value;
}

module.exports = {
  blingClientId: required('BLING_CLIENT_ID'),
  blingClientSecret: required('BLING_CLIENT_SECRET'),
  blingRedirectUri: required('BLING_REDIRECT_URI'),
  port: parseInt(process.env.PORT || '3000', 10),
  sessionSecret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '30', 10),

  // Endpoints oficiais da API v3 do Bling (confirmados na documentação/OpenAPI oficial
  // em https://developer.bling.com.br/referencia em 2026-09-22).
  bling: {
    apiBaseUrl: 'https://api.bling.com.br/Api/v3',
    authorizeUrl: 'https://www.bling.com.br/Api/v3/oauth/authorize',
    tokenUrl: 'https://api.bling.com.br/Api/v3/oauth/token',
  },
};
