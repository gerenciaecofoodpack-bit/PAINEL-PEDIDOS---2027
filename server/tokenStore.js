// Armazenamento do token OAuth do Bling.
//
// Por padrão grava em disco (server/.data/tokens.json) — funciona bem localmente e em
// qualquer hospedagem com disco persistente (ex.: Render no plano pago).
//
// No plano GRATUITO do Render (e de outros serviços parecidos) não existe disco
// persistente: a cada "spin down"/reinício o sistema de arquivos é resetado e o token
// salvo se perderia, exigindo reconectar a conta manualmente com frequência.
//
// Para contornar isso de graça, se as variáveis UPSTASH_REDIS_REST_URL e
// UPSTASH_REDIS_REST_TOKEN estiverem definidas (veja o README, seção "Plano gratuito do
// Render"), o token é salvo num banco Redis gratuito da Upstash via API REST, em vez do
// disco local. Nesse caso a conexão com o Bling sobrevive a reinícios/redeploys.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '.data');
const TOKEN_FILE = path.join(DATA_DIR, 'tokens.json');

const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = 'bling_painel_tokens';

const usingUpstash = Boolean(UPSTASH_URL && UPSTASH_TOKEN);

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ---------------------------------------------------------------------------
// Backend: arquivo local
// ---------------------------------------------------------------------------

function getTokensFromFile() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function saveTokensToFile(payload) {
  ensureDir();
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

function clearTokensFromFile() {
  try {
    fs.unlinkSync(TOKEN_FILE);
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ---------------------------------------------------------------------------
// Backend: Upstash Redis (REST API), usado só se as variáveis de ambiente existirem
// ---------------------------------------------------------------------------

async function upstashCommand(pathSegments, body) {
  const url = `${UPSTASH_URL.replace(/\/$/, '')}/${pathSegments.map(encodeURIComponent).join('/')}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_TOKEN}`,
        ...(body !== undefined ? { 'Content-Type': 'text/plain' } : {}),
      },
      body,
    });
  } catch (err) {
    // Falha de rede ao falar com o Upstash (fora do ar, DNS, etc.) — erro claro em vez
    // de deixar a exceção "crua" do fetch se propagar sem contexto.
    throw new Error(`Não foi possível falar com o Upstash (${pathSegments[0]}): ${err.message}`);
  }
  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(
      `Upstash respondeu HTTP ${res.status} ao executar ${pathSegments[0]}. Confira se UPSTASH_REDIS_REST_URL e UPSTASH_REDIS_REST_TOKEN estão corretos. ${bodyText.slice(0, 200)}`
    );
  }
  return res.json();
}

async function getTokensFromUpstash() {
  const result = await upstashCommand(['get', UPSTASH_KEY]);
  if (!result || result.result === null || result.result === undefined) return null;
  try {
    return JSON.parse(result.result);
  } catch {
    return null;
  }
}

async function saveTokensToUpstash(payload) {
  await upstashCommand(['set', UPSTASH_KEY], JSON.stringify(payload));
}

async function clearTokensFromUpstash() {
  await upstashCommand(['del', UPSTASH_KEY]);
}

// ---------------------------------------------------------------------------
// API pública (assíncrona nos dois casos, para o restante do código não precisar saber
// qual backend está em uso)
// ---------------------------------------------------------------------------

async function getTokens() {
  return usingUpstash ? getTokensFromUpstash() : getTokensFromFile();
}

async function saveTokens(tokens) {
  const payload = {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: tokens.tokenType || 'Bearer',
    expiresAt: tokens.expiresAt,
    updatedAt: Date.now(),
  };
  if (usingUpstash) {
    await saveTokensToUpstash(payload);
  } else {
    saveTokensToFile(payload);
  }
  return payload;
}

async function clearTokens() {
  if (usingUpstash) {
    await clearTokensFromUpstash();
  } else {
    clearTokensFromFile();
  }
}

module.exports = { getTokens, saveTokens, clearTokens, usingUpstash };
