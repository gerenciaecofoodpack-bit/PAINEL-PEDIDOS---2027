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
  situacoes: null, // [{ id, nome, cor }]  (todas as situações da conta, sem filtro)
  fetchedAt: 0,
};

// Only estas situações aparecem no painel, NA ORDEM ABAIXO (o restante que existir na
// conta Bling é ignorado). "Bloqueado" e "BLOQUEADO" são intencionalmente duas entradas
// aqui (para casar com os dois jeitos que a conta pode ter cadastrado), mas viram uma
// única coluna "BLOQUEADO" — ver normalizeGroupKey.
const SITUACOES_PERMITIDAS_EM_ORDEM = [
  'Em aberto',
  'Cancelado',
  'Aguardando definição de arte',
  'Nota fiscal emitida',
  'Enviado ao transportador',
  'Em produção',
  'Em separação Fábrica',
  // As duas colunas de "pendente item" ficam lado a lado de propósito, pra facilitar a
  // visualização de quem está olhando o quadro (pedido do usuário).
  'Pendente ítem - Fábrica',
  'Pendente item - Bonsucesso',
  'Bloqueado',
  'Em separação - Bonsucesso',
  'Faturado parcial',
  'Pedido separado - Fábrica',
  'Pedido separado - Bonsucesso',
  'Pronto para retirada - Bonsucesso',
  'Pronto para retirada - Fábrica',
  'Pedido Separado - Franquias',
  'Pendência Item Resolvida',
  'Aguardando Disponibilidade',
  'Roteiro Próprio',
  'Finalizado',
  'BLOQUEADO',
  'AGUARDANDO PAGAMENTO',
  'ML - A LIBERAR',
  'Em Emissão',
  'Aguardando retorno do cliente',
];

// Compara nomes de situação ignorando maiúsculas/minúsculas, espaços extras e um ponto
// final (a conta tem, por ex., "Nota fiscal emitida." com ponto — a lista pedida não).
function normalizeForMatch(nome) {
  return (nome || '')
    .normalize('NFC')
    .trim()
    .toLowerCase()
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ');
}

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

// Retorna TODAS as situações da conta (sem filtro), com cache.
async function getSituacoesVendas({ forceRefresh = false } = {}) {
  const isStale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (!cache.situacoes || isStale || forceRefresh) {
    const situacoes = await fetchSituacoesVendasFromApi();
    cache = { situacoes, fetchedAt: Date.now() };
  }
  return cache.situacoes;
}

// Monta a lista de "colunas" do painel: só as situações da lista permitida (na ordem
// fixa definida acima), casando pelo nome com o que a conta Bling realmente tem
// cadastrado. Situações da conta que não estão na lista permitida simplesmente não
// geram coluna nenhuma (os pedidos delas não aparecem no painel).
function buildColumnDefinitions(situacoes) {
  const porNomeNormalizado = new Map(); // nome normalizado -> [situacao,...]
  for (const situacao of situacoes) {
    const k = normalizeForMatch(situacao.nome);
    if (!porNomeNormalizado.has(k)) porNomeNormalizado.set(k, []);
    porNomeNormalizado.get(k).push(situacao);
  }

  const columnsByKey = new Map();
  const situacaoIdToKey = new Map();
  const allSituacaoIds = new Set(situacoes.map((s) => s.id));
  // "Bloqueado" e "BLOQUEADO" normalizam para o mesmo nome (case-insensitive) — evita
  // processar o mesmo grupo de situações duas vezes quando as duas entradas aparecem
  // na lista permitida.
  const nomesNormalizadosProcessados = new Set();

  for (const nomePermitido of SITUACOES_PERMITIDAS_EM_ORDEM) {
    const nomeNormalizado = normalizeForMatch(nomePermitido);
    if (nomesNormalizadosProcessados.has(nomeNormalizado)) continue;
    nomesNormalizadosProcessados.add(nomeNormalizado);

    const encontradas = porNomeNormalizado.get(nomeNormalizado) || [];
    if (encontradas.length === 0) continue; // essa situação não existe (ainda) nessa conta Bling

    const key = normalizeGroupKey(nomePermitido);
    if (!columnsByKey.has(key)) {
      // Rótulo: para o caso mesclado sempre "BLOQUEADO"; para os demais, o nome
      // exatamente como o Bling retornou (pode ter pontuação/capitalização própria).
      const label = key === 'BLOQUEADO' ? 'BLOQUEADO' : encontradas[0].nome;
      columnsByKey.set(key, {
        key,
        label,
        situacaoIds: [],
        nomesOriginais: [],
        cor: encontradas[0].cor,
      });
    }
    const col = columnsByKey.get(key);
    for (const situacao of encontradas) {
      col.situacaoIds.push(situacao.id);
      col.nomesOriginais.push(situacao.nome);
      situacaoIdToKey.set(situacao.id, key);
    }
  }

  return { columns: Array.from(columnsByKey.values()), situacaoIdToKey, allSituacaoIds };
}

module.exports = {
  getSituacoesVendas,
  buildColumnDefinitions,
  normalizeGroupKey,
  SITUACOES_PERMITIDAS_EM_ORDEM,
};
