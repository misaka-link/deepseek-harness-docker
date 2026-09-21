// 阶段 6 前端在页内自检（由 scripts/remote-shot-admin.mjs 以 pre-eval 方式执行）
// 返回 JSON 字符串，供 shell 断言。
(async () => {
  const out = {};

  // P14：程序化切换 Tab 后，对应按钮必须高亮（不再依赖 window.event）
  out.tabHighlight = {};
  for (const t of ['tab-dsh', 'tab-plugins', 'tab-desktop', 'tab-snapshots', 'tab-settings']) {
    try {
      switchTab(t);
      const active = document.querySelector('.tab-btn.active');
      const pane = document.getElementById(t);
      out.tabHighlight[t] = {
        btn: active ? (active.getAttribute('onclick') || '').includes(`'${t}'`) : false,
        pane: !!(pane && pane.classList.contains('active'))
      };
    } catch (e) { out.tabHighlight[t] = { error: e.message }; }
  }
  switchTab('tab-snapshots');

  // P10：全站 fetch 超时包装 + 轮询守卫是否存在
  out.guardedPoll = typeof guardedPoll === 'function';
  out.fetchTimeoutPatched = typeof __DEFAULT_FETCH_TIMEOUT_MS === 'number';

  // P8：重叠调用 askConfirm，第一个 Promise 必须立即以 false 结算（不得永久 pending）
  out.hasAskConfirm = typeof askConfirm === 'function';
  if (out.hasAskConfirm) {
    try {
      const p1 = askConfirm({ title: '重叠测试-1', bodyHtml: '<div>1</div>' });
      const p2 = askConfirm({ title: '重叠测试-2', bodyHtml: '<div>2</div>' });
      out.overlapFirst = await Promise.race([
        p1.then(v => 'settled:' + v),
        new Promise(r => setTimeout(() => r('pending'), 500))
      ]);
      closeActionConfirm(false);
      try { closeActionConfirm(false); } catch (e) {}
      void p2;
    } catch (e) { out.overlapFirst = 'error:' + e.message; }
  }

  // P4：确认弹窗内的 .modal-box 可被精确定位
  out.confirmModalBox = !!document.querySelector('#confirmModal .modal-box');

  // P12：快照删除/还原函数存在（已改为 askConfirm + res.ok 检查）
  out.hasDeleteSnapshot = typeof deleteSnapshot === 'function';
  out.hasRestoreSnapshot = typeof restoreSnapshot === 'function';

  // 关键 DOM 未损坏
  out.tabBtnCount = document.querySelectorAll('.tab-btn').length;
  out.toastHost = !!document.getElementById('toastHost');

  return JSON.stringify(out);
})()
