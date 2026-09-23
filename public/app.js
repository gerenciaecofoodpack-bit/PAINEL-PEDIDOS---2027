(function () {
  'use strict';

  const el = {
    connectScreen: document.getElementById('connect-screen'),
    app: document.getElementById('app'),
    lastUpdate: document.getElementById('last-update'),
    refreshBtn: document.getElementById('refresh-btn'),
    refreshIcon: document.getElementById('refresh-icon'),
    refreshBtnLabel: document.getElementById('refresh-btn-label'),
    tvModeBtn: document.getElementById('tv-mode-btn'),
    errorBanner: document.getElementById('error-banner'),
    errorMessage: document.getElementById('error-message'),
    errorLastValid: document.getElementById('error-last-valid'),
    retryBtn: document.getElementById('retry-btn'),
    summaryTotal: document.getElementById('summary-total'),
    summaryHoje: document.getElementById('summary-hoje'),
    summaryStatusAtivos: document.getElementById('summary-status-ativos'),
    alertAbertoVencido: document.getElementById('alert-aberto-vencido'),
    summaryAbertoVencido: document.getElementById('summary-aberto-vencido'),
    alertPendenciaItem: document.getElementById('alert-pendencia-item'),
    summaryPendenciaItem: document.getElementById('summary-pendencia-item'),
    searchInput: document.getElementById('search-input'),
    periodSelect: document.getElementById('period-select'),
    customPeriodGroup: document.getElementById('custom-period-group'),
    dateFrom: document.getElementById('date-from'),
    dateTo: document.getElementById('date-to'),
    applyCustomPeriod: document.getElementById('apply-custom-period'),
    columnsGrid: document.getElementById('columns-grid'),
    columnTemplate: document.getElementById('column-template'),
    orderTemplate: document.getElementById('order-template'),
    statusFilterGroup: document.getElementById('status-filter-group'),
    statusFilterBtn: document.getElementById('status-filter-btn'),
    statusFilterCount: document.getElementById('status-filter-count'),
    statusFilterPanel: document.getElementById('status-filter-panel'),
    statusFilterOptions: document.getElementById('status-filter-options'),
    statusFilterAllBtn: document.getElementById('status-filter-all'),
    statusFilterClearBtn: document.getElementById('status-filter-clear'),
    pedidoModal: document.getElementById('pedido-modal'),
    pedidoModalClose: document.getElementById('pedido-modal-close'),
    pedidoModalContent: document.getElementById('pedido-modal-content'),
    resetColumnOrderBtn: document.getElementById('reset-column-order-btn'),
  };

  // Ordem das colunas escolhida pela pessoa (arrastar e soltar) fica salva no navegador
  // — cada dispositivo/TV guarda a própria ordem preferida.
  const COLUMN_ORDER_STORAGE_KEY = 'blingPainelColumnOrder';

  function loadColumnOrder() {
    try {
      const raw = localStorage.getItem(COLUMN_ORDER_STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return Array.isArray(parsed) ? parsed.filter((k) => typeof k === 'string') : [];
    } catch {
      return []; // modo privado, localStorage bloqueado etc. — só não persiste entre sessões
    }
  }

  function saveColumnOrder(order) {
    try {
      localStorage.setItem(COLUMN_ORDER_STORAGE_KEY, JSON.stringify(order));
    } catch {
      // idem acima — a ordem escolhida continua valendo nesta sessão, só não é lembrada
      // na próxima vez que a página carregar.
    }
  }

  const state = {
    // "todos" (todo o histórico) pode ser lento/estourar tempo limite em contas com
    // muitos pedidos, então o padrão é uma janela mais enxuta; o usuário pode trocar
    // para "Todo o período" quando quiser no seletor.
    periodo: '30d',
    de: null,
    ate: null,
    search: '',
    lastPainel: null, // último payload válido recebido do backend
    lastValidAt: null,
    pollIntervalSeconds: 30,
    fetching: false,
    pollTimer: null,
    autoScrollTimer: null,
    lastManualScrollAt: 0,
    columnOrder: loadColumnOrder(),
    allColumnKeys: [],
    // Filtro de status (multi-seleção): conjunto das "key" de coluna que devem aparecer
    // no quadro. É inicializado com todas as situações assim que a primeira resposta do
    // backend chega (equivalente a "sem filtro"/mostrar tudo, igual ao comportamento
    // anterior) e só passa a restringir de fato quando o usuário desmarcar algo.
    statusFilter: new Set(),
    statusFilterKnownKeys: null, // string com as keys conhecidas, pra saber quando reconstruir o painel de opções
  };

  const currencyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

  function formatCurrency(value) {
    if (typeof value !== 'number') return null;
    return currencyFormatter.format(value);
  }

  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/[&<>"']/g, (ch) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
    ));
  }

  function formatDateBR(isoDateStr) {
    if (!isoDateStr) return '-';
    // isoDateStr esperado como YYYY-MM-DD (ou com horário)
    const datePart = isoDateStr.slice(0, 10);
    const [y, m, d] = datePart.split('-');
    if (!y || !m || !d) return isoDateStr;
    return `${d}/${m}/${y}`;
  }

  function formatClock(date) {
    return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  async function fetchJson(url, options) {
    const res = await fetch(url, options);
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) {
      const err = new Error((body && body.mensagem) || `Erro HTTP ${res.status}`);
      err.status = res.status;
      err.code = body && body.erro;
      throw err;
    }
    return body;
  }

  function showConnectScreen() {
    el.connectScreen.classList.remove('hidden');
    el.app.classList.add('hidden');
  }

  function showApp() {
    el.connectScreen.classList.add('hidden');
    el.app.classList.remove('hidden');
  }

  function showError(message) {
    el.errorBanner.classList.remove('hidden');
    el.errorMessage.textContent = message;
    if (state.lastValidAt) {
      el.errorLastValid.textContent = `Última atualização válida: ${formatClock(state.lastValidAt)}`;
    } else {
      el.errorLastValid.textContent = '';
    }
  }

  function clearError() {
    el.errorBanner.classList.add('hidden');
  }

  function renderSummary(painel) {
    el.summaryTotal.textContent = painel.resumo.totalPedidos;
    el.summaryHoje.textContent = painel.resumo.pedidosHoje;
    el.summaryStatusAtivos.textContent = painel.resumo.statusAtivos;

    // Os dois "balões" de alerta só aparecem quando há algo pra avisar — somem sozinhos
    // quando o número zera, igual às colunas vazias do quadro.
    const abertoVencido = painel.resumo.pedidosAbertoVencidos || 0;
    el.summaryAbertoVencido.textContent = abertoVencido;
    el.alertAbertoVencido.classList.toggle('hidden', abertoVencido === 0);

    const pendenciaItem = painel.resumo.pedidosPendenciaItem || 0;
    el.summaryPendenciaItem.textContent = pendenciaItem;
    el.alertPendenciaItem.classList.toggle('hidden', pendenciaItem === 0);
  }

  function orderMatchesSearch(pedido, search) {
    if (!search) return true;
    const term = search.toLowerCase();
    const numero = String(pedido.numero || '').toLowerCase();
    const cliente = (pedido.cliente || '').toLowerCase();
    return numero.includes(term) || cliente.includes(term);
  }

  // Colunas com muitos pedidos (ex.: "Nota fiscal emitida" acumulando centenas) só
  // renderizam esse tanto de cards de cara — o resto vem sob demanda, pra não deixar o
  // navegador pesado com milhares de nós no DOM.
  const RENDER_CAP = 60;

  // quantidadeItens/quantidadeTotal/itensResumo podem vir null quando os itens desse
  // pedido ainda não foram buscados/cacheados no backend (ver MAX_DETAIL_FETCHES_PER_CALL
  // em pedidosService.js) — nesses casos mostramos um placeholder discreto em vez de
  // quebrar o card; o conteúdo completa sozinho numa próxima atualização automática.
  function appendOrderCard(ordersEl, pedido) {
    const orderNode = el.orderTemplate.content.cloneNode(true);

    // O card inteiro é clicável (e navegável por teclado) e abre o modal com o pedido
    // completo — busca sempre os dados mais atuais na hora do clique, em vez de reusar
    // o resumo já exibido no quadro.
    const cardEl = orderNode.querySelector('.order-card');
    cardEl.setAttribute('role', 'button');
    cardEl.setAttribute('tabindex', '0');
    // Testeira colorida (ver styles.css .order-card[data-origem]) identificando de qual
    // sistema o pedido veio: 'bling' (hoje, sempre) ou 'ecalc' (integração futura).
    cardEl.dataset.origem = pedido.origem || 'bling';
    cardEl.addEventListener('click', () => openPedidoModal(pedido.id));
    cardEl.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        openPedidoModal(pedido.id);
      }
    });

    orderNode.querySelector('.order-numero').textContent = `#${pedido.numero}`;

    const itensCountEl = orderNode.querySelector('.order-itens-count');
    if (typeof pedido.quantidadeItens === 'number') {
      const rotuloItens = pedido.quantidadeItens === 1 ? 'item' : 'itens';
      const totalUnidades =
        typeof pedido.quantidadeTotal === 'number' ? ` (${pedido.quantidadeTotal} un.)` : '';
      itensCountEl.textContent = `${pedido.quantidadeItens} ${rotuloItens}${totalUnidades}`;
    } else {
      itensCountEl.textContent = '…';
    }

    orderNode.querySelector('.order-cliente').textContent = pedido.cliente || '(sem cliente)';
    orderNode.querySelector('.order-itens-resumo').textContent = pedido.itensResumo || '';
    orderNode.querySelector('.order-data').textContent = formatDateBR(pedido.data);
    ordersEl.appendChild(orderNode);
  }

  // ---------------------------------------------------------------------
  // Modal de pré-visualização: mostra o pedido completo (itens com valores, cliente,
  // totais, entrega/frete e observações), buscado direto na API na hora do clique.
  // ---------------------------------------------------------------------

  function renderPedidoDetalhe(p) {
    const partes = [];

    partes.push('<div class="modal-header">');
    partes.push(
      `<h2>Pedido #${escapeHtml(p.numero)}${
        p.numeroLoja ? ` <span class="modal-subtle">(loja: ${escapeHtml(p.numeroLoja)})</span>` : ''
      }</h2>`
    );
    if (p.situacao && p.situacao.nome) {
      partes.push(`<span class="modal-badge">${escapeHtml(p.situacao.nome)}</span>`);
    }
    partes.push('</div>');

    partes.push('<div class="modal-section">');
    partes.push(`<div class="modal-row"><span>Cliente</span><strong>${escapeHtml(p.cliente.nome || '-')}</strong></div>`);
    if (p.cliente.documento) {
      partes.push(`<div class="modal-row"><span>Documento</span><strong>${escapeHtml(p.cliente.documento)}</strong></div>`);
    }
    if (p.cliente.telefone) {
      partes.push(`<div class="modal-row"><span>Telefone</span><strong>${escapeHtml(p.cliente.telefone)}</strong></div>`);
    }
    if (p.cliente.email) {
      partes.push(`<div class="modal-row"><span>E-mail</span><strong>${escapeHtml(p.cliente.email)}</strong></div>`);
    }
    partes.push(`<div class="modal-row"><span>Data do pedido</span><strong>${formatDateBR(p.data)}</strong></div>`);
    if (p.dataPrevista) {
      partes.push(`<div class="modal-row"><span>Previsão</span><strong>${formatDateBR(p.dataPrevista)}</strong></div>`);
    }
    if (p.numeroPedidoCompra) {
      partes.push(`<div class="modal-row"><span>Pedido de compra</span><strong>${escapeHtml(p.numeroPedidoCompra)}</strong></div>`);
    }
    partes.push('</div>');

    partes.push('<div class="modal-section"><h3>Itens</h3><div class="modal-itens">');
    if (p.itens.length === 0) {
      partes.push('<div class="modal-subtle">Nenhum item encontrado.</div>');
    }
    for (const item of p.itens) {
      const valorUnit = formatCurrency(item.valor);
      const qtd = item.quantidade != null ? item.quantidade : '-';
      // Destaca o item quando o estoque físico atual está zerado OU negativo (pedido do
      // usuário: "se o estoque estiver zerado ele destaque pra mim o item").
      const estoqueCritico = typeof item.estoqueAtual === 'number' && item.estoqueAtual <= 0;
      const estoqueSpan =
        typeof item.estoqueAtual === 'number'
          ? `<span class="${estoqueCritico ? 'modal-item-estoque-negativo' : ''}">Estoque: ${escapeHtml(
              item.estoqueAtual
            )}</span>`
          : '';
      partes.push(`<div class="modal-item-row${estoqueCritico ? ' modal-item-row-negativo' : ''}">`);
      partes.push(`<div class="modal-item-desc">${escapeHtml(item.descricao)}</div>`);
      partes.push(
        `<div class="modal-item-meta"><span>Qtd: ${escapeHtml(qtd)}${
          item.unidade ? ` ${escapeHtml(item.unidade)}` : ''
        }</span>${valorUnit ? `<span>${valorUnit} un.</span>` : ''}${estoqueSpan}</div>`
      );
      if (estoqueCritico) {
        const msg =
          item.estoqueAtual === 0
            ? 'Estoque atual zerado — confira antes de separar este item.'
            : 'Estoque atual negativo — confira antes de separar este item.';
        partes.push(`<div class="modal-item-alert">&#9888;&#65039; ${msg}</div>`);
      }
      partes.push('</div>');
    }
    partes.push('</div></div>');

    const totalRows = [];
    if (p.totalProdutos != null) {
      totalRows.push(`<div class="modal-row"><span>Total dos produtos</span><strong>${formatCurrency(p.totalProdutos)}</strong></div>`);
    }
    if (p.frete != null) {
      totalRows.push(`<div class="modal-row"><span>Frete</span><strong>${formatCurrency(p.frete)}</strong></div>`);
    }
    if (p.desconto != null && p.desconto > 0) {
      totalRows.push(`<div class="modal-row"><span>Desconto</span><strong>${formatCurrency(p.desconto)}</strong></div>`);
    }
    if (p.total != null) {
      totalRows.push(`<div class="modal-row modal-row-total"><span>Total do pedido</span><strong>${formatCurrency(p.total)}</strong></div>`);
    }
    if (totalRows.length > 0) {
      partes.push(`<div class="modal-section">${totalRows.join('')}</div>`);
    }

    if (p.transportadora || p.enderecoEntrega) {
      partes.push('<div class="modal-section"><h3>Entrega</h3>');
      if (p.transportadora) {
        partes.push(`<div class="modal-row"><span>Transportadora</span><strong>${escapeHtml(p.transportadora)}</strong></div>`);
      }
      if (p.enderecoEntrega) {
        partes.push(`<div class="modal-row"><span>Endereço</span><strong>${escapeHtml(p.enderecoEntrega)}</strong></div>`);
      }
      if (p.cidadeEntrega) {
        partes.push(`<div class="modal-row"><span>Cidade</span><strong>${escapeHtml(p.cidadeEntrega)}</strong></div>`);
      }
      partes.push('</div>');
    }

    if (p.observacoes) {
      partes.push(`<div class="modal-section"><h3>Observações</h3><p class="modal-obs">${escapeHtml(p.observacoes)}</p></div>`);
    }

    return partes.join('');
  }

  async function openPedidoModal(id) {
    el.pedidoModal.classList.remove('hidden');
    el.pedidoModalContent.innerHTML = '<div class="modal-loading">Carregando pedido...</div>';
    stopAutoScroll();
    try {
      const detalhe = await fetchJson(`/api/pedidos/${id}`);
      // Se a pessoa já fechou o modal antes da resposta chegar, não sobrescreve nada.
      if (el.pedidoModal.classList.contains('hidden')) return;
      el.pedidoModalContent.innerHTML = renderPedidoDetalhe(detalhe);
    } catch (err) {
      if (el.pedidoModal.classList.contains('hidden')) return;
      el.pedidoModalContent.innerHTML = `<div class="modal-error">Não foi possível carregar este pedido: ${escapeHtml(
        err.message || 'erro desconhecido'
      )}</div>`;
    }
  }

  function closePedidoModal() {
    if (el.pedidoModal.classList.contains('hidden')) return;
    el.pedidoModal.classList.add('hidden');
    el.pedidoModalContent.innerHTML = '';
    startAutoScroll();
  }

  // ---------------------------------------------------------------------
  // Arrastar e soltar para reordenar as colunas do quadro (ver a alça ☰ no cabeçalho de
  // cada coluna). A ordem escolhida é salva no navegador (COLUMN_ORDER_STORAGE_KEY).
  //
  // Usa Pointer Events (mouse + toque) em vez da API nativa de Drag and Drop do HTML:
  // dentro de um quadro que já rola horizontalmente (.columns-grid), o navegador tende a
  // interpretar o gesto de arrastar como rolagem em vez de iniciar o "drag" nativo — daí
  // não funcionar de forma confiável. Controlando tudo manualmente aqui, não tem essa
  // disputa entre rolar e arrastar.
  // ---------------------------------------------------------------------

  let draggingColumnEl = null;
  let draggingPointerId = null;

  // Entre as colunas visíveis no momento, acha depois de qual delas o ponteiro está —
  // técnica padrão de reordenação por arrastar-e-soltar (compara o centro de cada coluna
  // com a posição horizontal do cursor/dedo).
  function getColumnAfterPoint(x) {
    const columns = [...el.columnsGrid.querySelectorAll('.status-column:not(.dragging)')];
    let closest = { offset: -Infinity, element: null };
    for (const child of columns) {
      const box = child.getBoundingClientRect();
      const offset = x - box.left - box.width / 2;
      if (offset < 0 && offset > closest.offset) {
        closest = { offset, element: child };
      }
    }
    return closest.element;
  }

  function onDragHandlePointerMove(evt) {
    if (!draggingColumnEl || evt.pointerId !== draggingPointerId) return;
    const afterEl = getColumnAfterPoint(evt.clientX);
    if (afterEl == null) {
      el.columnsGrid.appendChild(draggingColumnEl);
    } else if (afterEl !== draggingColumnEl) {
      el.columnsGrid.insertBefore(draggingColumnEl, afterEl);
    }
  }

  function onDragHandlePointerUp(evt) {
    if (!draggingColumnEl || evt.pointerId !== draggingPointerId) return;
    draggingColumnEl.classList.remove('dragging');
    document.body.classList.remove('dragging-column');
    persistDomColumnOrder();
    draggingColumnEl = null;
    draggingPointerId = null;
    document.removeEventListener('pointermove', onDragHandlePointerMove);
    document.removeEventListener('pointerup', onDragHandlePointerUp);
    document.removeEventListener('pointercancel', onDragHandlePointerUp);
    startAutoScroll();
  }

  function onDragHandlePointerDown(evt) {
    if (evt.button !== undefined && evt.button !== 0) return; // só o botão principal do mouse
    const columnEl = evt.currentTarget.closest('.status-column');
    if (!columnEl) return;
    evt.preventDefault(); // evita rolar o quadro ou selecionar texto enquanto arrasta
    draggingColumnEl = columnEl;
    draggingPointerId = evt.pointerId;
    columnEl.classList.add('dragging');
    document.body.classList.add('dragging-column'); // desliga seleção de texto na página toda
    stopAutoScroll();
    document.addEventListener('pointermove', onDragHandlePointerMove);
    document.addEventListener('pointerup', onDragHandlePointerUp);
    document.addEventListener('pointercancel', onDragHandlePointerUp);
  }

  // Salva a nova ordem completa (state.columnOrder guarda TODAS as situações, não só as
  // visíveis no momento) — mistura a nova ordem visual das colunas que estavam na tela
  // com a posição relativa das que estavam escondidas (filtro de status/pesquisa ativos),
  // pra não perder a organização delas quando reaparecerem.
  function persistDomColumnOrder() {
    const visibleKeysNewOrder = [...el.columnsGrid.querySelectorAll('.status-column')].map(
      (c) => c.dataset.key
    );
    const visibleSet = new Set(visibleKeysNewOrder);
    const baseOrder =
      state.columnOrder && state.columnOrder.length > 0 ? state.columnOrder : state.allColumnKeys;

    const fila = [...visibleKeysNewOrder];
    const novaOrdem = [];
    const jaColocadas = new Set();

    for (const key of baseOrder) {
      if (visibleSet.has(key)) {
        if (fila.length > 0) {
          const proxima = fila.shift();
          novaOrdem.push(proxima);
          jaColocadas.add(proxima);
        }
      } else {
        novaOrdem.push(key);
        jaColocadas.add(key);
      }
    }
    // Situações que por algum motivo não estavam na ordem base (ex.: primeiro uso)
    // entram no fim, preservando a ordem em que o backend as enviou.
    for (const key of state.allColumnKeys) {
      if (!jaColocadas.has(key)) novaOrdem.push(key);
    }

    state.columnOrder = novaOrdem;
    saveColumnOrder(novaOrdem);
  }

  // Aplica a ordem que a pessoa escolheu arrastando as colunas (se houver). Situações
  // que ainda não foram reordenadas manualmente entram no final, na ordem padrão vinda
  // do backend.
  function ordenarColunasConformePreferencia(colunas) {
    if (!state.columnOrder || state.columnOrder.length === 0) return colunas;
    const porKey = new Map(colunas.map((c) => [c.key, c]));
    const ordenado = [];
    for (const key of state.columnOrder) {
      const coluna = porKey.get(key);
      if (coluna) {
        ordenado.push(coluna);
        porKey.delete(key);
      }
    }
    for (const coluna of colunas) {
      if (porKey.has(coluna.key)) ordenado.push(coluna);
    }
    return ordenado;
  }

  // Paleta de cores do TOPO de cada coluna (linha fina + número da quantidade) — de
  // propósito sem nenhum tom de verde ou vermelho, já que essas duas cores agora
  // significam outra coisa no painel (a testeira dos cards, indicando a ORIGEM do
  // pedido: Bling x eCalc). Cada situação sempre recebe a mesma cor desta lista (é um
  // hash do nome, não sorteio a cada atualização) — assim as cores não ficam trocando
  // de coluna a cada 30s, só variam de uma situação pra outra.
  const PALETA_COR_COLUNA = [
    '#5b8ff9', // azul
    '#6c5ce7', // índigo
    '#a55eea', // violeta
    '#ff6fa5', // rosa
    '#fd9644', // laranja
    '#f7b731', // âmbar
    '#45aaf2', // azul-céu
    '#63cdda', // ciano
    '#778beb', // azul-lavanda
    '#eb5b95', // magenta
  ];

  function corAleatoriaPorColuna(key) {
    let hash = 0;
    const str = String(key || '');
    for (let i = 0; i < str.length; i++) {
      hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % PALETA_COR_COLUNA.length;
    return PALETA_COR_COLUNA[idx];
  }

  function renderColumns(painel) {
    const search = state.search.trim();
    el.columnsGrid.innerHTML = '';

    for (const coluna of ordenarColunasConformePreferencia(painel.colunas)) {
      // Filtro de status: só as situações marcadas no seletor "Status" aparecem.
      if (!state.statusFilter.has(coluna.key)) continue;

      // Colunas sem nenhum pedido (ou sem nenhum pedido que bata com a pesquisa atual)
      // não ocupam espaço no quadro — só as situações com movimento aparecem.
      const visiveis = coluna.pedidos.filter((p) => orderMatchesSearch(p, search));
      if (visiveis.length === 0) continue;

      const node = el.columnTemplate.content.cloneNode(true);
      const columnEl = node.querySelector('.status-column');
      const nameEl = node.querySelector('.status-name');
      const countEl = node.querySelector('.status-count');
      const ordersEl = node.querySelector('.status-orders');

      nameEl.textContent = coluna.label;
      countEl.textContent = coluna.total;
      columnEl.dataset.key = coluna.key;
      // Arrastar e soltar: só a alça (☰) no cabeçalho inicia o arraste (ver
      // onDragHandlePointerDown) — assim rolar a lista de pedidos dentro da coluna
      // continua funcionando normalmente.
      const dragHandle = node.querySelector('.status-drag-handle');
      dragHandle.addEventListener('pointerdown', onDragHandlePointerDown);
      columnEl.style.setProperty('--status-color', corAleatoriaPorColuna(coluna.key));

      const primeiros = visiveis.slice(0, RENDER_CAP);
      const resto = visiveis.slice(RENDER_CAP);
      for (const pedido of primeiros) {
        appendOrderCard(ordersEl, pedido);
      }
      if (resto.length > 0) {
        const showMoreBtn = document.createElement('button');
        showMoreBtn.type = 'button';
        showMoreBtn.className = 'show-more-btn';
        showMoreBtn.textContent = `Mostrar mais ${resto.length} pedido${resto.length === 1 ? '' : 's'}`;
        showMoreBtn.addEventListener('click', () => {
          for (const pedido of resto) {
            appendOrderCard(ordersEl, pedido);
          }
          showMoreBtn.remove();
        });
        ordersEl.appendChild(showMoreBtn);
      }

      el.columnsGrid.appendChild(node);
    }

    if (el.columnsGrid.children.length === 0) {
      const msg = document.createElement('div');
      msg.className = 'no-columns-msg';
      if (state.statusFilter.size === 0) {
        msg.textContent = 'Nenhum status selecionado no filtro. Use o botão "Status" para escolher quais mostrar.';
      } else if (search) {
        msg.textContent = 'Nenhum pedido encontrado para esta pesquisa.';
      } else {
        msg.textContent = 'Nenhum pedido nas situações selecionadas neste período.';
      }
      el.columnsGrid.appendChild(msg);
    }
  }

  // ---------------------------------------------------------------------
  // Navegação dos "balões" de alerta: leva até a coluna do pedido em questão. Se a
  // pesquisa ou o filtro de status estiverem escondendo aquela coluna no momento, ajusta
  // os dois primeiro (limpa a pesquisa, marca a situação no filtro) pra garantir que a
  // coluna realmente apareça antes de rolar até ela.
  // ---------------------------------------------------------------------

  function ensureColunaVisivel(keys) {
    let mudou = false;

    if (state.search) {
      state.search = '';
      el.searchInput.value = '';
      mudou = true;
    }

    for (const key of keys) {
      if (!state.statusFilter.has(key)) {
        state.statusFilter.add(key);
        mudou = true;
        const checkbox = el.statusFilterOptions.querySelector(
          `input[type="checkbox"][value="${key}"]`
        );
        if (checkbox) checkbox.checked = true;
        updateStatusFilterCount(el.statusFilterOptions.querySelectorAll('input[type="checkbox"]').length);
      }
    }

    if (mudou && state.lastPainel) {
      renderColumns(state.lastPainel);
    }
  }

  // Quando o alerta representa mais de uma coluna (ex.: "Pendência de item" = Fábrica +
  // Bonsucesso), TODAS as colunas encontradas piscam juntas — não só a primeira. A
  // rolagem em si leva até a primeira delas, que é o suficiente pra pessoa se orientar.
  function irParaColuna(keys) {
    ensureColunaVisivel(keys);

    const encontradas = keys
      .map((key) => el.columnsGrid.querySelector(`.status-column[data-key="${key}"]`))
      .filter(Boolean);

    if (encontradas.length === 0) return;

    state.lastManualScrollAt = Date.now(); // não briga com a rolagem automática logo em seguida
    encontradas[0].scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

    for (const columnEl of encontradas) {
      columnEl.classList.add('status-column-highlight');
      setTimeout(() => columnEl.classList.remove('status-column-highlight'), 2200);
    }
  }

  // ---------------------------------------------------------------------
  // Filtro de status (multi-seleção)
  // ---------------------------------------------------------------------

  function updateStatusFilterCount(totalKnown) {
    const selected = state.statusFilter.size;
    if (selected === totalKnown) {
      el.statusFilterCount.classList.add('hidden');
    } else {
      el.statusFilterCount.textContent = `${selected}/${totalKnown}`;
      el.statusFilterCount.classList.remove('hidden');
    }
  }

  function onStatusFilterOptionChange() {
    const checkboxes = el.statusFilterOptions.querySelectorAll('input[type="checkbox"]');
    const novoFiltro = new Set();
    checkboxes.forEach((cb) => {
      if (cb.checked) novoFiltro.add(cb.value);
    });
    state.statusFilter = novoFiltro;
    updateStatusFilterCount(checkboxes.length);
    if (state.lastPainel) {
      renderColumns(state.lastPainel);
    }
  }

  // Constrói (ou reconstrói, se a lista de situações mudou) a lista de checkboxes do
  // filtro a partir das colunas retornadas pelo backend — já vêm só com as situações
  // permitidas (ver situacoesService.js), na ordem fixa configurada.
  function buildStatusFilterOptions(painel) {
    const colunas = painel.colunas || [];
    // Sempre atualizado (independente do "return" abaixo), pra reordenação por
    // arrastar-e-soltar sempre saber o conjunto completo de situações existentes.
    state.allColumnKeys = colunas.map((c) => c.key);

    const keysAtuais = state.allColumnKeys.join('|');
    if (keysAtuais === state.statusFilterKnownKeys) return;

    const eraPrimeiraVez = state.statusFilterKnownKeys === null;
    state.statusFilterKnownKeys = keysAtuais;

    // Na primeira carga, começa com tudo selecionado (mesmo comportamento de antes do
    // filtro existir). Em reconstruções seguintes (ex.: uma nova situação apareceu na
    // conta Bling), preserva o que o usuário já tinha escolhido e soma a novidade.
    const selecaoAnterior = state.statusFilter;
    const novaSelecao = new Set();

    el.statusFilterOptions.innerHTML = '';

    if (colunas.length === 0) {
      const hint = document.createElement('div');
      hint.className = 'status-filter-empty-hint';
      hint.textContent = 'Nenhuma situação disponível ainda.';
      el.statusFilterOptions.appendChild(hint);
    }

    for (const coluna of colunas) {
      const marcado = eraPrimeiraVez || selecaoAnterior.has(coluna.key);
      if (marcado) novaSelecao.add(coluna.key);

      const label = document.createElement('label');
      label.className = 'status-filter-option';

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.value = coluna.key;
      checkbox.checked = marcado;

      const dot = document.createElement('span');
      dot.className = 'status-filter-dot';
      dot.style.setProperty('--status-color', corAleatoriaPorColuna(coluna.key));

      const span = document.createElement('span');
      span.className = 'status-filter-label';
      span.textContent = coluna.label;

      label.appendChild(checkbox);
      label.appendChild(dot);
      label.appendChild(span);
      el.statusFilterOptions.appendChild(label);
    }

    state.statusFilter = novaSelecao;
    updateStatusFilterCount(colunas.length);
  }

  function openStatusFilterPanel() {
    el.statusFilterPanel.classList.remove('hidden');
    // Alinha pela esquerda por padrão; se isso for estourar a borda direita da tela
    // (telas estreitas, ou o botão "Status" ficando perto da direita), alinha pela
    // direita em vez disso, pra nunca cortar o painel.
    el.statusFilterPanel.classList.remove('align-right');
    const rect = el.statusFilterPanel.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      el.statusFilterPanel.classList.add('align-right');
    }
    el.statusFilterBtn.setAttribute('aria-expanded', 'true');
  }

  function closeStatusFilterPanel() {
    el.statusFilterPanel.classList.add('hidden');
    el.statusFilterBtn.setAttribute('aria-expanded', 'false');
  }

  function onStatusFilterBtnClick(evt) {
    evt.stopPropagation();
    if (el.statusFilterPanel.classList.contains('hidden')) {
      openStatusFilterPanel();
    } else {
      closeStatusFilterPanel();
    }
  }

  function onDocumentClickCloseStatusFilter(evt) {
    if (!el.statusFilterGroup.contains(evt.target)) {
      closeStatusFilterPanel();
    }
  }

  function setAllCheckboxes(checked) {
    const checkboxes = el.statusFilterOptions.querySelectorAll('input[type="checkbox"]');
    checkboxes.forEach((cb) => {
      cb.checked = checked;
    });
    onStatusFilterOptionChange();
  }

  function render(painel) {
    buildStatusFilterOptions(painel);
    renderSummary(painel);
    renderColumns(painel);
    const updatedAt = new Date(painel.atualizadoEm);
    el.lastUpdate.textContent = `Última atualização: ${formatClock(updatedAt)}`;
  }

  function buildQuery() {
    const params = new URLSearchParams();
    params.set('periodo', state.periodo);
    if (state.periodo === 'custom' && state.de && state.ate) {
      params.set('de', state.de);
      params.set('ate', state.ate);
    }
    return params.toString();
  }

  async function loadPedidos({ manual = false } = {}) {
    if (state.fetching) return;
    state.fetching = true;
    if (manual) {
      // Uma atualização com muitos pedidos pode levar 20-30s (paginação + busca de
      // itens) — sem esse retorno visual, o botão só fica meio apagado por um bom
      // tempo e parece que não fez nada.
      el.refreshBtn.setAttribute('disabled', 'true');
      el.refreshIcon.classList.add('spinning');
      el.refreshBtnLabel.textContent = 'Atualizando...';
    }
    try {
      const painel = await fetchJson(`/api/pedidos?${buildQuery()}`);
      state.lastPainel = painel;
      state.lastValidAt = new Date();
      clearError();
      render(painel);
    } catch (err) {
      if (err.code === 'NAO_CONECTADO' || err.code === 'REAUTENTICACAO_NECESSARIA') {
        showConnectScreen();
        stopPolling();
        return;
      }
      showError(err.message || 'Não foi possível atualizar os pedidos.');
      // Mantém os dados anteriores na tela (não apaga nada).
    } finally {
      state.fetching = false;
      if (manual) {
        el.refreshBtn.removeAttribute('disabled');
        el.refreshIcon.classList.remove('spinning');
        el.refreshBtnLabel.textContent = 'Atualizar agora';
      }
    }
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function startPolling() {
    stopPolling();
    state.pollTimer = setInterval(() => loadPedidos(), state.pollIntervalSeconds * 1000);
  }

  function onPeriodChange() {
    const value = el.periodSelect.value;
    state.periodo = value;
    el.customPeriodGroup.classList.toggle('hidden', value !== 'custom');
    if (value !== 'custom') {
      loadPedidos();
    }
  }

  function onApplyCustomPeriod() {
    if (!el.dateFrom.value || !el.dateTo.value) return;
    state.de = el.dateFrom.value;
    state.ate = el.dateTo.value;
    loadPedidos();
  }

  function onSearchInput() {
    state.search = el.searchInput.value;
    if (state.lastPainel) {
      renderColumns(state.lastPainel);
    }
  }

  // ---------------------------------------------------------------------
  // Modo TV: oculta filtros/pesquisa e pede tela cheia. Pensado para deixar
  // o painel num monitor/TV na área de produção, sem interação de ninguém.
  // Pressionar Esc (que sai da tela cheia) também desliga o Modo TV.
  // ---------------------------------------------------------------------

  function setTvMode(on) {
    document.body.classList.toggle('tv-mode', on);
    el.tvModeBtn.innerHTML = on
      ? '<span class="tv-icon">&#10006;</span> Sair do Modo TV'
      : '<span class="tv-icon">&#128250;</span> Modo TV';
  }

  // Com até 26 colunas lado a lado, o quadro costuma ficar mais largo que a tela — a
  // rolagem automática fica ligada sempre (não só no Modo TV), pra dar tempo de ver
  // todas as situações mesmo sem ninguém arrastando a tela manualmente.
  const AUTO_SCROLL_STEP_PX = 340; // ~1 coluna por vez
  const AUTO_SCROLL_INTERVAL_MS = 6000;

  // Se alguém estiver de fato na frente da tela mexendo no quadro (mouse/touch), a
  // rolagem automática dá uma pausa por alguns segundos em vez de brigar com a pessoa.
  const MANUAL_SCROLL_PAUSE_MS = 8000;

  function startAutoScroll() {
    stopAutoScroll();
    state.autoScrollTimer = setInterval(() => {
      if (Date.now() - state.lastManualScrollAt < MANUAL_SCROLL_PAUSE_MS) return;
      const grid = el.columnsGrid;
      if (grid.scrollWidth <= grid.clientWidth + 4) return; // tudo já cabe na tela
      const atEnd = grid.scrollLeft + grid.clientWidth >= grid.scrollWidth - 4;
      if (atEnd) {
        grid.scrollTo({ left: 0, behavior: 'smooth' });
      } else {
        grid.scrollBy({ left: AUTO_SCROLL_STEP_PX, behavior: 'smooth' });
      }
    }, AUTO_SCROLL_INTERVAL_MS);
  }

  function stopAutoScroll() {
    if (state.autoScrollTimer) {
      clearInterval(state.autoScrollTimer);
      state.autoScrollTimer = null;
    }
  }

  async function enterTvMode() {
    setTvMode(true);
    const rootEl = document.documentElement;
    try {
      if (rootEl.requestFullscreen) {
        await rootEl.requestFullscreen();
      } else if (rootEl.webkitRequestFullscreen) {
        await rootEl.webkitRequestFullscreen();
      }
    } catch {
      // Se a tela cheia falhar/for negada, o Modo TV (sem filtros) continua ativo.
    }
  }

  function exitTvMode() {
    setTvMode(false);
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function onTvModeBtnClick() {
    if (document.body.classList.contains('tv-mode')) {
      exitTvMode();
    } else {
      enterTvMode();
    }
  }

  function onFullscreenChange() {
    if (!document.fullscreenElement && document.body.classList.contains('tv-mode')) {
      setTvMode(false);
    }
  }

  async function init() {
    let status;
    try {
      status = await fetchJson('/api/status');
    } catch {
      status = { conectado: false, pollIntervalSeconds: 30 };
    }

    state.pollIntervalSeconds = status.pollIntervalSeconds || 30;

    if (!status.conectado) {
      showConnectScreen();
      return;
    }

    showApp();

    el.refreshBtn.addEventListener('click', () => loadPedidos({ manual: true }));
    el.retryBtn.addEventListener('click', () => loadPedidos({ manual: true }));
    el.periodSelect.addEventListener('change', onPeriodChange);
    el.applyCustomPeriod.addEventListener('click', onApplyCustomPeriod);
    el.searchInput.addEventListener('input', onSearchInput);
    el.tvModeBtn.addEventListener('click', onTvModeBtnClick);
    document.addEventListener('fullscreenchange', onFullscreenChange);

    // Alertas do topo: clicar leva até a(s) coluna(s) correspondente(s) no quadro.
    const KEYS_EM_ABERTO = ['Em aberto'];
    const KEYS_PENDENCIA_ITEM = ['Pendente ítem - Fábrica', 'Pendente item - Bonsucesso'];
    const onAlertAbertoActivate = () => irParaColuna(KEYS_EM_ABERTO);
    const onAlertPendenciaActivate = () => irParaColuna(KEYS_PENDENCIA_ITEM);
    el.alertAbertoVencido.addEventListener('click', onAlertAbertoActivate);
    el.alertAbertoVencido.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        onAlertAbertoActivate();
      }
    });
    el.alertPendenciaItem.addEventListener('click', onAlertPendenciaActivate);
    el.alertPendenciaItem.addEventListener('keydown', (evt) => {
      if (evt.key === 'Enter' || evt.key === ' ') {
        evt.preventDefault();
        onAlertPendenciaActivate();
      }
    });

    el.resetColumnOrderBtn.addEventListener('click', () => {
      state.columnOrder = [];
      saveColumnOrder([]);
      if (state.lastPainel) renderColumns(state.lastPainel);
    });

    el.statusFilterBtn.addEventListener('click', onStatusFilterBtnClick);
    el.statusFilterOptions.addEventListener('change', onStatusFilterOptionChange);
    el.statusFilterAllBtn.addEventListener('click', () => setAllCheckboxes(true));
    el.statusFilterClearBtn.addEventListener('click', () => setAllCheckboxes(false));
    document.addEventListener('click', onDocumentClickCloseStatusFilter);

    el.pedidoModalClose.addEventListener('click', closePedidoModal);
    el.pedidoModal.addEventListener('click', (evt) => {
      if (evt.target === el.pedidoModal) closePedidoModal();
    });
    document.addEventListener('keydown', (evt) => {
      if (evt.key === 'Escape') {
        closeStatusFilterPanel();
        closePedidoModal();
      }
    });

    // Pausa a rolagem automática enquanto alguém estiver de fato mexendo no quadro.
    const markManualScroll = () => {
      state.lastManualScrollAt = Date.now();
    };
    el.columnsGrid.addEventListener('wheel', markManualScroll, { passive: true });
    el.columnsGrid.addEventListener('touchstart', markManualScroll, { passive: true });
    el.columnsGrid.addEventListener('pointerdown', markManualScroll);

    // Abrir o painel com ?tv=1 na URL já entra em Modo TV (sem tela cheia automática,
    // pois navegadores exigem um clique do usuário para isso — mas some com os filtros
    // e deixa pronto para quem for configurar a TV apertar o botão de tela cheia).
    const params = new URLSearchParams(window.location.search);
    if (params.get('tv') === '1') {
      setTvMode(true);
    }

    await loadPedidos();
    startPolling();
    startAutoScroll();
  }

  init();
})();
