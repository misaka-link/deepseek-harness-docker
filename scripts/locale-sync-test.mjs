#!/usr/bin/env node
/**
 * Issue #17：DSH 语言 -> Chromium UI 语言 同步模块单元测试。
 * 运行：node scripts/locale-sync-test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const {
  mapLocale,
  parseLocalePreferenceMinimal,
  readLocalePreference,
  resolveDesktopLang,
  __resetCacheForTest,
} = require('../gateway/locale-sync.js');

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (detail ? '  ' + detail : '')); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, 'got=' + JSON.stringify(actual) + ' want=' + JSON.stringify(expected));
}

console.log('== mapLocale ==');
eq(mapLocale('zh'), 'zh-CN', 'zh -> zh-CN');
eq(mapLocale('zh_CN'), 'zh-CN', 'zh_CN -> zh-CN');
eq(mapLocale('zh-Hans'), 'zh-CN', 'zh-Hans -> zh-CN');
eq(mapLocale('zh-TW'), 'zh-TW', 'zh-TW -> zh-TW');
eq(mapLocale('zh_HK'), 'zh-TW', 'zh_HK -> zh-TW');
eq(mapLocale('en'), 'en-US', 'en -> en-US');
eq(mapLocale('en_US'), 'en-US', 'en_US -> en-US');
eq(mapLocale('en-GB'), 'en-GB', 'en-GB -> en-GB');
eq(mapLocale('ja'), 'ja', 'ja -> ja');
eq(mapLocale('es'), 'es', 'es -> es');
eq(mapLocale('fr'), 'fr', 'fr -> fr');
eq(mapLocale('de'), 'de', 'de -> de');
eq(mapLocale('ru'), 'ru', 'ru -> ru');
eq(mapLocale('pt'), 'pt-BR', 'pt -> pt-BR');
eq(mapLocale('pt-BR'), 'pt-BR', 'pt-BR -> pt-BR');
eq(mapLocale('ko'), '', 'ko -> empty');
eq(mapLocale(''), '', 'empty -> empty');
eq(mapLocale(null), '', 'null -> empty');

console.log('== minimal parser ==');
const sample = [
  '# comment line',
  '- id: ui-theme',
  '  config:',
  '    preference: dark',
  '- id: locale',
  '  name: "@deepseek-ai/dsh-client-locale"',
  '  config:',
  '    preference: zh',
  '- id: other',
  '  config:',
  '    preference: en',
  '',
].join('\n');
eq(parseLocalePreferenceMinimal(sample), 'zh', 'minimal parser picks locale.preference');
eq(parseLocalePreferenceMinimal('# nothing\n[]\n'), '', 'minimal parser empty doc');
eq(parseLocalePreferenceMinimal("- id: locale\n  config:\n    preference: 'en-US'\n"), 'en-US', 'quoted preference');
const dup = [
  '- id: locale',
  '  config:',
  '    preference: zh',
  '- id: locale',
  '  config:',
  '    preference: en',
  '',
].join('\n');
eq(parseLocalePreferenceMinimal(dup), 'en', 'duplicate locale id -> last wins');

console.log('== read/resolve with temp DSH_DIR ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-sync-test-'));
const profileDir = path.join(tmp, 'profiles', 'web');
fs.mkdirSync(profileDir, { recursive: true });
const patchFile = path.join(profileDir, 'cordis.patch.yml');
fs.writeFileSync(patchFile, sample);
const oldDir = process.env.DSH_DIR;
const oldHome = process.env.DSH_HOME;
const oldOverride = process.env.DSH_DESKTOP_LANG;
process.env.DSH_DIR = tmp;
delete process.env.DSH_HOME;
delete process.env.DSH_DESKTOP_LANG;
__resetCacheForTest();
eq(readLocalePreference(), 'zh', 'readLocalePreference = zh');
eq(resolveDesktopLang(), 'zh-CN', 'resolveDesktopLang = zh-CN');

fs.writeFileSync(patchFile, sample.replace('preference: zh', 'preference: en'));
__resetCacheForTest();
eq(resolveDesktopLang(), 'en-US', 'after patch en -> en-US');

// Home 层补丁优先级更高（后合并）
fs.writeFileSync(path.join(tmp, 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: ja\n');
__resetCacheForTest();
eq(readLocalePreference(), 'ja', 'home patch overrides profile patch');
eq(resolveDesktopLang(), 'ja', 'home patch ja -> ja');

// 多 profile：web 优先，不能被排序在后的其它 profile 覆盖
const tmpMulti = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-multi-'));
fs.mkdirSync(path.join(tmpMulti, 'profiles', 'web'), { recursive: true });
fs.mkdirSync(path.join(tmpMulti, 'profiles', 'aaa'), { recursive: true });
fs.writeFileSync(path.join(tmpMulti, 'profiles', 'web', 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: zh\n');
fs.writeFileSync(path.join(tmpMulti, 'profiles', 'aaa', 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: en\n');
process.env.DSH_DIR = tmpMulti;
delete process.env.DSH_HOME;
__resetCacheForTest();
eq(resolveDesktopLang(), 'zh-CN', 'web profile wins over other profiles');
fs.rmSync(tmpMulti, { recursive: true, force: true });

// DSH_HOME 已指向 .dsh 时不应双拼
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-home-'));
const tmpHome = path.join(tmpRoot, '.dsh');
fs.mkdirSync(path.join(tmpHome, 'profiles', 'web'), { recursive: true });
fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: fr\n');
process.env.DSH_HOME = tmpHome;
delete process.env.DSH_DIR;
__resetCacheForTest();
eq(resolveDesktopLang(), 'fr', 'DSH_HOME pointing at .dsh works without double join');

// 显式覆盖优先
process.env.DSH_DESKTOP_LANG = 'en-GB';
eq(resolveDesktopLang(), 'en-GB', 'DSH_DESKTOP_LANG override wins');

if (oldDir === undefined) delete process.env.DSH_DIR; else process.env.DSH_DIR = oldDir;
if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
if (oldOverride === undefined) delete process.env.DSH_DESKTOP_LANG; else process.env.DSH_DESKTOP_LANG = oldOverride;
fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(tmpRoot, { recursive: true, force: true });

console.log('\nRESULT: PASS=' + pass + ' FAIL=' + fail);
if (fail) process.exit(1);
