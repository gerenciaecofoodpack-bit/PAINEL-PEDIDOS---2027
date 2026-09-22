(function () {
  'use strict';

  const el = {
    connectScreen: document.getElementById('connect-screen'),
    app: document.getElementById('app'),
    lastUpdate: document.getElementById('last-update'),
    refreshBtn: document.getElementById('refresh-btn'),
    tvModeBtn: document.getElementById('tv-mode-btn'),
    errorBanner: document.getElementById('error-banner'),
    errorMessage: document.getElementById('error-message'),
    errorLastValid: document.getElementById('error-last-valid'),
    retryBtn: document.getElementById('retry-btn'),
    summaryTotal: document.getElementById('summary-total'),
    summaryHoje: document.getElementById('summary-hoje'),
    summaryStatusAtivos: document.getElementById('summary-status-ativos'),
    summaryStatusTotal: document.getElementById('summary-status-total'),
    searchInput: document.getElementById('search-input'),
    periodSelect: document.getElementById('period-select'),
    customPeriodGroup: document.getElementById('custom-period-group'),
    dateFrom: document.getElementById('date-from'),
    dateTo: document.getElementById('date-to'),
    applyCustomPeriod: document.getElementById('apply-custom-period'),
    columnsGrid: document.getElementById('columns-grid'),
    columnTemplate: document.getElementById('column-template'),
    orderTemplate: document.getElementById('order-template'),
  };

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
  };

  const currencyFormatter = new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });

  function formatCurrency(value) {
    if (typeof value !== 'number') return '-';
    return currencyFormatter.format(value);
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
    el.summaryStatusTotal.textContent = painel.resumo.totalStatus;
  }

  function orderMatchesSearch(pedido, search) {
    if (!search) return true;
    const term = search.toLowerCase();
    const numero = String(pedido.numero || '').toLowerCase();
    const cliente = (pedido.cliente || '').toLowerCase();
    return numero.includes(term) || cliente.includes(term);
  }

  function renderColumns(painel) {
    const search = state.search.trim();
    el.columnsGrid.innerHTML = '';

    for (const coluna of painel.colunas) {
      const node = el.columnTemplate.content.cloneNode(true);
      const columnEl = node.querySelector('.status-column');
      const nameEl = node.querySelector('.status-name');
      const countEl = node.querySelector('.status-count');
      const ordersEl = node.querySelector('.status-orders');
      const emptyMsgEl = node.querySelector('.status-empty-msg');

      nameEl.textContent = coluna.label;
      countEl.textContent = coluna.total;
      if (coluna.cor) {
        columnEl.style.setProperty('--status-color', coluna.cor);
      }
      if (coluna.naoMapeada) {
        columnEl.style.setProperty('--status-color', '#c0392b');
      }

      let visibleCount = 0;
      for (const pedido of coluna.pedidos) {
        const matches = orderMatchesSearch(pedido, search);
        if (!matches) continue;
        visibleCount += 1;

        const orderNode = el.orderTemplate.content.cloneNode(true);
        orderNode.querySelector('.order-numero').textContent = `#${pedido.numero}`;
        orderNode.querySelector('.order-valor').textContent = formatCurrency(pedido.total);
        orderNode.querySelector('.order-cliente').textContent = pedido.cliente || '(sem cliente)';
        orderNode.querySelector('.order-data').textContent = formatDateBR(pedido.data);
        ordersEl.appendChild(orderNode);
      }

      if (visibleCount === 0) {
        emptyMsgEl.classList.remove('hidden');
        emptyMsgEl.textContent = search
          ? 'Nenhum pedido encontrado para esta pesquisa.'
          : 'Nenhum pedido nesta situação.';
      }

      el.columnsGrid.appendChild(node);
    }
  }

  function render(painel) {
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
      el.refreshBtn.setAttribute('disabled', 'true');
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

    // Abrir o painel com ?tv=1 na URL já entra em Modo TV (sem tela cheia automática,
    // pois navegadores exigem um clique do usuário para isso — mas some com os filtros
    // e deixa pronto para quem for configurar a TV apertar o botão de tela cheia).
    const params = new URLSearchParams(window.location.search);
    if (params.get('tv') === '1') {
      setTvMode(true);
    }

    await loadPedidos();
    startPolling();
  }

  init();
})();
