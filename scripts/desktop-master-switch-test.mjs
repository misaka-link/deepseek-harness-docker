/**
 * 容器浏览器「彻底开关」单元测试（无需 X 服务器，可在本地直接运行）。
 *
 * 覆盖：
 *   1. setEnabled(false) 后 start()/restart() 一律被拒绝（覆盖 AI 工具、VNC 自动唤醒、bootstrap 自举等所有入口）
 *   2. getStatus().enabled 如实反映总开关
 *   3. 插件热更新通道（applyConfig）不得翻转总开关
 *   4. 重新启用后恢复可启动
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dm = require('../gateway/desktop-manager.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('   ✔ ' + msg); pass++; }
  else { console.log('   ❌ ' + msg); fail++; throw new Error('断言失败: ' + msg); }
}

async function main() {
  console.log('\n=== 1. 停用前状态 ===');
  dm.setEnabled(true);
  ok(dm.isEnabled() === true, '初始为启用状态');
  ok(dm.getStatus().enabled === true, 'status.enabled = true');

  console.log('\n=== 2. 彻底停用后应拒绝一切启动 ===');
  dm.setEnabled(false);
  ok(dm.isEnabled() === false, '总开关已停用');
  ok(dm.getStatus().enabled === false, 'status.enabled = false');

  const r1 = await dm.start({ width: 1280, height: 720 });
  ok(r1.ok === false, 'start() 被拒绝');
  ok(r1.disabled === true, '返回 disabled 标记，便于上层给出准确提示');
  ok(typeof r1.error === 'string' && r1.error.includes('停用'), '返回可读的拒绝原因: ' + r1.error);

  const r2 = await dm.restart({ width: 1280, height: 720 });
  ok(r2.ok === false, 'restart() 同样被拒绝');

  console.log('\n=== 3. 插件热更新不得翻转总开关 ===');
  dm.applyConfig({ enabled: true });
  ok(dm.isEnabled() === false, 'applyConfig({enabled:true}) 被忽略，总开关仍为停用');
  ok(dm.getStatus().enabled === false, 'status.enabled 仍为 false');

  console.log('\n=== 4. 重新启用 ===');
  dm.setEnabled(true);
  ok(dm.isEnabled() === true, '总开关已恢复启用');
  ok(dm.getStatus().enabled === true, 'status.enabled = true');

  console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
  if (fail) process.exitCode = 1;
}

main().catch(err => { console.error('测试异常:', err.message); process.exit(1); });
