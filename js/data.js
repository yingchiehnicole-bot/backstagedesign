/* 模擬資料：以固定種子產生，讓每次載入結果一致 */
(function () {
  'use strict';

  let seed = 20261001;
  function rand() {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  }
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (min, max) => Math.floor(rand() * (max - min + 1)) + min;

  const STATUSES = [
    { key: 'pending', label: '待確認', tone: 'warn' },
    { key: 'processing', label: '處理中', tone: 'info' },
    { key: 'shipped', label: '已出貨', tone: 'ok' },
    { key: 'cancelled', label: '已取消', tone: 'muted' },
  ];

  const WAREHOUSES = ['台北一倉', '桃園物流中心', '台中二倉', '高雄港倉'];

  const CUSTOMERS = [
    '晨光文具股份有限公司', '海波科技有限公司', '綠野生活百貨', '城市咖啡連鎖',
    '北辰精密工業', '采風設計工作室', '大川餐飲集團', '星澄電子', '禾田有機農場',
    '藍鯨運動用品', '雲端教育學苑', '映畫影像製作',
  ];
  const SALES = ['林雅婷', '陳冠宇', '張書豪', '王怡君', '黃柏翰'];
  const PAYMENTS = ['已付款', '未付款', '部分付款'];

  const PRODUCTS = [
    { sku: 'NB-1402', name: '14 吋輕薄筆電', price: 32900, unit: '台' },
    { sku: 'MN-2701', name: '27 吋 4K 螢幕', price: 11900, unit: '台' },
    { sku: 'KB-0088', name: '無線機械鍵盤', price: 3290, unit: '組' },
    { sku: 'MS-0310', name: '人體工學滑鼠', price: 1590, unit: '個' },
    { sku: 'HD-0512', name: '降噪耳機', price: 6990, unit: '副' },
    { sku: 'DK-1100', name: 'USB-C 擴充底座', price: 4590, unit: '個' },
    { sku: 'CH-5500', name: '電競人體工學椅', price: 12800, unit: '張' },
    { sku: 'DS-1600', name: '電動升降桌', price: 15600, unit: '張' },
    { sku: 'WC-0720', name: '1080p 視訊攝影機', price: 2490, unit: '台' },
    { sku: 'SS-2000', name: '2TB 外接 SSD', price: 5290, unit: '個' },
  ];

  function isoDate(base, offsetDays) {
    const d = new Date(base);
    d.setDate(d.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  }

  const today = new Date('2026-10-01T00:00:00');
  const orders = [];

  for (let i = 0; i < 28; i++) {
    const status = pick(STATUSES).key;
    const orderDate = isoDate(today, -between(0, 60));
    const itemCount = between(1, 6);
    const used = new Set();
    const items = [];
    for (let j = 0; j < itemCount; j++) {
      let p;
      do { p = pick(PRODUCTS); } while (used.has(p.sku));
      used.add(p.sku);
      items.push({
        id: j + 1,
        sku: p.sku,
        name: p.name,
        unit: p.unit,
        qty: between(1, 20),
        price: p.price,
        discount: pick([0, 0, 0, 5, 10, 15]),
        warehouse: pick(WAREHOUSES),
        deliveryDate: isoDate(new Date(orderDate), between(3, 21)),
        note: '',
      });
    }
    orders.push({
      id: 'SO-' + String(10230 + i),
      customer: pick(CUSTOMERS),
      sales: pick(SALES),
      status,
      payment: status === 'cancelled' ? '未付款' : pick(PAYMENTS),
      orderDate,
      address: pick(['台北市信義區松仁路 100 號', '新北市板橋區文化路一段 25 號', '台中市西屯區市政路 386 號', '高雄市前鎮區成功二路 88 號', '桃園市中壢區中大路 300 號']),
      contact: pick(['0912-345-678', '0922-118-305', '0935-770-142', '0988-562-019']),
      items,
      history: [
        { date: orderDate, text: '訂單建立' },
        ...(status !== 'pending' ? [{ date: isoDate(new Date(orderDate), 1), text: status === 'cancelled' ? '訂單取消' : '已確認，進入撿貨流程' }] : []),
        ...(status === 'shipped' ? [{ date: isoDate(new Date(orderDate), 3), text: '已交付物流出貨' }] : []),
      ],
    });
  }

  window.FCL_DATA = { orders, STATUSES, WAREHOUSES, SALES };
})();
