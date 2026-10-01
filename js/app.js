/*
 * Flexible Column Layout（FCL）控制器
 *
 * 狀態來源：
 *   - URL hash：#/<訂單編號>/<明細編號>?fs=<begin|mid|end>
 *     → 決定開了幾欄、哪一欄全螢幕，可直接分享連結、支援瀏覽器上一頁。
 *   - 版面偏好（比例、拖曳後的自訂寬度、主題）：存在 localStorage。
 *
 * 版面計算（computeLayout）依裝置斷點決定可見欄位與比例：
 *   desktop ≥ 1280px：最多 3 欄並排
 *   tablet  768–1279px：最多 2 欄；開第 3 欄時第 1 欄被推出畫面
 *   phone   < 768px：單欄，以 slide-in 方式切換
 */
(function () {
  'use strict';

  const { orders, STATUSES, WAREHOUSES } = window.FCL_DATA;
  const COLS = ['begin', 'mid', 'end'];
  const RATIO2 = { '33-67': [33, 67], '25-75': [25, 75] };
  const RATIO3 = { '25-50-25': [25, 50, 25], '33-33-33': [33.3, 33.3, 33.3] };
  const MIN_COL_PX = 220;

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const fcl = $('#fcl');
  const colEl = Object.fromEntries(COLS.map((c) => [c, $('#col-' + c)]));

  /* ---------- 偏好儲存（失敗時靜默降級） ---------- */
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem('fcl:' + key);
        return v == null ? fallback : JSON.parse(v);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('fcl:' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
    },
  };

  const state = {
    orderId: null,
    itemId: null,
    fs: null,
    ratio2: store.get('ratio2', '33-67'),
    ratio3: store.get('ratio3', '25-50-25'),
    custom: store.get('custom', {}),
    query: '',
    status: 'all',
    sort: 'date-desc',
    dirty: false,
    rendered: { mid: null, end: null },
    device: null,
  };
  if (!RATIO2[state.ratio2]) state.ratio2 = '33-67';
  if (!RATIO3[state.ratio3]) state.ratio3 = '25-50-25';

  /* ---------- 工具 ---------- */
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (n) => 'NT$ ' + Math.round(n).toLocaleString('zh-TW');
  const lineTotal = (it) => it.qty * it.price * (1 - it.discount / 100);
  const orderTotal = (o) => o.items.reduce((s, it) => s + lineTotal(it), 0);
  const statusOf = (key) => STATUSES.find((s) => s.key === key);
  const badge = (key) => {
    const s = statusOf(key);
    return `<span class="badge badge--${s.tone}">${s.label}</span>`;
  };
  const findOrder = (id) => orders.find((o) => o.id === id) || null;
  const findItem = (o, id) => (o ? o.items.find((it) => it.id === id) || null : null);
  const isLocked = (o) => o.status === 'shipped' || o.status === 'cancelled';

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('is-on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('is-on'), 2400);
  }

  /* ---------- 路由 ---------- */
  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, qs] = raw.split('?');
    const [orderId, itemId] = path.split('/').filter(Boolean);
    const fs = new URLSearchParams(qs || '').get('fs');
    const order = findOrder(orderId);
    const item = findItem(order, Number(itemId));
    return {
      orderId: order ? order.id : null,
      itemId: item ? item.id : null,
      fs: COLS.includes(fs) ? fs : null,
    };
  }

  function buildHash({ orderId, itemId, fs }) {
    let h = '#/';
    if (orderId) h += orderId;
    if (orderId && itemId) h += '/' + itemId;
    if (fs) h += '?fs=' + fs;
    return h;
  }

  function confirmDiscard() {
    return !state.dirty || window.confirm('明細有尚未儲存的變更，確定要離開嗎？');
  }

  function navigate(next) {
    const target = { orderId: state.orderId, itemId: state.itemId, fs: state.fs, ...next };
    const leavingItem = target.orderId !== state.orderId || target.itemId !== state.itemId;
    if (leavingItem && !confirmDiscard()) return;
    if (leavingItem) state.dirty = false;
    const h = buildHash(target);
    if (h === location.hash) return;
    location.hash = h;
  }

  let suppressHash = false;
  window.addEventListener('hashchange', () => {
    if (suppressHash) { suppressHash = false; return; }
    const next = parseHash();
    const leavingItem = next.orderId !== state.orderId || next.itemId !== state.itemId;
    if (leavingItem && state.dirty) {
      // 例如按下瀏覽器上一頁：仍需保護未儲存的編輯
      if (!confirmDiscard()) {
        suppressHash = true;
        location.hash = buildHash(state);
        return;
      }
      state.dirty = false;
    }
    const opened = levelOf(next) > levelOf(state);
    Object.assign(state, next);
    render();
    if (opened && state.device === 'phone') focusDeepest();
  });

  const levelOf = (s) => (!s.orderId ? 1 : !s.itemId ? 2 : 3);

  /* ---------- 版面配置 ---------- */
  function getDevice() {
    const w = window.innerWidth;
    if (w >= 1280) return 'desktop';
    if (w >= 768) return 'tablet';
    return 'phone';
  }

  function computeLayout() {
    const device = getDevice();
    const levels = levelOf(state);
    const open = COLS.slice(0, levels);
    const fs = device !== 'phone' && state.fs && open.includes(state.fs) && levels > 1 ? state.fs : null;
    let visible;
    let widths;

    if (device === 'phone') {
      visible = [open[levels - 1]];
      widths = [100];
    } else if (fs) {
      visible = [fs];
      widths = [100];
    } else if (levels === 1) {
      visible = ['begin'];
      widths = [100];
    } else if (levels === 2) {
      visible = ['begin', 'mid'];
      widths = RATIO2[state.ratio2];
    } else if (device === 'desktop') {
      visible = open;
      widths = RATIO3[state.ratio3];
    } else {
      // 平板開啟第三欄：第一欄推出畫面，第二、三欄沿用三欄比例中的相對關係
      visible = ['mid', 'end'];
      const [, m, e] = RATIO3[state.ratio3];
      widths = [(m / (m + e)) * 100, (e / (m + e)) * 100];
    }

    const key = customKey(device, visible);
    if (state.custom[key] && state.custom[key].length === visible.length) widths = state.custom[key];
    return { device, levels, open, fs, visible, widths, key };
  }

  function customKey(device, visible) {
    const ratio = visible.length === 2 && visible[0] === 'begin' ? state.ratio2 : state.ratio3;
    return `${device}|${visible.join(',')}|${ratio}`;
  }

  let currentLayout = null;
  function applyLayout() {
    const L = computeLayout();
    currentLayout = L;
    state.device = L.device;
    fcl.dataset.device = L.device;
    fcl.dataset.levels = String(L.levels);
    fcl.dataset.fs = L.fs || '';
    $('#device-badge').textContent = { desktop: '桌面', tablet: '平板', phone: '行動' }[L.device];

    const deepest = L.open[L.open.length - 1];
    COLS.forEach((c) => {
      const el = colEl[c];
      const idx = L.visible.indexOf(c);
      const shown = idx !== -1;
      el.style.setProperty('--grow', shown ? String(L.widths[idx]) : '0');
      el.classList.toggle('is-hidden', !shown);
      el.inert = !shown;
      el.setAttribute('aria-hidden', String(!shown));
      // 行動版滑動定位：已開啟但非最深層的欄位往左退，未開啟的停在右側
      const openIdx = L.open.indexOf(c);
      const deepIdx = L.open.indexOf(deepest);
      el.dataset.pos = openIdx === -1 ? 'next' : openIdx < deepIdx ? 'prev' : 'active';

      const fsBtn = $('[data-action="fullscreen"]', el);
      const isFs = L.fs === c;
      fsBtn.hidden = L.device === 'phone' || (!isFs && (L.levels === 1 || !shown));
      fsBtn.textContent = isFs ? '⤡' : '⤢';
      fsBtn.setAttribute('aria-label', isFs ? '退出全螢幕' : '全螢幕');
      fsBtn.title = isFs ? '退出全螢幕（Esc）' : '全螢幕';
      fsBtn.setAttribute('aria-pressed', String(isFs));
    });

    $$('.sep').forEach((sep) => {
      const [a, b] = sep.dataset.sep.split('-');
      const ia = L.visible.indexOf(a);
      sep.hidden = !(ia !== -1 && L.visible[ia + 1] === b);
      if (!sep.hidden) {
        const pct = Math.round(L.widths[ia] / (L.widths[ia] + L.widths[ia + 1]) * 100);
        sep.setAttribute('aria-valuenow', String(pct));
        sep.title = '拖曳調整寬度，雙擊還原比例';
      }
    });

    $$('.seg').forEach((seg) => {
      const val = state[seg.dataset.group];
      $$('button', seg).forEach((b) => {
        const on = b.dataset.value === val;
        b.setAttribute('aria-checked', String(on));
        b.classList.toggle('is-on', on);
      });
    });
    // 平板沒有三欄並排，但三欄比例仍決定第二／三欄的相對寬度，所以保留
    $('[data-group="ratio2"]').classList.toggle('is-active-mode', L.visible.length === 2 && L.visible[0] === 'begin');
    $('[data-group="ratio3"]').classList.toggle('is-active-mode', L.levels === 3 && !L.fs);
  }

  function focusDeepest() {
    const L = currentLayout;
    const title = $('.col__title', colEl[L.open[L.open.length - 1]]);
    title.setAttribute('tabindex', '-1');
    title.focus({ preventScroll: true });
  }

  /* ---------- 第一欄：主清單 ---------- */
  function filteredOrders() {
    const q = state.query.trim().toLowerCase();
    const list = orders.filter((o) => {
      if (state.status !== 'all' && o.status !== state.status) return false;
      if (!q) return true;
      return [o.id, o.customer, o.sales].some((v) => v.toLowerCase().includes(q));
    });
    const [field, dir] = state.sort.split('-');
    const sign = dir === 'asc' ? 1 : -1;
    list.sort((a, b) => {
      const va = field === 'date' ? a.orderDate : orderTotal(a);
      const vb = field === 'date' ? b.orderDate : orderTotal(b);
      return (va > vb ? 1 : va < vb ? -1 : 0) * sign;
    });
    return list;
  }

  function renderChips() {
    const counts = Object.fromEntries(STATUSES.map((s) => [s.key, orders.filter((o) => o.status === s.key).length]));
    const chips = [{ key: 'all', label: '全部', n: orders.length }, ...STATUSES.map((s) => ({ key: s.key, label: s.label, n: counts[s.key] }))];
    $('#status-chips').innerHTML = chips
      .map((c) => `<button type="button" class="chip${state.status === c.key ? ' is-on' : ''}" data-status="${c.key}" aria-pressed="${state.status === c.key}">${c.label}<span class="chip__n">${c.n}</span></button>`)
      .join('');
  }

  function renderMaster() {
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.order : null;
    renderChips();
    const list = filteredOrders();
    $('#master-count').textContent = `共 ${list.length} 筆`;
    const body = $('#master-body');
    if (!list.length) {
      body.innerHTML = `<div class="empty"><div class="empty__icon" aria-hidden="true">⌕</div><p>找不到符合條件的訂單</p><button type="button" class="btn btn--ghost" data-action="clear-filter">清除篩選</button></div>`;
      return;
    }
    body.innerHTML = `<ul class="list" role="list">${list
      .map((o) => {
        const sel = o.id === state.orderId;
        return `<li><button type="button" class="row${sel ? ' is-selected' : ''}" data-order="${o.id}"${sel ? ' aria-current="true"' : ''}>
          <span class="row__main">
            <span class="row__title">${esc(o.customer)}</span>
            <span class="row__meta">${o.id} · ${o.orderDate} · ${esc(o.sales)}</span>
          </span>
          <span class="row__side">
            <span class="row__amount">${money(orderTotal(o))}</span>
            ${badge(o.status)}
          </span>
          <span class="row__chev" aria-hidden="true">›</span>
        </button></li>`;
      })
      .join('')}</ul>`;
    // 重繪清單後把鍵盤焦點還給原本那一列
    if (focused) {
      const again = $(`#master-body [data-order="${focused}"]`);
      if (again) again.focus({ preventScroll: true });
    }
  }

  /* ---------- 第二欄：Object Page ---------- */
  function renderMid() {
    const o = findOrder(state.orderId);
    const body = $('#mid-body');
    if (!o) {
      state.rendered.mid = null;
      body.innerHTML = '';
      return;
    }
    const keepScroll = state.rendered.mid === o.id ? body.scrollTop : 0;
    state.rendered.mid = o.id;
    $('#mid-title').textContent = o.id;
    $('#mid-sub').textContent = o.customer;

    const total = orderTotal(o);
    const qty = o.items.reduce((s, it) => s + it.qty, 0);
    body.innerHTML = `
      <article class="op">
        <header class="op__header">
          <div class="op__identity">
            <div class="avatar" aria-hidden="true">${esc(o.customer.slice(0, 1))}</div>
            <div>
              <h3 class="op__title">${esc(o.customer)}</h3>
              <p class="op__meta">${o.id} · 業務 ${esc(o.sales)}</p>
            </div>
            ${badge(o.status)}
          </div>
          <dl class="kpis">
            <div class="kpi"><dt>訂單總額</dt><dd class="kpi__big">${money(total)}</dd></div>
            <div class="kpi"><dt>品項 / 數量</dt><dd>${o.items.length} 項 / ${qty} 件</dd></div>
            <div class="kpi"><dt>付款狀態</dt><dd>${o.payment}</dd></div>
            <div class="kpi"><dt>下單日</dt><dd>${o.orderDate}</dd></div>
          </dl>
          <div class="op__toolbar">
            <label class="inline-field">變更狀態
              <select data-action="status">
                ${STATUSES.map((s) => `<option value="${s.key}"${s.key === o.status ? ' selected' : ''}>${s.label}</option>`).join('')}
              </select>
            </label>
          </div>
        </header>

        <nav class="op__tabs" aria-label="區段">
          <button type="button" data-scroll="sec-items">商品明細</button>
          <button type="button" data-scroll="sec-general">一般資訊</button>
          <button type="button" data-scroll="sec-ship">出貨資訊</button>
          <button type="button" data-scroll="sec-history">活動紀錄</button>
        </nav>

        <section class="op__section" id="sec-items">
          <div class="op__section-head">
            <h4>商品明細</h4>
            <span class="muted">${isLocked(o) ? '此訂單已' + statusOf(o.status).label + '，明細僅供檢視' : '點選任一品項開啟第三欄編輯'}</span>
          </div>
          <table class="tbl">
            <thead><tr>
              <th scope="col">品名</th>
              <th scope="col" class="c-sku">SKU</th>
              <th scope="col" class="num">數量</th>
              <th scope="col" class="num c-price">單價</th>
              <th scope="col" class="num">小計</th>
              <th scope="col" class="c-go"><span class="visually-hidden">開啟</span></th>
            </tr></thead>
            <tbody>
              ${o.items
                .map((it) => {
                  const sel = it.id === state.itemId;
                  return `<tr class="tbl__row${sel ? ' is-selected' : ''}" data-item="${it.id}" tabindex="0"${sel ? ' aria-current="true"' : ''} aria-label="${esc(it.name)}，開啟明細">
                    <td><span class="cell-title">${esc(it.name)}</span>${it.discount ? `<span class="tag">-${it.discount}%</span>` : ''}</td>
                    <td class="c-sku mono">${it.sku}</td>
                    <td class="num">${it.qty} ${it.unit}</td>
                    <td class="num c-price">${money(it.price)}</td>
                    <td class="num">${money(lineTotal(it))}</td>
                    <td class="c-go" aria-hidden="true">›</td>
                  </tr>`;
                })
                .join('')}
            </tbody>
            <tfoot><tr><th scope="row">合計</th><td class="c-sku"></td><td></td><td class="c-price"></td><td class="num strong">${money(total)}</td><td class="c-go"></td></tr></tfoot>
          </table>
        </section>

        <section class="op__section" id="sec-general">
          <div class="op__section-head"><h4>一般資訊</h4></div>
          <dl class="fields">
            <div><dt>客戶</dt><dd>${esc(o.customer)}</dd></div>
            <div><dt>負責業務</dt><dd>${esc(o.sales)}</dd></div>
            <div><dt>訂單狀態</dt><dd>${statusOf(o.status).label}</dd></div>
            <div><dt>付款狀態</dt><dd>${o.payment}</dd></div>
          </dl>
        </section>

        <section class="op__section" id="sec-ship">
          <div class="op__section-head"><h4>出貨資訊</h4></div>
          <dl class="fields">
            <div><dt>收件地址</dt><dd>${esc(o.address)}</dd></div>
            <div><dt>聯絡電話</dt><dd>${o.contact}</dd></div>
            <div><dt>出貨倉</dt><dd>${[...new Set(o.items.map((it) => it.warehouse))].join('、')}</dd></div>
            <div><dt>最晚預計出貨</dt><dd>${o.items.map((it) => it.deliveryDate).sort().pop()}</dd></div>
          </dl>
        </section>

        <section class="op__section" id="sec-history">
          <div class="op__section-head"><h4>活動紀錄</h4></div>
          <ol class="timeline">
            ${o.history.slice().reverse().map((h) => `<li><time>${h.date}</time><span>${esc(h.text)}</span></li>`).join('')}
          </ol>
        </section>
      </article>`;
    body.scrollTop = keepScroll;
  }

  function syncMidSelection() {
    $$('#mid-body .tbl__row').forEach((tr) => {
      const sel = Number(tr.dataset.item) === state.itemId;
      tr.classList.toggle('is-selected', sel);
      if (sel) tr.setAttribute('aria-current', 'true');
      else tr.removeAttribute('aria-current');
    });
  }

  /* ---------- 第三欄：子詳情／編輯表單 ---------- */
  function renderEnd() {
    const o = findOrder(state.orderId);
    const it = findItem(o, state.itemId);
    const body = $('#end-body');
    if (!it) {
      state.rendered.end = null;
      body.innerHTML = '';
      return;
    }
    state.rendered.end = o.id + '/' + it.id;
    state.dirty = false;
    $('#end-title').textContent = it.name;
    $('#end-sub').textContent = `${o.id} · 第 ${it.id} 項`;

    const idx = o.items.indexOf(it);
    const prev = o.items[idx - 1];
    const next = o.items[idx + 1];
    const locked = isLocked(o);
    const dis = locked ? ' disabled' : '';

    body.innerHTML = `
      <form class="form" id="item-form" novalidate>
        <div class="product">
          <div class="product__img" aria-hidden="true">${esc(it.name.slice(0, 2))}</div>
          <div>
            <div class="product__name">${esc(it.name)}</div>
            <div class="muted mono">${it.sku} · 計價單位：${it.unit}</div>
          </div>
        </div>

        ${locked ? `<p class="notice">此訂單已${statusOf(o.status).label}，明細無法修改。</p>` : ''}

        <fieldset class="form__group">
          <legend>數量與價格</legend>
          <div class="form__grid">
            <label class="field"><span>數量 <em aria-hidden="true">*</em></span>
              <input type="number" name="qty" min="1" step="1" value="${it.qty}" required${dis}>
              <small class="field__err" data-err="qty"></small>
            </label>
            <label class="field"><span>單價（NT$）</span>
              <input type="number" name="price" min="0" step="1" value="${it.price}"${dis}>
              <small class="field__err" data-err="price"></small>
            </label>
            <label class="field"><span>折扣</span>
              <select name="discount"${dis}>
                ${[0, 5, 10, 15, 20, 30].map((d) => `<option value="${d}"${d === it.discount ? ' selected' : ''}>${d ? d + '%' : '無'}</option>`).join('')}
              </select>
            </label>
          </div>
        </fieldset>

        <fieldset class="form__group">
          <legend>出貨</legend>
          <div class="form__grid">
            <label class="field"><span>出貨倉</span>
              <select name="warehouse"${dis}>
                ${WAREHOUSES.map((w) => `<option${w === it.warehouse ? ' selected' : ''}>${w}</option>`).join('')}
              </select>
            </label>
            <label class="field"><span>預計出貨日</span>
              <input type="date" name="deliveryDate" min="${o.orderDate}" value="${it.deliveryDate}"${dis}>
              <small class="field__err" data-err="deliveryDate"></small>
            </label>
          </div>
        </fieldset>

        <fieldset class="form__group">
          <legend>備註</legend>
          <label class="field field--full"><span class="visually-hidden">備註</span>
            <textarea name="note" rows="3" maxlength="200" placeholder="例如：需分批出貨、包裝要求…"${dis}>${esc(it.note)}</textarea>
          </label>
        </fieldset>

        <div class="summary" aria-live="polite">
          <span>明細小計</span>
          <strong id="live-total">${money(lineTotal(it))}</strong>
        </div>

        <div class="form__footer">
          <div class="pager">
            <button type="button" class="btn btn--ghost" data-item-nav="${prev ? prev.id : ''}"${prev ? '' : ' disabled'}>‹ 上一項</button>
            <button type="button" class="btn btn--ghost" data-item-nav="${next ? next.id : ''}"${next ? '' : ' disabled'}>下一項 ›</button>
          </div>
          <div class="form__actions">
            <button type="reset" class="btn btn--ghost"${dis} disabled>還原</button>
            <button type="submit" class="btn btn--primary"${dis} disabled>儲存</button>
          </div>
        </div>
      </form>`;
  }

  function readForm(form) {
    const f = new FormData(form);
    return {
      qty: Number(f.get('qty')),
      price: Number(f.get('price')),
      discount: Number(f.get('discount')),
      warehouse: String(f.get('warehouse')),
      deliveryDate: String(f.get('deliveryDate')),
      note: String(f.get('note') || '').trim(),
    };
  }

  function validate(v, order) {
    const errs = {};
    if (!Number.isInteger(v.qty) || v.qty < 1) errs.qty = '請輸入 1 以上的整數';
    if (!Number.isFinite(v.price) || v.price < 0) errs.price = '單價不可為負數';
    if (!v.deliveryDate) errs.deliveryDate = '請選擇日期';
    else if (v.deliveryDate < order.orderDate) errs.deliveryDate = '不可早於下單日 ' + order.orderDate;
    return errs;
  }

  function setDirty(form, dirty) {
    state.dirty = dirty;
    $$('button[type="submit"], button[type="reset"]', form).forEach((b) => { b.disabled = !dirty; });
  }

  /* ---------- 整體渲染 ---------- */
  function render() {
    applyLayout();
    renderMaster();
    if (state.rendered.mid !== state.orderId) renderMid();
    else syncMidSelection();
    const endKey = state.orderId && state.itemId ? state.orderId + '/' + state.itemId : null;
    if (state.rendered.end !== endKey) renderEnd();
  }

  /* ---------- 事件 ---------- */
  document.addEventListener('click', (e) => {
    const t = e.target;

    const row = t.closest('[data-order]');
    if (row) {
      const same = row.dataset.order === state.orderId;
      // 再點一次已選取的項目時保留第三欄；切換訂單則收合第三欄
      navigate({ orderId: row.dataset.order, itemId: same ? state.itemId : null, fs: same ? state.fs : null });
      return;
    }

    const tr = t.closest('[data-item]');
    if (tr) {
      navigate({ itemId: Number(tr.dataset.item), fs: state.fs === 'mid' ? null : state.fs });
      return;
    }

    const itemNav = t.closest('[data-item-nav]');
    if (itemNav && itemNav.dataset.itemNav) {
      navigate({ itemId: Number(itemNav.dataset.itemNav) });
      return;
    }

    const btn = t.closest('[data-action]');
    if (btn) {
      const { action, target } = btn.dataset;
      if (action === 'fullscreen') navigate({ fs: state.fs === target ? null : target });
      else if (action === 'close' || action === 'back') closeColumn(target);
      else if (action === 'clear-filter') {
        state.query = '';
        state.status = 'all';
        $('#search').value = '';
        renderMaster();
      }
      return;
    }

    const chip = t.closest('[data-status]');
    if (chip) {
      state.status = chip.dataset.status;
      renderMaster();
      return;
    }

    const seg = t.closest('.seg button');
    if (seg) {
      const group = seg.closest('.seg').dataset.group;
      state[group] = seg.dataset.value;
      // 重新選擇比例預設值時，清除該比例下拖曳出的自訂寬度
      Object.keys(state.custom).forEach((k) => { if (k.endsWith('|' + seg.dataset.value)) delete state.custom[k]; });
      store.set('custom', state.custom);
      store.set(group, state[group]);
      applyLayout();
      return;
    }

    const tab = t.closest('[data-scroll]');
    if (tab) {
      const sec = document.getElementById(tab.dataset.scroll);
      if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  function closeColumn(col) {
    if (col === 'mid') navigate({ orderId: null, itemId: null, fs: null });
    else if (col === 'end') navigate({ itemId: null, fs: state.fs === 'end' ? null : state.fs });
  }

  document.addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-action="status"]')) {
      const o = findOrder(state.orderId);
      o.status = t.value;
      if (o.status === 'cancelled') o.payment = '未付款';
      o.history.push({ date: new Date().toISOString().slice(0, 10), text: '狀態變更為「' + statusOf(o.status).label + '」' });
      renderMid();
      if (state.itemId) renderEnd();
      renderMaster();
      toast(`${o.id} 狀態已更新為「${statusOf(o.status).label}」`);
    }
  });

  function onFormEdit(form) {
    const v = readForm(form);
    const total = Number.isFinite(v.qty * v.price) ? v.qty * v.price * (1 - v.discount / 100) : 0;
    $('#live-total').textContent = money(total);
    setDirty(form, true);
  }

  document.addEventListener('input', (e) => {
    const form = e.target.closest('#item-form');
    if (form) onFormEdit(form);
    else if (e.target.id === 'search') {
      state.query = e.target.value;
      renderMaster();
    }
  });
  document.addEventListener('change', (e) => {
    const form = e.target.closest('#item-form');
    if (form) onFormEdit(form);
    if (e.target.id === 'sort') {
      state.sort = e.target.value;
      renderMaster();
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'item-form') return;
    e.preventDefault();
    const form = e.target;
    const o = findOrder(state.orderId);
    const it = findItem(o, state.itemId);
    const v = readForm(form);
    const errs = validate(v, o);
    $$('[data-err]', form).forEach((el) => {
      const msg = errs[el.dataset.err] || '';
      el.textContent = msg;
      const input = form.elements[el.dataset.err];
      if (input) input.setAttribute('aria-invalid', String(Boolean(msg)));
    });
    const first = Object.keys(errs)[0];
    if (first) {
      form.elements[first].focus();
      return;
    }
    Object.assign(it, v);
    setDirty(form, false);
    renderMid();
    renderMaster();
    toast(`已儲存「${it.name}」`);
  });

  document.addEventListener('reset', (e) => {
    if (e.target.id !== 'item-form') return;
    e.preventDefault();
    state.rendered.end = null;
    renderEnd();
  });

  document.addEventListener('keydown', (e) => {
    const t = e.target;
    // 明細表格列：Enter / 空白鍵開啟
    if ((e.key === 'Enter' || e.key === ' ') && t.matches('.tbl__row')) {
      e.preventDefault();
      t.click();
      return;
    }
    // 主清單：上下鍵移動焦點
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t.matches('.row')) {
      e.preventDefault();
      const rows = $$('#master-body .row');
      const i = rows.indexOf(t) + (e.key === 'ArrowDown' ? 1 : -1);
      if (rows[i]) rows[i].focus();
      return;
    }
    if (e.key === 'Escape' && !t.matches('input, textarea, select')) {
      if (state.fs) navigate({ fs: null });
      else if (state.itemId) closeColumn('end');
      else if (state.orderId) closeColumn('mid');
    }
  });

  /* ---------- 欄位分隔線拖曳 ---------- */
  function setCustom(widths) {
    state.custom[currentLayout.key] = widths;
    store.set('custom', state.custom);
    applyLayout();
  }

  $$('.sep').forEach((sep) => {
    sep.addEventListener('pointerdown', (e) => {
      const L = currentLayout;
      const [a, b] = sep.dataset.sep.split('-');
      const ia = L.visible.indexOf(a);
      const elA = colEl[a];
      const elB = colEl[b];
      const startA = elA.getBoundingClientRect().width;
      const startB = elB.getBoundingClientRect().width;
      const pair = L.widths[ia] + L.widths[ia + 1];
      const startX = e.clientX;
      sep.setPointerCapture(e.pointerId);
      fcl.classList.add('is-resizing');

      const move = (ev) => {
        const dx = ev.clientX - startX;
        const newA = Math.min(Math.max(startA + dx, MIN_COL_PX), startA + startB - MIN_COL_PX);
        const widths = L.widths.slice();
        widths[ia] = (pair * newA) / (startA + startB);
        widths[ia + 1] = pair - widths[ia];
        state.custom[L.key] = widths;
        elA.style.setProperty('--grow', String(widths[ia]));
        elB.style.setProperty('--grow', String(widths[ia + 1]));
      };
      const up = () => {
        sep.removeEventListener('pointermove', move);
        sep.removeEventListener('pointerup', up);
        sep.removeEventListener('pointercancel', up);
        fcl.classList.remove('is-resizing');
        if (state.custom[L.key]) setCustom(state.custom[L.key]);
      };
      sep.addEventListener('pointermove', move);
      sep.addEventListener('pointerup', up);
      sep.addEventListener('pointercancel', up);
    });

    sep.addEventListener('dblclick', () => {
      delete state.custom[currentLayout.key];
      store.set('custom', state.custom);
      applyLayout();
    });

    sep.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const L = currentLayout;
      const ia = L.visible.indexOf(sep.dataset.sep.split('-')[0]);
      const widths = L.widths.slice();
      const pair = widths[ia] + widths[ia + 1];
      const step = (pair * 0.03) * (e.key === 'ArrowRight' ? 1 : -1);
      widths[ia] = Math.min(Math.max(widths[ia] + step, pair * 0.15), pair * 0.85);
      widths[ia + 1] = pair - widths[ia];
      setCustom(widths);
    });
  });

  /* ---------- 主題 ---------- */
  const root = document.documentElement;
  const savedTheme = store.get('theme', null);
  if (savedTheme) root.dataset.theme = savedTheme;
  $('#theme-toggle').addEventListener('click', () => {
    const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
    root.dataset.theme = dark ? 'light' : 'dark';
    store.set('theme', root.dataset.theme);
  });

  /* ---------- 斷點變化 ---------- */
  let resizeRaf;
  window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (getDevice() !== state.device) applyLayout();
    });
  });

  /* ---------- 啟動 ---------- */
  window.addEventListener('beforeunload', (e) => {
    if (state.dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  Object.assign(state, parseHash());
  fcl.classList.add('no-anim');
  render();
  requestAnimationFrame(() => requestAnimationFrame(() => fcl.classList.remove('no-anim')));
})();
