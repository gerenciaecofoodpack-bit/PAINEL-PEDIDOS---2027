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

// A listagem de pedidos só traz a DATA do pedido (sem horário), então "mais de 24
// horas" é aproximado a partir da meia-noite do dia do pedido — é a maior precisão
// possível com o que a API devolve, mas é uma aproximação (um pedido feito às 23h pode
// contar quase 1 dia a mais do que de fato passou).
function horasDesdePedido(dataStr) {
  if (!dataStr) return null;
  const dataPedido = new Date(`${dataStr.slice(0, 10)}T00:00:00`);
  if (Number.isNaN(dataPedido.getTime())) return null;
  return (Date.now() - dataPedido.getTime()) / (1000 * 60 * 60);
}

// Colunas que representam "pendência de item" no painel (ver a lista de situações
// permitidas em situacoesService.js) — soma as duas variantes (Fábrica e Bonsucesso).
const KEYS_PENDENCIA_ITEM = ['Pendente ítem - Fábrica', 'Pendente item - Bonsucesso'];

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

  // Alertas: pedidos "Em aberto" há mais de 24h, e soma das colunas de "pendência de
  // item" — só entram no cálculo os pedidos realmente exibidos no período selecionado.
  const colunaEmAberto = colunasFinal.find((c) => c.key === 'Em aberto');
  const pedidosAbertoVencidos = colunaEmAberto
    ? colunaEmAberto.pedidos.filter((p) => {
        const horas = horasDesdePedido(p.data);
        return horas !== null && horas >= 24;
      }).length
    : 0;

  const pedidosPendenciaItem = colunasFinal
    .filter((c) => KEYS_PENDENCIA_ITEM.includes(c.key))
    .reduce((acc, c) => acc + c.total, 0);

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
      pedidosAbertoVencidos,
      pedidosPendenciaItem,
    },
    colunas: colunasFinal,
  };
}

// ---------------------------------------------------------------------------
// Detalhe completo de 1 pedido (usado no modal de pré-visualização do painel).
// Sempre busca direto na API na hora do clique (não usa o cache de itens acima, que só
// guarda descrição/quantidade) — assim o modal reflete o pedido mais atualizado.
// ---------------------------------------------------------------------------

function pickNumber(value) {
  if (typeof value === 'number' && !Number.isNaN(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) return Number(value);
  return null;
}

function formatItemDetalhe(it) {
  return {
    descricao: it.descricao || it.descricaoDetalhada || '(sem descrição)',
    codigo: it.codigo || null,
    unidade: it.unidade || null,
    quantidade: pickNumber(it.quantidade),
    valor: pickNumber(it.valor),
    desconto: pickNumber(it.desconto),
    produtoId: it.produto ? it.produto.id : null,
    // Preenchido logo abaixo, em getPedidoDetalhe, com uma chamada separada à API de
    // estoque — null aqui significa "ainda não buscado" ou "não foi possível obter".
    estoqueAtual: null,
  };
}

// Busca o saldo físico atual (estoque real, não o "virtual" que desconta reservas) de
// cada produto dos itens do pedido, numa única chamada em lote à API de estoque do
// Bling. Só é chamada aqui — na hora que a pessoa abre o modal de um pedido — nunca na
// listagem do quadro, que já teria centenas de pedidos × itens a cada atualização
// automática de 30s.
async function preencherEstoqueDosItens(itens) {
  const idsProdutos = [...new Set(itens.map((it) => it.produtoId).filter((id) => id != null))];
  if (idsProdutos.length === 0) return;

  try {
    const resp = await bling.apiGet('/estoques/saldos', { 'idsProdutos[]': idsProdutos });
    const saldoPorProduto = new Map(
      (resp.data || []).map((s) => [s.produto ? s.produto.id : null, pickNumber(s.saldoFisicoTotal)])
    );
    for (const item of itens) {
      if (item.produtoId != null && saldoPorProduto.has(item.produtoId)) {
        item.estoqueAtual = saldoPorProduto.get(item.produtoId);
      }
    }
  } catch (err) {
    // Não derruba o modal inteiro por causa do estoque (ex.: escopo "Estoque" não
    // habilitado no app do Bling) — os itens só ficam sem essa informação.
    // eslint-disable-next-line no-console
    console.warn(`[preencherEstoqueDosItens] Falha ao buscar saldo de estoque: ${err.message}`);
  }
}

// A API do Bling pode ou não preencher alguns destes campos dependendo do pedido/conta
// (frete, transportadora, observações etc.) — cada um é lido de forma defensiva, e o
// front-end só exibe a seção correspondente quando o valor realmente existe.
async function getPedidoDetalhe(idPedidoVenda) {
  const resp = await bling.apiGet(`/pedidos/vendas/${idPedidoVenda}`);
  const p = resp.data || {};

  const itens = Array.isArray(p.itens) ? p.itens.map(formatItemDetalhe) : [];
  await preencherEstoqueDosItens(itens);
  const transporte = p.transporte || {};
  const etiqueta = transporte.etiqueta || transporte.enderecoEntrega || {};
  const enderecoEntrega = [etiqueta.endereco, etiqueta.numero, etiqueta.complemento, etiqueta.bairro]
    .filter(Boolean)
    .join(', ');
  const cidadeEntrega = [etiqueta.municipio, etiqueta.uf].filter(Boolean).join(' - ');

  return {
    id: p.id,
    numero: p.numero,
    numeroLoja: p.numeroLoja || null,
    data: p.data || null,
    dataPrevista: p.dataPrevista && p.dataPrevista !== '0000-00-00' ? p.dataPrevista : null,
    situacao: p.situacao ? { id: p.situacao.id, nome: p.situacao.valor || null } : null,
    cliente: {
      nome: p.contato ? p.contato.nome : null,
      documento: p.contato ? p.contato.numeroDocumento : null,
      telefone: p.contato ? p.contato.telefone || p.contato.celular : null,
      email: p.contato ? p.contato.email : null,
    },
    itens,
    totalProdutos: pickNumber(p.totalProdutos),
    total: pickNumber(p.total),
    desconto: p.desconto ? pickNumber(p.desconto.valor) : null,
    frete: pickNumber(transporte.frete),
    transportadora:
      transporte.transportadora && transporte.transportadora.nome ? transporte.transportadora.nome : null,
    enderecoEntrega: enderecoEntrega || null,
    cidadeEntrega: cidadeEntrega || null,
    observacoes: p.observacoes || null,
    numeroPedidoCompra: p.numeroPedidoCompra || null,
  };
}

module.exports = { getPainelData, getPedidoDetalhe };
