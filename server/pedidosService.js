// Busca os pedidos de venda no Bling (com paginação completa) e monta o agrupamento
// por situação exibido no painel. Módulo somente-leitura: só faz chamadas GET.

const bling = require('./blingClient');
const situacoesService = require('./situacoesService');

const PAGE_SIZE = 100; // máximo recomendado pela API para reduzir número de requisições
const MAX_PAGES_SAFETY = 500; // rede de segurança (50 mil pedidos) só para evitar loop infinito por bug/API

// A listagem de pedidos NÃO traz os itens (produtos) — só o detalhe de cada pedido
// (GET /pedidos/vendas/{id}) traz isso, então é uma chamada por pedido. Pra não pesar,
// guardamos os itens em cache (o conteúdo de um pedido já criado raramente muda) e, a
// cada atualização do painel, só buscamos o detalhe dos pedidos que ainda não estão no
// cache — limitado por chamada pra não deixar a primeira carga lentíssima numa conta com
// muito pedido; o que sobrar completa nas atualizações automáticas seguintes.
const itensCache = new Map(); // idPedidoVenda -> { itens: [{descricao, quantidade}], fetchedAt }
const ITENS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const MAX_DETAIL_FETCHES_PER_CALL = 40;

function pad2(n) {
  return String(n).padStart(2, '0');
}

function toApiDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// Calcula dataInicial/dataFinal (strings YYYY-MM-DD) a partir do filtro de período do painel.
// A API do Bling recusa (HTTP 400) intervalos maiores que 1 ano, então "todos" não envia filtro.
function resolvePeriodo(periodo, deStr, ateStr) {
  const hoje = startOfDay(new Date());

  switch (periodo) {
    case 'hoje':
      return { dataInicial: toApiDate(hoje), dataFinal: toApiDate(hoje) };
    case 'ontem': {
      const ontem = new Date(hoje);
      ontem.setDate(ontem.getDate() - 1);
      return { dataInicial: toApiDate(ontem), dataFinal: toApiDate(ontem) };
    }
    case '7d': {
      const inicio = new Date(hoje);
      inicio.setDate(inicio.getDate() - 6);
      return { dataInicial: toApiDate(inicio), dataFinal: toApiDate(hoje) };
    }
    case '30d': {
      const inicio = new Date(hoje);
      inicio.setDate(inicio.getDate() - 29);
      return { dataInicial: toApiDate(inicio), dataFinal: toApiDate(hoje) };
    }
    case 'custom': {
      if (!deStr || !ateStr) {
        throw new Error('Período personalizado requer os parâmetros "de" e "ate" (YYYY-MM-DD).');
      }
      return { dataInicial: deStr, dataFinal: ateStr };
    }
    case 'todos':
    default:
      return { dataInicial: undefined, dataFinal: undefined };
  }
}

async function fetchAllPedidos({ dataInicial, dataFinal }) {
  const pedidos = [];
  let pagina = 1;

  // A API pagina de forma sequencial; respeitamos isso e vamos até a API retornar
  // menos itens que o tamanho de página pedido (ou uma página vazia).
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (pagina > MAX_PAGES_SAFETY) {
      // eslint-disable-next-line no-console
      console.warn(
        `[pedidosService] Atingido limite de segurança de ${MAX_PAGES_SAFETY} páginas ao buscar pedidos. Interrompendo paginação.`
      );
      break;
    }

    // eslint-disable-next-line no-await-in-loop
    const resp = await bling.apiGet('/pedidos/vendas', {
      pagina,
      limite: PAGE_SIZE,
      dataInicial,
      dataFinal,
    });

    const data = resp.data || [];
    pedidos.push(...data);

    if (data.length < PAGE_SIZE) break;
    pagina += 1;
  }

  return pedidos;
}

function isItensCacheFresh(idPedidoVenda) {
  const cached = itensCache.get(idPedidoVenda);
  return Boolean(cached) && Date.now() - cached.fetchedAt < ITENS_CACHE_TTL_MS;
}

// Evita buscar o mesmo pedido duas vezes ao mesmo tempo quando duas atualizações do
// painel (ex.: a automática a cada 30s e um "Atualizar agora" manual) se sobrepõem.
const itensEmAndamento = new Set();

async function fetchItensPedido(idPedidoVenda) {
  itensEmAndamento.add(idPedidoVenda);
  try {
    const resp = await bling.apiGet(`/pedidos/vendas/${idPedidoVenda}`);
    const itensRaw = (resp.data && resp.data.itens) || [];
    const itens = itensRaw.map((it) => ({
      descricao: it.descricao || it.descricaoDetalhada || null,
      quantidade: typeof it.quantidade === 'number' ? it.quantidade : Number(it.quantidade) || 0,
    }));
    itensCache.set(idPedidoVenda, { itens, fetchedAt: Date.now() });
  } catch (err) {
    // Não derruba o painel inteiro por causa de 1 pedido: só aquele card fica sem os
    // itens até uma próxima tentativa (próxima atualização automática).
    // eslint-disable-next-line no-console
    console.warn(`[pedidosService] Falha ao buscar itens do pedido ${idPedidoVenda}: ${err.message}`);
  } finally {
    itensEmAndamento.delete(idPedidoVenda);
  }
}

// Dispara (sem bloquear a resposta do painel) a busca dos itens que ainda não estão em
// cache, respeitando um limite de pedidos por vez. Importante: isso é chamado sem
// "await" pelo getPainelData — se ficássemos esperando aqui, uma conta com muitos
// pedidos poderia deixar a atualização do painel lenta o bastante para estourar o
// tempo limite do navegador/servidor. Assim, a resposta atual sai com o que já estiver
// em cache, e o que faltar entra sozinho no cache a tempo da próxima atualização
// automática (30s depois).
function garantirItensEmCache(idsPedidos) {
  const faltando = idsPedidos.filter((id) => !isItensCacheFresh(id) && !itensEmAndamento.has(id));
  const aBuscarAgora = faltando.slice(0, MAX_DETAIL_FETCHES_PER_CALL);
  return Promise.all(aBuscarAgora.map((id) => fetchItensPedido(id)));
}

function formatPedidoResumo(pedido) {
  const cached = itensCache.get(pedido.id);
  const itens = cached ? cached.itens : null;
  const quantidadeItens = itens ? itens.length : null;
  const quantidadeTotal = itens ? itens.reduce((acc, it) => acc + (it.quantidade || 0), 0) : null;
  const itensResumo = itens ? itens.map((it) => it.descricao).filter(Boolean).join(', ') : null;

  return {
    id: pedido.id,
    numero: pedido.numero,
    numeroLoja: pedido.numeroLoja || null,
    cliente: pedido.contato ? pedido.contato.nome : null,
    data: pedido.data || null,
    dataPrevista: pedido.dataPrevista || null,
    idSituacao: pedido.situacao ? pedido.situacao.id : null,
    quantidadeItens,
    quantidadeTotal,
    itensResumo,
  };
}

function isHoje(dataStr) {
  if (!dataStr) return false;
  const hoje = toApiDate(new Date());
  return dataStr.slice(0, 10) === hoje;
}

// Monta o objeto final consumido pelo front: colunas (uma por situação, mesmo vazias)
// já ordenadas, com os pedidos do mais recente para o mais antigo, e o resumo do topo.
async function getPainelData({ periodo, de, ate }) {
  const { dataInicial, dataFinal } = resolvePeriodo(periodo, de, ate);

  const [situacoes, pedidosBrutos] = await Promise.all([
    situacoesService.getSituacoesVendas(),
    fetchAllPedidos({ dataInicial, dataFinal }),
  ]);

  const { columns, situacaoIdToKey, allSituacaoIds } = situacoesService.buildColumnDefinitions(situacoes);

  // Só as situações da lista permitida (ver situacoesService.js) viram coluna. Pedidos em
  // qualquer outra situação da conta são intencionalmente deixados de fora do painel —
  // não contam no resumo nem aparecem em lugar nenhum.
  const pedidosIncluidos = [];
  let idsSituacaoDesconhecidos = false;

  for (const pedidoBruto of pedidosBrutos) {
    const idSituacao = pedidoBruto.situacao ? pedidoBruto.situacao.id : undefined;
    const key = situacaoIdToKey.get(idSituacao);

    if (!key) {
      if (!allSituacaoIds.has(idSituacao)) {
        idsSituacaoDesconhecidos = true;
      }
      continue;
    }
    pedidosIncluidos.push({ key, pedidoBruto });
  }

  // Dispara em segundo plano a busca dos itens dos pedidos que vão aparecer no painel
  // (respeitando o limite por chamada) — sem esperar terminar, pra não atrasar esta
  // resposta. O que for buscado agora já aparece na atualização automática seguinte.
  garantirItensEmCache(pedidosIncluidos.map((p) => p.pedidoBruto.id)).catch(() => {});

  const pedidosPorColuna = new Map(columns.map((c) => [c.key, []]));
  for (const { key, pedidoBruto } of pedidosIncluidos) {
    pedidosPorColuna.get(key).push(formatPedidoResumo(pedidoBruto));
  }

  // Ordena pedidos de cada coluna do mais recente para o mais antigo.
  for (const lista of pedidosPorColuna.values()) {
    lista.sort((a, b) => {
      const da = a.data || '';
      const db = b.data || '';
      if (da !== db) return da < db ? 1 : -1;
      return (b.numero || 0) - (a.numero || 0);
    });
  }

  const colunasFinal = columns.map((c) => ({
    key: c.key,
    label: c.label,
    cor: c.cor,
    total: pedidosPorColuna.get(c.key).length,
    pedidos: pedidosPorColuna.get(c.key),
  }));

  // Resumo do topo reflete só o que está sendo exibido (situações permitidas).
  const totalPedidos = colunasFinal.reduce((acc, c) => acc + c.total, 0);
  const pedidosHoje = colunasFinal.reduce(
    (acc, c) => acc + c.pedidos.filter((p) => isHoje(p.data)).length,
    0
  );
  const statusAtivos = colunasFinal.filter((c) => c.total > 0).length;

  if (idsSituacaoDesconhecidos) {
    situacoesService.getSituacoesVendas({ forceRefresh: true }).catch(() => {});
  }

  return {
    atualizadoEm: new Date().toISOString(),
    periodo: { tipo: periodo, dataInicial: dataInicial || null, dataFinal: dataFinal || null },
    resumo: {
      totalPedidos,
      pedidosHoje,
      statusAtivos,
    },
    colunas: colunasFinal,
  };
}

module.exports = { getPainelData };
