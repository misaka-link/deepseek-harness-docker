#!/usr/bin/env node
/**
 * DSH 偏好读取（8 语言 + ui-theme）与 Chromium --lang 映射单元测试。
 * 用法: node tests/unit/locale-sync.test.mjs
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const {
  mapLocale,
  parseLocalePreferenceMinimal,
  parseThemePreferenceMinimal,
  readLocalePreference,
  readThemePreference,
  resolveDesktopLang,
  __resetCacheForTest
} = require(path.join(root, 'gateway/src/prefs/dsh-prefs.js'));

let pass = 0, fail = 0;
function ok(cond, name, detail = '') {
  if (cond) { pass++; console.log('  ✔ ' + name); }
  else { fail++; console.log('  ✘ ' + name + (detail ? '  ' + detail : '')); }
}
const eq = (actual, expected, name) => ok(actual === expected, name, `got=${JSON.stringify(actual)} want=${JSON.stringify(expected)}`);

console.log('== mapLocale ==');
for (const [inp, exp] of [
  ['zh', 'zh-CN'], ['zh_CN', 'zh-CN'], ['zh-Hans', 'zh-CN'],
  ['zh-TW', 'zh-TW'], ['zh_HK', 'zh-TW'],
  ['en', 'en-US'], ['en_US', 'en-US'], ['en-GB', 'en-GB'],
  ['ja', 'ja'], ['es', 'es'], ['fr', 'fr'], ['de', 'de'], ['ru', 'ru'],
  ['pt', 'pt-BR'], ['pt-BR', 'pt-BR'],
  ['ko', ''], ['', ''], [null, '']
]) {
  eq(mapLocale(inp), exp, `${String(inp)} -> ${JSON.stringify(exp)}`);
}

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
  ''
].join('\n');
eq(parseLocalePreferenceMinimal(sample), 'zh', 'minimal parser picks locale.preference');
eq(parseThemePreferenceMinimal(sample), 'dark', 'minimal parser picks ui-theme.preference');
eq(parseLocalePreferenceMinimal('# nothing\n[]\n'), '', 'minimal parser empty doc');
eq(parseLocalePreferenceMinimal("- id: locale\n  config:\n    preference: 'en-US'\n"), 'en-US', 'quoted preference');
eq(parseLocalePreferenceMinimal('- id: locale\n  config:\n    preference: zh\n- id: locale\n  config:\n    preference: en\n'), 'en', 'duplicate locale id -> last wins');

console.log('== read/resolve with temp DSH_DIR ==');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-sync-test-'));
const tmpMulti = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-multi-'));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'locale-home-'));
const oldDir = process.env.DSH_DIR;
const oldHome = process.env.DSH_HOME;
const oldOverride = process.env.DSH_DESKTOP_LANG;

try {
  const profileDir = path.join(tmp, 'profiles', 'web');
  fs.mkdirSync(profileDir, { recursive: true });
  const patchFile = path.join(profileDir, 'cordis.patch.yml');
  fs.writeFileSync(patchFile, sample);
  process.env.DSH_DIR = tmp;
  delete process.env.DSH_HOME;
  delete process.env.DSH_DESKTOP_LANG;
  __resetCacheForTest();
  eq(readLocalePreference(), 'zh', 'readLocalePreference = zh');
  eq(readThemePreference(), 'dark', 'readThemePreference = dark');
  eq(resolveDesktopLang(), 'zh-CN', 'resolveDesktopLang = zh-CN');

  fs.writeFileSync(patchFile, sample.replace('preference: zh', 'preference: en'));
  __resetCacheForTest();
  eq(resolveDesktopLang(), 'en-US', 'after patch en -> en-US');

  fs.writeFileSync(path.join(tmp, 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: ja\n- id: ui-theme\n  config:\n    preference: light\n');
  __resetCacheForTest();
  eq(readLocalePreference(), 'ja', 'home patch overrides profile locale');
  eq(readThemePreference(), 'light', 'home patch overrides profile theme');
  eq(resolveDesktopLang(), 'ja', 'home patch ja -> ja');

  fs.mkdirSync(path.join(tmpMulti, 'profiles', 'web'), { recursive: true });
  fs.mkdirSync(path.join(tmpMulti, 'profiles', 'aaa'), { recursive: true });
  fs.writeFileSync(path.join(tmpMulti, 'profiles', 'web', 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: zh\n');
  fs.writeFileSync(path.join(tmpMulti, 'profiles', 'aaa', 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: en\n');
  process.env.DSH_DIR = tmpMulti;
  __resetCacheForTest();
  eq(resolveDesktopLang(), 'zh-CN', 'web profile wins over other profiles');

  const tmpHome = path.join(tmpRoot, '.dsh');
  fs.mkdirSync(path.join(tmpHome, 'profiles', 'web'), { recursive: true });
  fs.writeFileSync(path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'), '- id: locale\n  config:\n    preference: fr\n');
  process.env.DSH_HOME = tmpHome;
  delete process.env.DSH_DIR;
  __resetCacheForTest();
  eq(resolveDesktopLang(), 'fr', 'DSH_HOME pointing at .dsh works without double join');

  process.env.DSH_DESKTOP_LANG = 'en-GB';
  eq(resolveDesktopLang(), 'en-GB', 'DSH_DESKTOP_LANG override wins');
} finally {
  if (oldDir === undefined) delete process.env.DSH_DIR; else process.env.DSH_DIR = oldDir;
  if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome;
  if (oldOverride === undefined) delete process.env.DSH_DESKTOP_LANG; else process.env.DSH_DESKTOP_LANG = oldOverride;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(tmpMulti, { recursive: true, force: true });
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}

console.log('\nRESULT: PASS=' + pass + ' FAIL=' + fail);
if (fail) process.exit(1);
