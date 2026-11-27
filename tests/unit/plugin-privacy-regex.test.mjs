#!/usr/bin/env node
/**
 * 插件隐私正则与护栏回归测试（plugins/dsh-container-helper/client.js）。
 * 用法: node tests/unit/plugin-privacy-regex.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const target = path.join(root, 'plugins', 'dsh-container-helper', 'client.js');
const src = fs.readFileSync(target, 'utf8');

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
  if (cond) { pass++; console.log('   ✔ ' + name + (extra ? '（' + extra + '）' : '')); }
  else { fail++; console.log('   ✘ ' + name + (extra ? '（' + extra + '）' : '')); }
};

const bodyLit = src.match(/const PHONE_BODY = ('[^']*');/);
const reExpr = src.match(/const PHONE_RE = (new RegExp\([^;]*\));/);
ok('可解析出 PHONE_BODY', !!bodyLit);
ok('可解析出 PHONE_RE 构造式', !!reExpr);

let PHONE_BODY = '';
if (bodyLit) PHONE_BODY = eval(bodyLit[1]);
let PHONE_RE = /$^/;
if (reExpr && PHONE_BODY) PHONE_RE = eval(reExpr[1]);

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
  ['order 1381234567890', false, '13 位订单号']
];
for (const [text, want, name] of cases) {
  ok(name, PHONE_RE.test(text) === want, `${JSON.stringify(text)} -> ${PHONE_RE.test(text)}`);
}

ok('存在 isProtected() 护栏', src.includes('function isProtected('));
ok('applySensitiveEl 调用 isProtected', /function applySensitiveEl[\s\S]{0,900}isProtected\(el\)/.test(src));
ok('scanAll 走 applySensitiveEl', /function scanAll[\s\S]{0,600}applySensitiveEl\(el\)/.test(src));
ok('DOM 变化同步增量打码', !/setTimeout\(refreshSensitive/.test(src) && /MutationObserver\(\(mutations\)/.test(src) && /m\.addedNodes/.test(src));
ok('characterData 变更就地重扫', /characterData[\s\S]{0,220}applySensitiveEl\(m\.target\.parentElement\)/.test(src));
ok('双击处理调用 inEditable', /dblclick[\s\S]{0,500}inEditable\(t\)/.test(src));
const dialogRenders = src.split('s.open ? React.createElement(SignInDialog) : null').length - 1;
ok('弹窗仅由 shell.overlay 单例渲染', dialogRenders === 1, 'occurrences=' + dialogRenders);
ok('已注册 settings.models.sign-in (priority: -1)', /name: 'settings\.models\.sign-in'[^}]*priority: -1/.test(src));
ok('apply() 阶段即注入样式', /function apply\(ctx\)[\s\S]{0,220}ensureStyles\(\);/.test(src));
ok('两项功能都关时不挂 MutationObserver', /watchDomForAutoBlur[\s\S]{0,300}blurByDefault && !prefs\.nickname/.test(src));

console.log(`\n===== 汇总: 通过 ${pass} / 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
