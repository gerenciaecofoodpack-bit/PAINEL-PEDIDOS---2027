// Busca os pedidos de venda no Bling (com paginação completa) e monta o agrupamento
// por situação exibido no painel. Módulo somente-leitura: só faz chamadas GET.

const bling = require('./blingClient');
const situacoesService = require('./situacoesService');

const PAGE_SIZE = 100; // máximo recomendado pela API para reduzir número de requisições
const MAX_PAGES_SAFETY = 500; // rede de segurança (50 mil pedidos) só para evitar loop infinito por bug/API

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

function formatPedidoResumo(pedido) {
  return {
    id: pedido.id,
    numero: pedido.numero,
    numeroLoja: pedido.numeroLoja || null,
    cliente: pedido.contato ? pedido.contato.nome : null,
    data: pedido.data || null,
    dataPrevista: pedido.dataPrevista || null,
    total: typeof pedido.total === 'number' ? pedido.total : null,
    idSituacao: pedido.situacao ? pedido.situacao.id : null,
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
  const pedidosPorColuna = new Map(columns.map((c) => [c.key, []]));
  let idsSituacaoDesconhecidos = false;

  for (const pedidoBruto of pedidosBrutos) {
    const idSituacao = pedidoBruto.situacao ? pedidoBruto.situacao.id : undefined;
    const key = situacaoIdToKey.get(idSituacao);

    if (!key) {
      if (!allSituacaoIds.has(idSituacao)) {
        // Id de situação totalmente desconhecido do cache (pode ter sido criado depois
        // do último fetch) — força atualizar o cache de situações pra próxima consulta,
        // mas não exibimos nada no painel para ele mesmo assim (fora da lista pedida).
        idsSituacaoDesconhecidos = true;
      }
      continue;
    }
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
      totalStatus: colunasFinal.length,
    },
    colunas: colunasFinal,
  };
}

module.exports = { getPainelData };
