// ================= BANCO DE DADOS LOCAL (LocalStorage) =================
let items = JSON.parse(localStorage.getItem('estoque_items')) || [];
let reports = JSON.parse(localStorage.getItem('estoque_reports')) || [];
let categories = JSON.parse(localStorage.getItem('estoque_categories')) || ['Medicamentos', 'Materiais', 'Controlados'];
let dailyNotifications = JSON.parse(localStorage.getItem('estoque_daily_notifications')) || [];

// Migração segura para itens antigos terem qtdMinima, qtdEstoque, pacote, hasDivergence e divergenceDetails
items = items.map(it => {
    const legacyTotal = Array.isArray(it.lotes) ? it.lotes.reduce((acc, l) => acc + Number(l.qtd || 0), 0) : 0;
    return {
        ...it,
        qtdMinima: it.qtdMinima !== undefined ? Number(it.qtdMinima) : 0,
        qtdEstoque: it.qtdEstoque !== undefined ? Number(it.qtdEstoque) : legacyTotal,
        pacote: it.pacote !== undefined ? Number(it.pacote) : 1,
        hasDivergence: Boolean(it.hasDivergence),
        divergenceDetails: Array.isArray(it.divergenceDetails) ? it.divergenceDetails : []
    };
});

let currentDetailItemId = null;
let currentReportId = null;
let selectedUpdateReportId = null;

// Controla quais itens estão com o painel "Divergente" expandido na Vitrine
let expandedDivergenceIds = new Set();

// Estados dos filtros
let vitrineCategoryFilter = 'ALL';
let invCategoryFilter = 'ALL';

// Variáveis do Processo de Inventário
let selectedInventoryIds = new Set();
let preInventoryEntries = [];
let inventoryQueue = [];
let currentInvIndex = 0;
let currentInvResults = [];

// Variáveis do Scanner de Código de Barras
let html5QrScanner = null;
let scannerTargetInputId = null;

// ================= CONTROLE DE DATA PARA LIMPEZA DIÁRIA DAS NOTIFICAÇÕES =================
function getTodayDateKey() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function cleanupOldNotifications() {
    const todayKey = getTodayDateKey();
    const beforeCount = dailyNotifications.length;
    dailyNotifications = dailyNotifications.filter(n => n.dateKey === todayKey);

    if (dailyNotifications.length !== beforeCount) {
        localStorage.setItem('estoque_daily_notifications', JSON.stringify(dailyNotifications));
    }
    updateNotificationBadge();
}

function updateNotificationBadge() {
    const badge = document.getElementById('notif-badge-count');
    if (!badge) return;

    const unreadCount = dailyNotifications.filter(n => !n.read).length;
    if (unreadCount > 0) {
        badge.innerText = unreadCount;
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

function openNotificationsModal() {
    cleanupOldNotifications();

    // Marca todas as notificações do dia como lidas ao abrir o sino
    dailyNotifications = dailyNotifications.map(n => ({ ...n, read: true }));
    saveToStorage();
    updateNotificationBadge();

    const container = document.getElementById('notifications-list');
    container.innerHTML = '';

    if (dailyNotifications.length === 0) {
        container.innerHTML = `
            <div style="text-align:center; padding:35px 15px; color:#64748b;">
                <i class="fa-regular fa-bell-slash" style="font-size:2.2rem; margin-bottom:10px; opacity:0.5;"></i>
                <p style="font-weight:600; color:#1e293b;">Nenhuma atualização hoje</p>
                <small>Sempre que você atualizar o estoque por um relatório, os itens modificados aparecerão aqui durante todo o dia.</small>
            </div>
        `;
    } else {
        dailyNotifications.forEach(notif => {
            const card = document.createElement('div');
            card.className = 'notif-card';

            const itemsHtml = notif.items.map(it => {
                const statusTag = it.hasDivergence
                    ? `<small class="text-red"><strong>Divergente</strong></small>`
                    : `<small class="text-green"><strong>Correto</strong></small>`;

                return `
                    <div class="notif-item-row ${it.hasDivergence ? 'notif-item-div' : ''}">
                        <div>
                            <strong>${it.nome}</strong> <span style="color:#64748b; font-size:0.78rem;">(Tasy: ${it.tasy})</span><br>
                            ${statusTag}
                        </div>
                        <div class="notif-qty-badge">
                            ${it.oldTotal} → Total: ${it.newTotal}
                        </div>
                    </div>
                `;
            }).join('');

            card.innerHTML = `
                <div class="notif-card-top">
                    <span class="notif-card-title"><i class="fa-solid fa-arrows-rotate" style="color:#0d9488;"></i> ${notif.reportTitle}</span>
                    <span class="notif-card-time"><i class="fa-regular fa-clock"></i> ${notif.time}</span>
                </div>
                <div class="notif-items-list">
                    ${itemsHtml}
                </div>
            `;
            container.appendChild(card);
        });
    }

    document.getElementById('modal-notifications').classList.remove('hidden');
}

function saveToStorage() {
    localStorage.setItem('estoque_items', JSON.stringify(items));
    localStorage.setItem('estoque_reports', JSON.stringify(reports));
    localStorage.setItem('estoque_categories', JSON.stringify(categories));
    localStorage.setItem('estoque_daily_notifications', JSON.stringify(dailyNotifications));
}

// Inicialização
document.addEventListener('DOMContentLoaded', () => {
    cleanupOldNotifications();
    populateCadCategorySelect();
    renderFilterMenus();
    renderVitrine();
    renderReports();

    // Verifica periodicamente caso a página fique aberta na virada da meia-noite
    setInterval(cleanupOldNotifications, 60000);

    document.addEventListener('click', () => {
        document.querySelectorAll('.filter-dropdown-menu').forEach(menu => menu.classList.add('hidden'));
    });
});

// ================= AUXILIAR: STATUS DE ESTOQUE (VERMELHO / AMARELO / VERDE) =================
function getStockStatusInfo(qtdMin, qtdEst) {
    if (qtdEst < qtdMin) {
        return {
            colorClass: 'status-red',
            dotColor: '#dc2626',
            label: 'Abaixo do mínimo'
        };
    } else if (qtdEst === qtdMin) {
        return {
            colorClass: 'status-yellow',
            dotColor: '#eab308',
            label: 'No limite mínimo'
        };
    } else {
        return {
            colorClass: 'status-green',
            dotColor: '#16a34a',
            label: 'Acima do mínimo'
        };
    }
}

// ================= SOM DE BIPE AO ESCANEAR CÓDIGO =================
function playBeepSound() {
    try {
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();

        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(1050, audioCtx.currentTime);
        gainNode.gain.setValueAtTime(0.25, audioCtx.currentTime);

        oscillator.connect(gainNode);
        gainNode.connect(audioCtx.destination);

        oscillator.start();
        setTimeout(() => {
            oscillator.stop();
            audioCtx.close();
        }, 140);
    } catch (e) {}
}

// ================= SCANNER DE CÓDIGO DE BARRAS (CÂMERA CELULAR/TABLET) =================
function openBarcodeScanner(targetInputId) {
    scannerTargetInputId = targetInputId;
    document.getElementById('modal-scanner').classList.remove('hidden');

    if (typeof Html5Qrcode === 'undefined') {
        alert('Biblioteca do leitor não carregada. Verifique a conexão com a internet ou digite manualmente.');
        closeBarcodeScanner();
        return;
    }

    html5QrScanner = new Html5Qrcode("barcode-reader-box");
    const config = { fps: 12, qrbox: { width: 250, height: 120 } };

    html5QrScanner.start(
        { facingMode: "environment" },
        config,
        (decodedText) => {
            playBeepSound();
            const targetInput = document.getElementById(scannerTargetInputId);
            if (targetInput) {
                targetInput.value = decodedText;
                targetInput.dispatchEvent(new Event('input'));
            }
            closeBarcodeScanner();
        },
        () => {}
    ).catch(() => {
        alert('Não foi possível acessar a câmera. Verifique as permissões do navegador ou digite o código manualmente.');
        closeBarcodeScanner();
    });
}

function closeBarcodeScanner() {
    const modal = document.getElementById('modal-scanner');
    if (html5QrScanner) {
        html5QrScanner.stop().then(() => {
            html5QrScanner.clear();
            html5QrScanner = null;
            modal.classList.add('hidden');
        }).catch(() => {
            html5QrScanner = null;
            modal.classList.add('hidden');
        });
    } else {
        modal.classList.add('hidden');
    }
}

// ================= GERENCIAMENTO DE CATEGORIAS E FILTROS =================
function toggleFilterDropdown(menuId, event) {
    event.stopPropagation();
    const menu = document.getElementById(menuId);
    const isHidden = menu.classList.contains('hidden');

    document.querySelectorAll('.filter-dropdown-menu').forEach(m => m.classList.add('hidden'));
    if (isHidden) {
        renderFilterMenus();
        menu.classList.remove('hidden');
    }
}

function renderFilterMenus() {
    const vitrineContainer = document.getElementById('vitrine-filter-options');
    if (vitrineContainer) {
        vitrineContainer.innerHTML = buildFilterOptionsHtml(vitrineCategoryFilter, 'setVitrineFilter');
    }
    const btnVitrine = document.getElementById('btn-vitrine-filter');
    const dotVitrine = document.getElementById('vitrine-filter-dot');
    if (vitrineCategoryFilter !== 'ALL') {
        btnVitrine.classList.add('active-filter');
        dotVitrine.classList.remove('hidden');
    } else {
        btnVitrine.classList.remove('active-filter');
        dotVitrine.classList.add('hidden');
    }

    const invContainer = document.getElementById('inv-filter-options');
    if (invContainer) {
        invContainer.innerHTML = buildFilterOptionsHtml(invCategoryFilter, 'setInvFilter');
    }
    const btnInv = document.getElementById('btn-inv-filter');
    const dotInv = document.getElementById('inv-filter-dot');
    if (invCategoryFilter !== 'ALL') {
        btnInv.classList.add('active-filter');
        dotInv.classList.remove('hidden');
    } else {
        btnInv.classList.remove('active-filter');
        dotInv.classList.add('hidden');
    }
}

function buildFilterOptionsHtml(currentVal, fnName) {
    let html = `
        <button type="button" class="filter-option-item ${currentVal === 'ALL' ? 'selected' : ''}" onclick="${fnName}('ALL')">
            <span>Todas as Categorias</span>
            ${currentVal === 'ALL' ? '<i class="fa-solid fa-check"></i>' : ''}
        </button>
    `;
    categories.forEach(cat => {
        const isSel = currentVal === cat;
        html += `
            <button type="button" class="filter-option-item ${isSel ? 'selected' : ''}" onclick="${fnName}('${cat.replace(/'/g, "\\'")}')">
                <span>${cat}</span>
                ${isSel ? '<i class="fa-solid fa-check"></i>' : ''}
            </button>
        `;
    });
    return html;
}

function setVitrineFilter(cat) {
    vitrineCategoryFilter = cat;
    document.getElementById('vitrine-filter-menu').classList.add('hidden');
    renderFilterMenus();
    renderVitrine();
}

function setInvFilter(cat) {
    invCategoryFilter = cat;
    document.getElementById('inv-filter-menu').classList.add('hidden');
    renderFilterMenus();
    renderSelectInventoryList();
}

function populateCadCategorySelect() {
    const cadSelect = document.getElementById('cad-categoria');
    if (!cadSelect) return;

    const currentCadVal = cadSelect.value;
    cadSelect.innerHTML = '<option value="">Sem Categoria</option>';
    categories.forEach(cat => {
        const opt = document.createElement('option');
        opt.value = cat;
        opt.textContent = cat;
        cadSelect.appendChild(opt);
    });
    if (categories.includes(currentCadVal)) {
        cadSelect.value = currentCadVal;
    }
}

function openModalCategorias() {
    document.getElementById('new-cat-name').value = '';
    renderCategoriesManager();
    document.getElementById('modal-categorias').classList.remove('hidden');
}

function renderCategoriesManager() {
    const list = document.getElementById('categorias-manage-list');
    list.innerHTML = '';

    if (categories.length === 0) {
        list.innerHTML = '<p style="color:#64748b; font-size:0.9rem;">Nenhuma categoria cadastrada.</p>';
        return;
    }

    categories.forEach((cat, index) => {
        const row = document.createElement('div');
        row.className = 'cat-manage-item';
        row.innerHTML = `
            <span>${cat}</span>
            <button type="button" class="btn-mini-del" onclick="removeCategory(${index})" title="Remover Categoria">
                <i class="fa-solid fa-trash"></i>
            </button>
        `;
        list.appendChild(row);
    });
}

function addCategory() {
    const input = document.getElementById('new-cat-name');
    const name = input.value.trim();
    if (!name) return;

    if (categories.some(c => c.toLowerCase() === name.toLowerCase())) {
        alert('Essa categoria já existe.');
        return;
    }

    categories.push(name);
    saveToStorage();
    input.value = '';
    populateCadCategorySelect();
    renderFilterMenus();
    renderCategoriesManager();

    const cadSelect = document.getElementById('cad-categoria');
    if (cadSelect) cadSelect.value = name;
}

function removeCategory(index) {
    const removed = categories[index];
    if (!confirm(`Remover a categoria "${removed}"?`)) return;

    categories.splice(index, 1);
    if (vitrineCategoryFilter === removed) vitrineCategoryFilter = 'ALL';
    if (invCategoryFilter === removed) invCategoryFilter = 'ALL';

    saveToStorage();
    populateCadCategorySelect();
    renderFilterMenus();
    renderCategoriesManager();
    renderVitrine();
}

// ================= NAVEGAÇÃO ENTRE ABAS =================
function switchTab(tabName) {
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.getElementById(`tab-${tabName}`).classList.add('active');

    document.getElementById('view-vitrine').classList.add('hidden');
    document.getElementById('view-relatorios').classList.add('hidden');
    document.getElementById('view-select-inv').classList.add('hidden');
    document.getElementById('view-fill-inv').classList.add('hidden');
    document.getElementById('view-exec-inv').classList.add('hidden');
    document.getElementById('main-tabs').classList.remove('hidden');

    if (tabName === 'vitrine') {
        document.getElementById('header-title').innerText = 'Vitrine de Itens';
        document.getElementById('view-vitrine').classList.remove('hidden');
        renderVitrine();
    } else if (tabName === 'relatorios') {
        document.getElementById('header-title').innerText = 'Relatórios de Inventário';
        document.getElementById('view-relatorios').classList.remove('hidden');
        renderReports();
    }
}

// ================= VITRINE (BOTÃO "DIVERGENTE" EXPANSÍVEL E MINIMIZÁVEL) =================
function toggleDivergenceDetails(itemId, event) {
    if (event) event.stopPropagation();

    if (expandedDivergenceIds.has(itemId)) {
        expandedDivergenceIds.delete(itemId);
    } else {
        expandedDivergenceIds.add(itemId);
    }
    renderVitrine();
}

function formatDivergenceLineHtml(d) {
    const seqTexto = d.sequencia || '-';
    return `Quantidade: <strong>${d.qtdSistema}</strong> - Lote: <strong>${d.lote}</strong> | Seq: <strong>${seqTexto}</strong> (Val: ${d.validade}) = <span class="div-detail-diff">${d.diffFormatted}</span>`;
}

function renderVitrine() {
    const list = document.getElementById('vitrine-list');
    const empty = document.getElementById('vitrine-empty');
    const search = document.getElementById('search-input').value.toLowerCase();

    const filtered = items.filter(item => {
        const matchesSearch = item.nome.toLowerCase().includes(search) ||
                              item.tasy.toLowerCase().includes(search);
        const matchesCat = vitrineCategoryFilter === 'ALL' || (item.categoria === vitrineCategoryFilter);
        return matchesSearch && matchesCat;
    });

    list.innerHTML = '';

    if (filtered.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    filtered.forEach(item => {
        const totalQtd = Number(item.qtdEstoque || 0);
        const minQtd = Number(item.qtdMinima || 0);
        const statusInfo = getStockStatusInfo(minQtd, totalQtd);
        const catBadge = item.categoria ? `<span class="badge-cat">${item.categoria}</span>` : '';

        const isDivergent = Boolean(item.hasDivergence);
        const isExpanded = expandedDivergenceIds.has(item.id);

        let divAlertHtml = '';
        if (isDivergent) {
            const detailsList = Array.isArray(item.divergenceDetails) ? item.divergenceDetails : [];
            const linesHtml = detailsList.length > 0
                ? detailsList.map(d => `<div class="div-detail-line">${formatDivergenceLineHtml(d)}</div>`).join('')
                : `<div class="div-detail-line">Divergência registrada no último inventário.</div>`;

            divAlertHtml = `
                <div class="item-divergent-wrapper" onclick="event.stopPropagation()">
                    <button type="button" class="item-divergent-toggle-btn" onclick="toggleDivergenceDetails('${item.id}', event)">
                        <i class="fa-solid fa-triangle-exclamation"></i>
                        <span>Divergente</span>
                        <i class="fa-solid ${isExpanded ? 'fa-chevron-up' : 'fa-chevron-down'}" style="margin-left:2px; font-size:0.75rem;"></i>
                    </button>
                    <div class="item-divergent-details-box ${isExpanded ? '' : 'hidden'}">
                        ${linesHtml}
                    </div>
                </div>
            `;
        }

        const row = document.createElement('div');
        row.className = `item-list-row ${isDivergent ? 'item-divergent-card' : ''}`;
        row.onclick = () => openItemDetails(item.id);
        row.innerHTML = `
            <div class="item-list-main">
                <div class="badges-row">
                    <span class="badge-tasy">Tasy: ${item.tasy}</span>
                    ${catBadge}
                </div>
                <div class="item-list-title">${item.nome}</div>
                <div class="item-list-meta">
                    <span class="mini-dot" style="background:${statusInfo.dotColor};"></span>
                    <span>Mín: ${minQtd} • Pacote: ${item.pacote || 1} un</span>
                </div>
                ${divAlertHtml}
            </div>
            <div class="item-list-right">
                <div class="total-pill">
                    <span>Total</span>
                    <strong>${totalQtd}</strong>
                </div>
                <button type="button" class="btn-quick-remove-item" onclick="removeItemFromVitrine('${item.id}', event)" title="Remover Item">
                    <i class="fa-solid fa-trash"></i>
                </button>
            </div>
        `;
        list.appendChild(row);
    });
}

function removeItemFromVitrine(itemId, event) {
    if (event) event.stopPropagation();
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    if (!confirm(`Deseja remover "${item.nome}" da lista?`)) return;
    items = items.filter(i => i.id !== itemId);
    expandedDivergenceIds.delete(itemId);
    saveToStorage();
    renderVitrine();
}

function openModalCadastro() {
    document.getElementById('form-cadastro').reset();
    document.getElementById('cad-qtd-min').value = 0;
    document.getElementById('cad-pacote').value = 1;
    populateCadCategorySelect();
    document.getElementById('modal-cadastro').classList.remove('hidden');
}

function closeModal(modalId) {
    document.getElementById(modalId).classList.add('hidden');
}

function saveNewItem(event) {
    event.preventDefault();
    const nome = document.getElementById('cad-nome').value.trim();
    const tasy = document.getElementById('cad-tasy').value.trim();
    const categoria = document.getElementById('cad-categoria').value;
    const qtdMinima = parseInt(document.getElementById('cad-qtd-min').value) || 0;
    const pacote = parseInt(document.getElementById('cad-pacote').value) || 1;

    const newItem = {
        id: Date.now().toString(),
        nome: nome,
        tasy: tasy,
        categoria: categoria,
        qtdMinima: qtdMinima,
        qtdEstoque: 0,
        pacote: pacote,
        hasDivergence: false,
        divergenceDetails: []
    };

    items.push(newItem);
    saveToStorage();
    closeModal('modal-cadastro');
    renderVitrine();
}

// ================= BOTÃO "ATUALIZAR ESTOQUE" (RELATÓRIOS + PREVIEW OLHINHO + NOTIFICAÇÃO) =================
function openUpdateStockModal() {
    if (reports.length === 0) {
        alert('Nenhum relatório de inventário salvo ainda. Realize um inventário primeiro.');
        return;
    }

    selectedUpdateReportId = null;
    document.getElementById('btn-confirm-update-stock').disabled = true;

    const container = document.getElementById('update-reports-list');
    container.innerHTML = '';

    reports.forEach(rep => {
        let divergencias = 0;
        rep.itens.forEach(it => {
            it.lotes.forEach(l => {
                if (l.status === 'err') divergencias++;
            });
        });

        const row = document.createElement('div');
        row.className = 'update-report-row';
        row.id = `upd-rep-row-${rep.id}`;
        row.onclick = () => selectUpdateReport(rep.id);

        row.innerHTML = `
            <div class="update-report-left">
                <input type="radio" name="selected_update_report" value="${rep.id}" id="radio-rep-${rep.id}">
                <div>
                    <strong>${rep.observacao}</strong><br>
                    <small style="color:#64748b;"><i class="fa-regular fa-calendar"></i> ${rep.data}</small><br>
                    <small>
                        ${divergencias === 0
                            ? '<span class="text-green"><strong>Tudo Correto</strong></span>'
                            : `<span class="text-red"><strong>${divergencias} divergência(s)</strong></span>`
                        }
                    </small>
                </div>
            </div>
            <button type="button" class="btn-eye-preview" onclick="openReportPreview('${rep.id}', event)" title="Visualizar Preview do Relatório">
                <i class="fa-solid fa-eye"></i>
            </button>
        `;
        container.appendChild(row);
    });

    document.getElementById('modal-update-stock').classList.remove('hidden');
}

function selectUpdateReport(reportId) {
    selectedUpdateReportId = reportId;
    document.getElementById('btn-confirm-update-stock').disabled = false;

    document.querySelectorAll('.update-report-row').forEach(r => r.classList.remove('selected-report'));
    const activeRow = document.getElementById(`upd-rep-row-${reportId}`);
    if (activeRow) activeRow.classList.add('selected-report');

    const radio = document.getElementById(`radio-rep-${reportId}`);
    if (radio) radio.checked = true;
}

function openReportPreview(reportId, event) {
    if (event) event.stopPropagation();
    const rep = reports.find(r => r.id === reportId);
    if (!rep) return;

    document.getElementById('preview-rel-title').innerText = rep.observacao;
    document.getElementById('preview-rel-date').innerText = `Realizado em: ${rep.data}`;

    const container = document.getElementById('preview-rel-items');
    container.innerHTML = '';

    rep.itens.forEach(item => {
        const block = document.createElement('div');
        block.className = 'rel-item-block';

        let lotesHtml = '';
        item.lotes.forEach(l => {
            const isOk = l.status === 'ok';
            const seqTexto = l.sequencia || '-';
            lotesHtml += `
                <div class="rel-lote-line">
                    <div>
                        <strong>Lote: ${l.lote}</strong> | <strong>Seq: ${seqTexto}</strong> (Val: ${l.validade})<br>
                        <small>Quantidade informada: ${l.qtdSistema}</small>
                    </div>
                    <div style="text-align:right;">
                        ${isOk
                            ? '<span class="text-green"><strong><i class="fa-solid fa-check"></i> Correto</strong></span>'
                            : `<span class="text-red"><strong><i class="fa-solid fa-xmark"></i> Divergente (${l.divergencia})</strong></span>`
                        }
                    </div>
                </div>
            `;
        });

        const catBadge = item.categoria && item.categoria !== 'Sem Categoria'
            ? `<span class="badge-cat">${item.categoria}</span>`
            : '';

        block.innerHTML = `
            <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                <strong>${item.nome}</strong>
                <span class="badge-tasy">Tasy: ${item.tasy}</span>
                ${catBadge}
            </div>
            ${lotesHtml}
        `;
        container.appendChild(block);
    });

    document.getElementById('modal-report-preview').classList.remove('hidden');
}

function parseDivergenceNumber(divStr) {
    if (!divStr) return 0;
    const cleaned = String(divStr).replace(/\s+/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? 0 : num;
}

function formatSignedDivergence(rawStr, numVal) {
    if (numVal > 0) return `+${numVal}`;
    if (numVal < 0) return `${numVal}`;
    return String(rawStr || '0');
}

function applySelectedReportToStock() {
    if (!selectedUpdateReportId) return;
    const rep = reports.find(r => r.id === selectedUpdateReportId);
    if (!rep) return;

    cleanupOldNotifications();

    const modifiedItemsLog = [];

    rep.itens.forEach(repItem => {
        const targetItem = items.find(i => i.id === repItem.itemId) || items.find(i => i.tasy === repItem.tasy);
        if (!targetItem) return;

        const oldTotal = Number(targetItem.qtdEstoque || 0);
        let novoTotalEstoque = 0;
        let hasDivergence = false;
        const divergenceDetails = [];

        repItem.lotes.forEach(l => {
            const qtdInformada = Number(l.qtdSistema) || 0;

            if (l.status === 'ok') {
                novoTotalEstoque += qtdInformada;
            } else {
                hasDivergence = true;
                const diffNum = parseDivergenceNumber(l.divergencia);
                const qtdRealLote = Math.max(0, qtdInformada + diffNum);
                novoTotalEstoque += qtdRealLote;

                divergenceDetails.push({
                    qtdSistema: qtdInformada,
                    lote: l.lote,
                    sequencia: l.sequencia || '-',
                    validade: l.validade,
                    diffFormatted: formatSignedDivergence(l.divergencia, diffNum)
                });
            }
        });

        targetItem.qtdEstoque = novoTotalEstoque;
        targetItem.hasDivergence = hasDivergence;
        targetItem.divergenceDetails = hasDivergence ? divergenceDetails : [];

        if (!hasDivergence) {
            expandedDivergenceIds.delete(targetItem.id);
        }

        modifiedItemsLog.push({
            nome: targetItem.nome,
            tasy: targetItem.tasy,
            oldTotal: oldTotal,
            newTotal: novoTotalEstoque,
            hasDivergence: hasDivergence
        });
    });

    if (modifiedItemsLog.length > 0) {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

        dailyNotifications.unshift({
            id: Date.now().toString(),
            dateKey: getTodayDateKey(),
            time: timeStr,
            reportTitle: rep.observacao,
            read: false,
            items: modifiedItemsLog
        });
    }

    saveToStorage();
    updateNotificationBadge();
    closeModal('modal-update-stock');
    renderVitrine();
}

// ================= MENU DO ITEM (TABELA QTD MÍNIMA x ESTOQUE + SEMÁFORO + PACOTE) =================
function openItemDetails(itemId) {
    currentDetailItemId = itemId;
    const item = items.find(i => i.id === itemId);
    if (!item) return;

    document.getElementById('det-nome').innerText = item.nome;
    document.getElementById('det-tasy').innerText = `Tasy: ${item.tasy}`;
    const catEl = document.getElementById('det-cat');
    if (item.categoria) {
        catEl.innerText = item.categoria;
        catEl.classList.remove('hidden');
    } else {
        catEl.classList.add('hidden');
    }

    const divBanner = document.getElementById('det-divergence-banner');
    const divList = document.getElementById('det-divergence-list');
    if (item.hasDivergence) {
        const detailsList = Array.isArray(item.divergenceDetails) ? item.divergenceDetails : [];
        divList.innerHTML = detailsList.length > 0
            ? detailsList.map(d => `<div>${formatDivergenceLineHtml(d)}</div>`).join('')
            : `<div>Divergência registrada no último inventário.</div>`;
        divBanner.classList.remove('hidden');
    } else {
        divBanner.classList.add('hidden');
    }

    updateItemDetailsView(item);
    document.getElementById('modal-item-details').classList.remove('hidden');
}

function updateItemDetailsView(item) {
    const qtdMin = Number(item.qtdMinima || 0);
    const qtdEst = Number(item.qtdEstoque || 0);
    const pacote = Number(item.pacote || 1);

    document.getElementById('det-qtd-min-val').innerText = qtdMin;
    document.getElementById('det-qtd-est-val').innerText = qtdEst;
    document.getElementById('det-pacote-val').innerText = pacote;

    const statusInfo = getStockStatusInfo(qtdMin, qtdEst);
    const indicatorEl = document.getElementById('det-status-indicator');
    indicatorEl.className = `status-pill-indicator ${statusInfo.colorClass}`;
    document.getElementById('det-status-label').innerText = statusInfo.label;
}

function editItemStockField(field) {
    const item = items.find(i => i.id === currentDetailItemId);
    if (!item) return;

    let labelPrompt = '';
    if (field === 'qtdMinima') labelPrompt = 'Digite a nova Quantidade Mínima:';
    if (field === 'pacote') labelPrompt = 'Digite a quantidade de unidades por Pacote:';
    if (!labelPrompt) return;

    const currentVal = item[field] !== undefined ? item[field] : 0;
    const input = prompt(labelPrompt, currentVal);
    if (input === null) return;

    const parsed = parseInt(input.trim());
    if (isNaN(parsed) || parsed < 0) {
        alert('Por favor, informe um número válido (0 ou maior).');
        return;
    }

    item[field] = parsed;
    saveToStorage();
    updateItemDetailsView(item);
    renderVitrine();
}

// ================= ETAPA 1 DO INVENTÁRIO: SELEÇÃO DE ITENS (CONTORNO VERDE) =================
function openSelectInventory() {
    if (items.length === 0) {
        alert('Cadastre pelo menos um item antes de iniciar o inventário.');
        return;
    }

    selectedInventoryIds.clear();
    invCategoryFilter = 'ALL';
    document.getElementById('inv-search-input').value = '';
    renderFilterMenus();

    document.getElementById('main-tabs').classList.add('hidden');
    document.getElementById('view-vitrine').classList.add('hidden');
    document.getElementById('view-fill-inv').classList.add('hidden');
    document.getElementById('view-select-inv').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'Preparar Inventário';

    renderSelectInventoryList();
}

function getFilteredInventorySelectionItems() {
    const search = document.getElementById('inv-search-input').value.toLowerCase();
    return items.filter(item => {
        const matchesSearch = item.nome.toLowerCase().includes(search) ||
                              item.tasy.toLowerCase().includes(search);
        const matchesCat = invCategoryFilter === 'ALL' || (item.categoria === invCategoryFilter);
        return matchesSearch && matchesCat;
    });
}

function renderSelectInventoryList() {
    const list = document.getElementById('select-items-list');
    list.innerHTML = '';

    const visibleItems = getFilteredInventorySelectionItems();

    if (visibleItems.length === 0) {
        list.innerHTML = '<div style="text-align:center; padding:30px; color:#64748b;">Nenhum item encontrado para este filtro.</div>';
        updateSelectedCount();
        return;
    }

    visibleItems.forEach(item => {
        const catInfo = item.categoria ? ` • ${item.categoria}` : '';
        const isChecked = selectedInventoryIds.has(item.id);
        const label = document.createElement('label');
        label.className = `select-item-row ${isChecked ? 'selected-green' : ''}`;
        label.innerHTML = `
            <input type="checkbox" class="inv-item-checkbox" value="${item.id}" ${isChecked ? 'checked' : ''} onchange="toggleSingleInvItem('${item.id}', this.checked, this)">
            <div style="flex:1;">
                <strong>${item.nome}</strong><br>
                <small style="color:#64748b;">Tasy: ${item.tasy}${catInfo} • Estoque: ${item.qtdEstoque || 0}</small>
            </div>
        `;
        list.appendChild(label);
    });

    updateSelectedCount();
}

function toggleSingleInvItem(itemId, checked, checkboxEl) {
    if (checked) {
        selectedInventoryIds.add(itemId);
        if (checkboxEl) checkboxEl.closest('.select-item-row').classList.add('selected-green');
    } else {
        selectedInventoryIds.delete(itemId);
        if (checkboxEl) checkboxEl.closest('.select-item-row').classList.remove('selected-green');
    }
    updateSelectedCount();
}

function toggleSelectAll(masterCheckbox) {
    const visibleItems = getFilteredInventorySelectionItems();
    visibleItems.forEach(item => {
        if (masterCheckbox.checked) {
            selectedInventoryIds.add(item.id);
        } else {
            selectedInventoryIds.delete(item.id);
        }
    });
    renderSelectInventoryList();
}

function updateSelectedCount() {
    const visibleItems = getFilteredInventorySelectionItems();
    const allVisibleSelected = visibleItems.length > 0 && visibleItems.every(it => selectedInventoryIds.has(it.id));

    document.getElementById('selected-count').innerText = `${selectedInventoryIds.size} selecionado(s)`;
    document.getElementById('btn-iniciar-inv').disabled = selectedInventoryIds.size === 0;
    document.getElementById('select-all-checkbox').checked = allVisibleSelected;

    const selectAllBox = document.getElementById('select-all-box');
    if (allVisibleSelected) {
        selectAllBox.classList.add('selected-green');
    } else {
        selectAllBox.classList.remove('selected-green');
    }
}

function cancelInventory() {
    switchTab('vitrine');
}

// ================= ETAPA 2 DO INVENTÁRIO: PREENCHER LOTE, VALIDADE, QUANTIDADE E SEQUÊNCIA =================
function goToPreInventoryFill() {
    if (selectedInventoryIds.size === 0) return;

    const selectedItems = items.filter(item => selectedInventoryIds.has(item.id));

    preInventoryEntries = selectedItems.map(item => ({
        itemId: item.id,
        nome: item.nome,
        tasy: item.tasy,
        categoria: item.categoria || 'Sem Categoria',
        lotes: [
            { lote: '', validade: '', quantidade: '', sequencia: '' }
        ]
    }));

    document.getElementById('view-select-inv').classList.add('hidden');
    document.getElementById('view-fill-inv').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'Preencher Lote e Sequência';

    renderPreInventoryFillList();
}

function backToSelectInventory() {
    document.getElementById('view-fill-inv').classList.add('hidden');
    document.getElementById('view-select-inv').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'Preparar Inventário';
    renderSelectInventoryList();
}

function renderPreInventoryFillList() {
    const container = document.getElementById('fill-items-list');
    container.innerHTML = '';

    preInventoryEntries.forEach((entry, itemIdx) => {
        const catBadge = entry.categoria && entry.categoria !== 'Sem Categoria'
            ? `<span class="badge-cat">${entry.categoria}</span>`
            : '';

        const isItemComplete = entry.lotes.every(l =>
            l.lote.trim() !== '' &&
            l.validade.trim() !== '' &&
            String(l.quantidade).trim() !== '' &&
            l.sequencia.trim() !== ''
        );

        let subLotesHtml = '';
        entry.lotes.forEach((loteObj, loteIdx) => {
            const removeBtnHtml = loteIdx > 0
                ? `<button type="button" class="btn-remove-sublote" onclick="removePreInvSubLote(${itemIdx}, ${loteIdx})"><i class="fa-solid fa-trash"></i> Remover</button>`
                : '';

            subLotesHtml += `
                <div class="fill-lote-subcard">
                    <div class="fill-lote-subcard-top">
                        <span>Lote #${loteIdx + 1}</span>
                        ${removeBtnHtml}
                    </div>
                    <div class="fill-fields-grid-4">
                        <div class="fill-field-group">
                            <label>Lote *</label>
                            <input type="text" id="fill-lote-${itemIdx}-${loteIdx}" value="${loteObj.lote}" placeholder="Digite o lote" oninput="updatePreInvField(${itemIdx}, ${loteIdx}, 'lote', this.value)">
                        </div>
                        <div class="fill-field-group">
                            <label>Validade *</label>
                            <input type="date" id="fill-val-${itemIdx}-${loteIdx}" value="${loteObj.validade}" oninput="updatePreInvField(${itemIdx}, ${loteIdx}, 'validade', this.value)">
                        </div>
                        <div class="fill-field-group">
                            <label>Quantidade *</label>
                            <input type="number" min="0" id="fill-qtd-${itemIdx}-${loteIdx}" value="${loteObj.quantidade}" placeholder="Qtd" oninput="updatePreInvField(${itemIdx}, ${loteIdx}, 'quantidade', this.value)">
                        </div>
                        <div class="fill-field-group">
                            <label>Sequência *</label>
                            <div class="input-with-scan">
                                <input type="text" id="fill-seq-${itemIdx}-${loteIdx}" value="${loteObj.sequencia}" placeholder="Digite ou bipe" oninput="updatePreInvField(${itemIdx}, ${loteIdx}, 'sequencia', this.value)">
                                <button type="button" class="btn-scan-barcode" onclick="openBarcodeScanner('fill-seq-${itemIdx}-${loteIdx}')" title="Escanear Código de Barras">
                                    <i class="fa-solid fa-barcode"></i>
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            `;
        });

        const card = document.createElement('div');
        card.className = `fill-item-card ${isItemComplete ? 'complete-ok' : ''}`;
        card.id = `fill-card-${itemIdx}`;

        card.innerHTML = `
            <div class="fill-item-header">
                <div>
                    <div class="badges-row" style="margin-bottom:4px;">
                        <span class="badge-tasy">Tasy: ${entry.tasy}</span>
                        ${catBadge}
                    </div>
                    <strong>${entry.nome}</strong>
                </div>
                <div class="fill-item-header-actions">
                    <span id="fill-status-icon-${itemIdx}" class="${isItemComplete ? 'text-green' : ''}" style="font-size:1.1rem;">
                        ${isItemComplete ? '<i class="fa-solid fa-circle-check"></i>' : ''}
                    </span>
                    <button type="button" class="btn-add-sublote-icon" onclick="addPreInvSubLote(${itemIdx})" title="Adicionar outro Lote / Validade / Quantidade / Sequência">
                        <i class="fa-solid fa-plus"></i>
                    </button>
                </div>
            </div>

            <div class="fill-lotes-stack">
                ${subLotesHtml}
            </div>
        `;
        container.appendChild(card);
    });
}

function addPreInvSubLote(itemIdx) {
    preInventoryEntries[itemIdx].lotes.push({ lote: '', validade: '', quantidade: '', sequencia: '' });
    renderPreInventoryFillList();
}

function removePreInvSubLote(itemIdx, loteIdx) {
    if (loteIdx === 0 || preInventoryEntries[itemIdx].lotes.length <= 1) return;
    preInventoryEntries[itemIdx].lotes.splice(loteIdx, 1);
    renderPreInventoryFillList();
}

function updatePreInvField(itemIdx, loteIdx, field, value) {
    preInventoryEntries[itemIdx].lotes[loteIdx][field] = value;

    const entry = preInventoryEntries[itemIdx];
    const card = document.getElementById(`fill-card-${itemIdx}`);
    const icon = document.getElementById(`fill-status-icon-${itemIdx}`);

    const isItemComplete = entry.lotes.every(l =>
        l.lote.trim() !== '' &&
        l.validade.trim() !== '' &&
        String(l.quantidade).trim() !== '' &&
        l.sequencia.trim() !== ''
    );

    if (isItemComplete) {
        card.classList.remove('missing-error');
        card.classList.add('complete-ok');
        icon.className = 'text-green';
        icon.innerHTML = '<i class="fa-solid fa-circle-check"></i>';
    } else {
        card.classList.remove('complete-ok');
        icon.innerHTML = '';
    }
}

function validateAndConfirmStartInventory() {
    const missingItems = [];

    preInventoryEntries.forEach((entry, itemIdx) => {
        const card = document.getElementById(`fill-card-${itemIdx}`);
        const itemMissingDetails = [];

        entry.lotes.forEach((l, loteIdx) => {
            const missingFields = [];
            if (!l.lote.trim()) missingFields.push('Lote');
            if (!l.validade.trim()) missingFields.push('Validade');
            if (String(l.quantidade).trim() === '') missingFields.push('Quantidade');
            if (!l.sequencia.trim()) missingFields.push('Sequência');

            if (missingFields.length > 0) {
                itemMissingDetails.push(`Lote #${loteIdx + 1}: ${missingFields.join(', ')}`);
            }
        });

        if (itemMissingDetails.length > 0) {
            card.classList.add('missing-error');
            card.classList.remove('complete-ok');
            missingItems.push(`• ${entry.nome} (${itemMissingDetails.join(' | ')})`);
        } else {
            card.classList.remove('missing-error');
        }
    });

    if (missingItems.length > 0) {
        alert(`Atenção! Faltam preencher campos nos seguintes itens:\n\n${missingItems.join('\n')}`);
        const firstErrorCard = document.querySelector('.fill-item-card.missing-error');
        if (firstErrorCard) firstErrorCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
    }

    const totalSelecionados = preInventoryEntries.length;
    if (!confirm(`Foram selecionados ${totalSelecionados} item(ns) e todos os dados estão preenchidos.\n\nDeseja iniciar o inventário agora?`)) {
        return;
    }

    startInventory();
}

// ================= ETAPA 3 DO INVENTÁRIO: CONFERÊNCIA ITEM A ITEM =================
function startInventory() {
    inventoryQueue = preInventoryEntries.map(entry => ({
        id: entry.itemId,
        nome: entry.nome,
        tasy: entry.tasy,
        categoria: entry.categoria,
        lotes: entry.lotes.map(l => ({
            lote: l.lote.trim(),
            validade: l.validade.trim(),
            sequencia: l.sequencia.trim(),
            qtd: parseInt(l.quantidade) || 0
        }))
    }));

    currentInvIndex = 0;
    currentInvResults = [];

    document.getElementById('view-fill-inv').classList.add('hidden');
    document.getElementById('view-exec-inv').classList.remove('hidden');
    document.getElementById('header-title').innerText = 'Conferência de Inventário';

    renderCurrentInventoryItem();
}

function renderCurrentInventoryItem() {
    const item = inventoryQueue[currentInvIndex];
    document.getElementById('inv-progress-text').innerText = `Item ${currentInvIndex + 1} de ${inventoryQueue.length}`;
    document.getElementById('inv-item-name').innerText = item.nome;
    document.getElementById('inv-item-tasy').innerText = item.tasy;

    const catEl = document.getElementById('inv-item-cat');
    if (item.categoria && item.categoria !== 'Sem Categoria') {
        catEl.innerText = item.categoria;
        catEl.classList.remove('hidden');
    } else {
        catEl.classList.add('hidden');
    }

    const container = document.getElementById('inv-lotes-container');
    container.innerHTML = '';

    item.lotes.forEach((loteObj, idx) => {
        const valFormatada = loteObj.validade ? loteObj.validade.split('-').reverse().join('/') : 'N/A';
        const seqTexto = loteObj.sequencia || '-';

        const box = document.createElement('div');
        box.className = 'inv-lote-box';
        box.dataset.lote = loteObj.lote;
        box.dataset.sequencia = seqTexto;
        box.dataset.validade = valFormatada;
        box.dataset.qtd = loteObj.qtd;
        box.dataset.status = '';

        box.innerHTML = `
            <div class="inv-lote-top">
                <div class="inv-lote-info">
                    <p><strong>Lote:</strong> ${loteObj.lote} &nbsp;|&nbsp; <strong>Seq:</strong> ${seqTexto}</p>
                    <p><strong>Validade:</strong> ${valFormatada}</p>
                    <p><strong>Quantidade:</strong> ${loteObj.qtd}</p>
                </div>
                <div class="check-actions">
                    <button type="button" class="check-box-btn ok" onclick="markLoteStatus(${idx}, 'ok')" title="Correto">
                        <i class="fa-solid fa-check"></i>
                    </button>
                    <button type="button" class="check-box-btn err" onclick="markLoteStatus(${idx}, 'err')" title="Divergente">
                        <i class="fa-solid fa-xmark"></i>
                    </button>
                </div>
            </div>
            <div class="divergencia-box hidden" id="div-box-${idx}">
                <label>Divergência:</label>
                <input type="text" id="div-input-${idx}" placeholder="Ex: -20 ou +10" oninput="validateCurrentStep()">
            </div>
        `;
        container.appendChild(box);
    });

    validateCurrentStep();
}

function markLoteStatus(loteIdx, status) {
    const boxes = document.querySelectorAll('.inv-lote-box');
    const currentBox = boxes[loteIdx];
    const btnOk = currentBox.querySelector('.check-box-btn.ok');
    const btnErr = currentBox.querySelector('.check-box-btn.err');
    const divBox = document.getElementById(`div-box-${loteIdx}`);
    const divInput = document.getElementById(`div-input-${loteIdx}`);

    currentBox.dataset.status = status;

    if (status === 'ok') {
        btnOk.classList.add('selected');
        btnErr.classList.remove('selected');
        divBox.classList.add('hidden');
        divInput.value = '';
    } else {
        btnErr.classList.add('selected');
        btnOk.classList.remove('selected');
        divBox.classList.remove('hidden');
        divInput.focus();
    }

    validateCurrentStep();
}

function validateCurrentStep() {
    const boxes = Array.from(document.querySelectorAll('.inv-lote-box'));
    const nextBtn = document.getElementById('btn-next-inv-item');

    const allMarked = boxes.every((box, idx) => {
        const status = box.dataset.status;
        if (!status) return false;
        if (status === 'err') {
            const val = document.getElementById(`div-input-${idx}`).value.trim();
            return val.length > 0;
        }
        return true;
    });

    if (allMarked) {
        nextBtn.disabled = false;
        nextBtn.classList.remove('disabled');
    } else {
        nextBtn.disabled = true;
        nextBtn.classList.add('disabled');
    }
}

function nextInventoryItem() {
    const item = inventoryQueue[currentInvIndex];
    const boxes = Array.from(document.querySelectorAll('.inv-lote-box'));

    const lotesConferidos = boxes.map((box, idx) => {
        const status = box.dataset.status;
        const divergencia = status === 'err' ? document.getElementById(`div-input-${idx}`).value.trim() : '0';
        return {
            lote: box.dataset.lote,
            sequencia: box.dataset.sequencia,
            validade: box.dataset.validade,
            qtdSistema: box.dataset.qtd,
            status: status,
            divergencia: divergencia
        };
    });

    currentInvResults.push({
        itemId: item.id,
        nome: item.nome,
        tasy: item.tasy,
        categoria: item.categoria || 'Sem Categoria',
        lotes: lotesConferidos
    });

    if (currentInvIndex + 1 < inventoryQueue.length) {
        currentInvIndex++;
        renderCurrentInventoryItem();
        window.scrollTo(0, 0);
    } else {
        if (confirm('Todos os itens foram conferidos! Deseja finalizar o inventário e gerar o relatório?')) {
            finishInventory();
        }
    }
}

function abortInventory() {
    if (confirm('Deseja sair do inventário? O progresso atual será perdido.')) {
        switchTab('vitrine');
    }
}

function finishInventory() {
    const now = new Date();
    const dataFormatada = now.toLocaleDateString('pt-BR') + ' às ' + now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

    const newReport = {
        id: Date.now().toString(),
        data: dataFormatada,
        observacao: `Inventário (${currentInvResults.length} itens)`,
        itens: currentInvResults
    };

    reports.unshift(newReport);
    saveToStorage();

    switchTab('relatorios');
    openReportModal(newReport.id);
}

// ================= ABA RELATÓRIOS (CONSULTAR, EDITAR, EXCLUIR E GERAR TABELA) =================
function renderReports() {
    const list = document.getElementById('relatorios-list');
    const empty = document.getElementById('relatorios-empty');
    list.innerHTML = '';

    if (reports.length === 0) {
        empty.classList.remove('hidden');
        return;
    }
    empty.classList.add('hidden');

    reports.forEach(rep => {
        let divergencias = 0;
        rep.itens.forEach(it => {
            it.lotes.forEach(l => {
                if (l.status === 'err') divergencias++;
            });
        });

        const card = document.createElement('div');
        card.className = 'report-card';
        card.onclick = () => openReportModal(rep.id);
        card.innerHTML = `
            <div class="report-card-info">
                <h4>${rep.observacao}</h4>
                <p><i class="fa-regular fa-calendar"></i> Realizado em: ${rep.data}</p>
                <p style="margin-top:4px;">
                    ${divergencias === 0
                        ? '<span class="text-green"><strong><i class="fa-solid fa-check-circle"></i> Tudo Correto</strong></span>'
                        : `<span class="text-red"><strong><i class="fa-solid fa-triangle-exclamation"></i> ${divergencias} divergência(s)</strong></span>`
                    }
                </p>
            </div>
            <i class="fa-solid fa-chevron-right" style="color:#94a3b8;"></i>
        `;
        list.appendChild(card);
    });
}

function openReportModal(reportId) {
    currentReportId = reportId;
    const rep = reports.find(r => r.id === reportId);
    if (!rep) return;

    document.getElementById('rel-modal-date').innerText = `Realizado em: ${rep.data}`;
    document.getElementById('rel-modal-obs').value = rep.observacao;

    const container = document.getElementById('rel-modal-items');
    container.innerHTML = '';

    rep.itens.forEach((item, iIdx) => {
        const block = document.createElement('div');
        block.className = 'rel-item-block';

        let lotesHtml = '';
        item.lotes.forEach((l, lIdx) => {
            const isOk = l.status === 'ok';
            const seqTexto = l.sequencia || '-';
            lotesHtml += `
                <div class="rel-lote-line">
                    <div>
                        <strong>Lote: ${l.lote}</strong> | <strong>Seq: ${seqTexto}</strong> (Val: ${l.validade})<br>
                        <small>Quantidade: ${l.qtdSistema}</small>
                    </div>
                    <div style="text-align:right;">
                        ${isOk
                            ? '<span class="text-green"><strong><i class="fa-solid fa-check"></i> Correto</strong></span>'
                            : `<span class="text-red"><strong><i class="fa-solid fa-xmark"></i> Divergente:</strong></span>
                               <input type="text" class="rel-edit-div-input" data-i="${iIdx}" data-l="${lIdx}" value="${l.divergencia}">`
                        }
                    </div>
                </div>
            `;
        });

        const catBadge = item.categoria && item.categoria !== 'Sem Categoria'
            ? `<span class="badge-cat">${item.categoria}</span>`
            : '';

        block.innerHTML = `
            <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                <strong>${item.nome}</strong>
                <span class="badge-tasy">Tasy: ${item.tasy}</span>
                ${catBadge}
            </div>
            ${lotesHtml}
        `;
        container.appendChild(block);
    });

    document.getElementById('modal-relatorio-view').classList.remove('hidden');
}

function saveReportEdits() {
    const rep = reports.find(r => r.id === currentReportId);
    if (!rep) return;

    rep.observacao = document.getElementById('rel-modal-obs').value.trim() || rep.observacao;

    const inputs = document.querySelectorAll('.rel-edit-div-input');
    inputs.forEach(inp => {
        const iIdx = inp.dataset.i;
        const lIdx = inp.dataset.l;
        rep.itens[iIdx].lotes[lIdx].divergencia = inp.value.trim();
    });

    saveToStorage();
    closeModal('modal-relatorio-view');
    renderReports();
}

function deleteCurrentReport() {
    if (!confirm('Deseja realmente excluir este relatório?')) return;
    reports = reports.filter(r => r.id !== currentReportId);
    saveToStorage();
    closeModal('modal-relatorio-view');
    renderReports();
}

// ================= BOTÃO "GERAR": CABEÇALHO DO ITEM EM CIMA E LOTES/QUANTIDADE/SEQUÊNCIA EMBAIXO =================
function generateReportTablePage() {
    const rep = reports.find(r => r.id === currentReportId);
    if (!rep) return;

    const tituloAtual = document.getElementById('rel-modal-obs').value.trim() || rep.observacao;
    const inputs = document.querySelectorAll('.rel-edit-div-input');
    inputs.forEach(inp => {
        rep.itens[inp.dataset.i].lotes[inp.dataset.l].divergencia = inp.value.trim();
    });
    rep.observacao = tituloAtual;
    saveToStorage();

    let itemsCardsHtml = '';
    rep.itens.forEach(item => {
        const itemOriginal = items.find(i => i.id === item.itemId);
        const categoriaTexto = item.categoria || (itemOriginal && itemOriginal.categoria) || 'Sem Categoria';

        let lotesRowsHtml = '';
        item.lotes.forEach(l => {
            const isOk = l.status === 'ok';
            const statusTexto = isOk ? 'Correto' : l.divergencia;
            const statusClass = isOk ? 'status-ok' : 'status-err';
            const seqTexto = l.sequencia || '-';

            lotesRowsHtml += `
                <tr>
                    <td>${l.lote}</td>
                    <td>${l.validade}</td>
                    <td>${l.qtdSistema}</td>
                    <td>${seqTexto}</td>
                    <td class="${statusClass}">${statusTexto}</td>
                </tr>
            `;
        });

        itemsCardsHtml += `
            <div class="item-report-group">
                <div class="item-group-header">
                    <span class="col-code"><strong>Código:</strong> ${item.tasy}</span>
                    <span class="col-name"><strong>Nome:</strong> ${item.nome}</span>
                    <span class="col-cat"><strong>Categoria:</strong> ${categoriaTexto}</span>
                </div>
                <table>
                    <thead>
                        <tr>
                            <th>Lote</th>
                            <th>Validade</th>
                            <th>Quantidade</th>
                            <th>Sequência</th>
                            <th>Status</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${lotesRowsHtml}
                    </tbody>
                </table>
            </div>
        `;
    });

    const newWin = window.open('', '_blank');
    if (!newWin) {
        alert('Por favor, permita pop-ups no navegador para abrir a tabela do relatório.');
        return;
    }

    newWin.document.write(`
        <!DOCTYPE html>
        <html lang="pt-BR">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Tabela - ${tituloAtual}</title>
            <style>
                * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; }
                body { margin: 0; padding: 20px; background: #f1f5f9; color: #1e293b; }
                .container { max-width: 1000px; margin: 0 auto; background: #ffffff; padding: 24px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.06); }
                .header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 20px; }
                .header h1 { margin: 0 0 4px 0; font-size: 1.35rem; color: #0f172a; }
                .header p { margin: 0; color: #64748b; font-size: 0.9rem; }
                .btn-print { background: #2563eb; color: white; border: none; padding: 10px 18px; border-radius: 8px; font-weight: 600; cursor: pointer; font-size: 0.95rem; }
                
                .item-report-group { border: 1px solid #cbd5e1; border-radius: 10px; overflow: hidden; margin-bottom: 18px; background: #fff; }
                .item-group-header { background: #0f172a; color: #ffffff; padding: 12px 16px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; font-size: 0.92rem; }
                .item-group-header strong { color: #93c5fd; font-weight: 600; }
                
                table { width: 100%; border-collapse: collapse; }
                th, td { padding: 10px 14px; text-align: left; border-bottom: 1px solid #e2e8f0; font-size: 0.9rem; width: 20%; }
                th { background-color: #f8fafc; color: #475569; font-weight: 700; text-transform: uppercase; font-size: 0.78rem; }
                tr:last-child td { border-bottom: none; }
                .status-ok { color: #16a34a; font-weight: 700; }
                .status-err { color: #dc2626; font-weight: 700; }

                @media print {
                    body { background: white; padding: 0; }
                    .container { box-shadow: none; padding: 0; }
                    .btn-print { display: none; }
                    .item-report-group { break-inside: avoid; }
                }
            </style>
        </head>
        <body>
            <div class="container">
                <div class="header">
                    <div>
                        <h1>${tituloAtual}</h1>
                        <p>Realizado em: ${rep.data}</p>
                    </div>
                    <button class="btn-print" onclick="window.print()">Imprimir / Salvar PDF</button>
                </div>
                ${itemsCardsHtml}
            </div>
        </body>
        </html>
    `);
    newWin.document.close();
}