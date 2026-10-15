/**
 * DeepSeek 账号登录（远程/反代）助手 —— 宿主侧。
 *
 * 本插件为纯客户端 UI 插件：宿主侧不注册工具/服务，仅作为 bundle 载体
 * 把 client.js 提供给 DSH Web（通过 package.json 的 dsh.client 声明）。
 * 登录流程本身仍由官方 dsh-deepseek-account-platform 承载。
 */
export const name = 'dsh-deepseek-remote-login';
export const inject = [];

export function apply() {
  // 无需宿主侧行为；所有交互都在 DSH Web 客户端的设置弹窗中完成。
}
