#!/usr/bin/env node
/**
 * 插件隐私正则与护栏回归测试（对应 gemini 交叉审计发现 1 / 2 / 3 / 6）
 *
 * 直接从 plugins/dsh-deepseek-remote-login/client.js「还原」出运行时真正使用的 PHONE_RE，
 * 因此任何改动插件正则都会在这里被立刻检出：
 *   - 必须命中：完整手机号、DSH 打码号（186******50 / 186********50）
 *   - 必须不命中：13 位毫秒时间戳、长订单号、哈希混合串（否则会误伤上游双击重命名与选词）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'plugins', 'dsh-deepseek-remote-login', 'client.js');
const src = fs.readFileSync(target, 'utf8');

let pass = 0;
let fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('   ✔ ' + name + (extra ? '（' + extra + '）' : '')); }
  else { fail++; console.log('   ✘ ' + name + (extra ? '（' + extra + '）' : '')); }
};

console.log('===== 插件隐私正则与护栏回归测试 =====');
console.log('目标文件: ' + path.relative(path.join(here, '..'), target));

const bodyLit = src.match(/const PHONE_BODY = ('[^']*');/);
const reExpr = src.match(/const PHONE_RE = (new RegExp\([^;]*\));/);
ok('可解析出 PHONE_BODY', !!bodyLit);
ok('可解析出 PHONE_RE 构造式', !!reExpr);

let PHONE_BODY = '';
if (bodyLit) PHONE_BODY = eval(bodyLit[1]);
let PHONE_RE = /$^/;
if (reExpr && PHONE_BODY) PHONE_RE = eval(reExpr[1]);
console.log('还原的正则: ' + PHONE_RE.source);

const cases = [
  ['186******50', true, 'DSH 底栏打码号'],
  ['186********50', true, '插件卡片打码号'],
  ['13812345678', true, '完整手机号'],
  ['手机号 13812345678，请惠存', true, '中文语境'],
  ['Account: 186******50', true, '带标签的账号行'],
  ['1729000000000', false, '13 位毫秒时间戳'],
  ['订单号1729000000000 已完成', false, '时间戳夹在中文里'],
  ['commit 13812345678abcdef', false, '哈希混合串'],
  ['1234567890', false, '10 位普通数字'],
  ['order 1381234567890', false, '13 位订单号'],
];
for (const item of cases) {
  const text = item[0], want = item[1], name = item[2];
  ok(name, PHONE_RE.test(text) === want, JSON.stringify(text) + ' -> ' + PHONE_RE.test(text));
}

ok('存在 isProtected() 护栏（编辑器/输入框/代码块排除）', src.includes('function isProtected('));
ok('单元素应用 applySensitiveEl 调用 isProtected', /function applySensitiveEl[\s\S]{0,900}isProtected\(el\)/.test(src));
ok('全量扫描 scanAll 走 applySensitiveEl', /function scanAll[\s\S]{0,600}applySensitiveEl\(el\)/.test(src));
ok('DOM 变化同步增量打码（无 300ms setTimeout 防抖，避免设置页先明文后模糊）',
  !/setTimeout\(refreshSensitive/.test(src) && /MutationObserver\(\(mutations\)/.test(src) && /m\.addedNodes/.test(src));
ok('characterData 变更就地重扫（React 回写手机号后立刻重新打码）',
  /characterData[\s\S]{0,220}applySensitiveEl\(m\.target\.parentElement\)/.test(src));
ok('双击处理调用 inEditable', /dblclick[\s\S]{0,500}inEditable\(t\)/.test(src));
const dialogRenders = src.split('s.open ? React.createElement(SignInDialog) : null').length - 1;
ok('弹窗仅由 shell.overlay 单例渲染（设置区不再重复渲染）', dialogRenders === 1, 'occurrences=' + dialogRenders);
ok('已注册 settings.models.sign-in（补上官方被置空的插槽）', src.includes('settings.models.sign-in'));
ok('以 priority: -1 覆盖 single 插槽（否则同优先级注册会抛错）', /name: 'settings\.models\.sign-in'[^}]*priority: -1/.test(src));
ok('apply() 阶段即注入样式', /function apply\(ctx\)[\s\S]{0,220}ensureStyles\(\);/.test(src));
ok('两项功能都关时不挂 MutationObserver', /watchDomForAutoBlur[\s\S]{0,300}blurByDefault && !prefs\.nickname/.test(src));

console.log('\n===== 汇总: 通过 ' + pass + ' / 失败 ' + fail + ' =====');
process.exit(fail === 0 ? 0 : 1);
