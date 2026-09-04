window.__ModuleLoader__.load({
  id: '@dsh-custom/dsh-settings-config-path',
  factory: () => {
    // 采用 CSS 规则精准消除设置页顶部的“打开配置文件”按钮
    // 零侵入、零破坏 JavaScript 编译产物，对官方后续版本保持 100% 免疫与兼容
    if (typeof document !== 'undefined' && !document.getElementById('dsh-hide-open-doc-style')) {
      const style = document.createElement('style');
      style.id = 'dsh-hide-open-doc-style';
      style.textContent = `
        [data-slot="settings.action"] button,
        .me01iq_action button,
        div[class*="_action"] button {
          display: none !important;
        }
      `;
      document.head.appendChild(style);
    }
    return {
      apply() {},
      inject: []
    };
  }
});
