// Resolve as situações (status) configuradas para o módulo "Vendas" no Bling,
// incluindo as situações personalizadas da conta do usuário.
//
// A listagem de pedidos (GET /pedidos/vendas) só retorna { situacao: { id, valor } },
// sem o nome da situação. O nome (ex.: "Em separação Fábrica", "BLOQUEADO" etc.) só é
// obtido consultando GET /situacoes/modulos/{idModuloSistema}, então fazemos cache em
// memória (o cadastro de situações muda raramente) e atualizamos periodicamente.

const bling = require('./blingClient');

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutos

let cache = {
  situacoes: null, // [{ id, nome, cor }]
  fetchedAt: 0,
};

// Regra específica pedida: "Bloqueado" e "BLOQUEADO" devem ser tratados como a MESMA
// coluna no painel (apenas diferença de capitalização), sem qualquer outra suposição de
// equivalência entre situações distintas.
function normalizeGroupKey(nome) {
  const trimmed = (nome || '').trim();
  if (trimmed.toUpperCase() === 'BLOQUEADO') {
    return 'BLOQUEADO';
  }
  return trimmed;
}

async function fetchModuloVendasId() {
  const resp = await bling.apiGet('/situacoes/modulos');
  const modulos = resp.data || [];
  const vendas = modulos.find(
    (m) => (m.nome || '').trim().toLowerCase() === 'vendas'
  ) || modulos.find((m) => (m.descricao || '').toLowerCase().includes('pedidos de venda'));

  if (!vendas) {
    throw new Error(
      `Não foi possível localizar o módulo "Vendas" em /situacoes/modulos. Módulos retornados: ${JSON.stringify(
        modulos.map((m) => ({ id: m.id, nome: m.nome }))
      )}`
    );
  }
  return vendas.id;
}

async function fetchSituacoesVendasFromApi() {
  const idModulo = await fetchModuloVendasId();
  const resp = await bling.apiGet(`/situacoes/modulos/${idModulo}`);
  const situacoes = (resp.data || []).map((s) => ({
    id: s.id,
    nome: s.nome,
    cor: s.cor || null,
  }));
  return situacoes;
}

// Retorna a lista de situações + estruturas auxiliares de agrupamento (com cache).
async function getSituacoesVendas({ forceRefresh = false } = {}) {
  const isStale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (!cache.situacoes || isStale || forceRefresh) {
    const situacoes = await fetchSituacoesVendasFromApi();
    cache = { situacoes, fetchedAt: Date.now() };
  }
  return cache.situacoes;
}

// Monta a lista de "colunas" do painel a partir das situações cadastradas no Bling,
// já aplicando a fusão Bloqueado/BLOQUEADO. Preserva a ordem original informada
// pela API para cada situação "canônica" (primeira ocorrência).
function buildColumnDefinitions(situacoes) {
  const columnsByKey = new Map();
  const situacaoIdToKey = new Map();

  for (const situacao of situacoes) {
    const key = normalizeGroupKey(situacao.nome);
    situacaoIdToKey.set(situacao.id, key);

    if (!columnsByKey.has(key)) {
      columnsByKey.set(key, {
        key,
        // Para o caso mesclado, o rótulo exibido é sempre "BLOQUEADO" (forma canônica
        // pedida). Para os demais, mantemos o nome exatamente como veio do Bling.
        label: key,
        situacaoIds: [],
        // guarda os nomes originais, útil para depuração/transparência
        nomesOriginais: [],
        cor: situacao.cor,
      });
    }
    const col = columnsByKey.get(key);
    col.situacaoIds.push(situacao.id);
    col.nomesOriginais.push(situacao.nome);
  }

  return { columns: Array.from(columnsByKey.values()), situacaoIdToKey };
}

module.exports = { getSituacoesVendas, buildColumnDefinitions, normalizeGroupKey };
