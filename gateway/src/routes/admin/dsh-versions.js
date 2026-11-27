'use strict';

/**
 * Admin DSH engine version listing, store management, SSE installation, and npm registry:
 *   GET    ${ADMIN_PATH}/api/dsh/versions
 *   GET    ${ADMIN_PATH}/api/dsh/versions/stats
 *   POST   ${ADMIN_PATH}/api/dsh/versions/gc
 *   DELETE ${ADMIN_PATH}/api/dsh/versions/:version
 *   POST   ${ADMIN_PATH}/api/dsh/install
 *   POST   ${ADMIN_PATH}/api/dsh/registry
 */

const { spawnSync } = require('child_process');
const gatewayConfig = require('../../config/gateway-config');
const { AppError, translateServerMessage } = require('../../i18n/errors');
const { negotiateLocale } = require('../../i18n/negotiate');
const { readJsonBody } = require('../../http/body');
const { sendJson } = require('../../http/respond');
const { openSse } = require('../../http/sse');

function validateRegistryUrl(raw) {
  const str = String(raw || '').trim();
  if (!str) return null;
  if (/[\s\r\n\0]/.test(str)) return null;
  let parsed;
  try {
    parsed = new URL(str);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed.toString().replace(/\/+$/, '');
}

function applyRegistryToPackageManagers(registryUrl) {
  if (process.env.DSH_SKIP_PM_CONFIG_SYNC === '1') return;
  for (const bin of ['npm', 'pnpm']) {
    try {
      spawnSync(bin, ['config', 'set', 'registry', registryUrl], {
        stdio: 'ignore',
        timeout: 5000
      });
    } catch {}
  }
}

const routes = [
  {
    method: 'GET',
    path: '/api/dsh/versions',
    async handler({ res, query, versionService, dshManager }) {
      const force = query.get('refresh') === '1';
      const meta = await versionService.fetchRemoteMeta(force);
      const data = await dshManager.fetchAvailableVersions(force, meta);
      if (Array.isArray(data.versions)) {
        data.versionEvaluations = {};
        for (const v of data.versions) {
          data.versionEvaluations[v] = versionService.evaluateTargetVersion(v, meta);
        }
      }
      data.isRemoteMeta = versionService.isUsingRemoteMeta();
      data.compatibility = meta.compatibilityV1 || meta.compatibility || {};
      return sendJson(res, 200, data);
    }
  },
  {
    method: 'GET',
    path: '/api/dsh/versions/stats',
    handler({ res, dshManager }) {
      return sendJson(res, 200, dshManager.getVersionsStoreStats());
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/versions/gc',
    async handler({ req, res, dshManager }) {
      const body = await readJsonBody(req);
      const keepN = Number(body && body.keepN) || undefined;
      const r = dshManager.gcVersions({ keepN, dryRun: Boolean(body && body.dryRun === true) });
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'DELETE',
    path: '/api/dsh/versions/:version',
    handler({ res, params, dshManager }) {
      const ver = String((params && params.version) || '').trim();
      if (!ver || ver.includes('/')) {
        throw new AppError('DSH_VERSION_INVALID', { version: ver }, 400);
      }
      const r = dshManager.deleteCachedVersion(ver);
      if (!r.ok) {
        if (r.errorCode) {
          throw new AppError(r.errorCode, r.params || { version: ver }, 400);
        }
        return sendJson(res, 400, r);
      }
      return sendJson(res, 200, r);
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/install',
    async handler({ req, res, versionService, dshManager }) {
      const body = await readJsonBody(req);
      const version = String((body && body.version) || '').trim();
      if (!version) {
        throw new AppError('REQ_FIELD_REQUIRED', { field: 'version' }, 400);
      }
      if (!dshManager.isValidVersion(version)) {
        throw new AppError('DSH_VERSION_INVALID', { version }, 400);
      }

      const evalRes = versionService.evaluateTargetVersion(version);
      if (evalRes && evalRes.level === 'danger') {
        if (evalRes.kind === 'engine-unsupported') {
          throw new AppError(
            'DSH_ENGINE_UNSUPPORTED',
            { version, floor: (evalRes.params && evalRes.params.floor) || '0.2.3-alpha.2' },
            400
          );
        }
        throw new AppError('DSH_VERSION_BREAKING', { version }, 400);
      }

      const sse = openSse(res, req);
      const archiveCurrent = body && body.archiveCurrent === true;
      const yesNo = translateServerMessage(sse.locale, archiveCurrent ? 'sse.install.yes' : 'sse.install.no');
      sse.log('sse.install.archiveOption', { value: yesNo });

      const r = await dshManager.installVersion(
        version,
        (prog) => sse.progress(prog),
        (line) => sse.log(line),
        { archiveCurrent }
      );

      sse.done(r);
    }
  },
  {
    method: 'POST',
    path: '/api/dsh/registry',
    async handler({ req, res, runtimeConfig, dshManager }) {
      const body = await readJsonBody(req);
      const raw = body && body.registry;
      const normalized = validateRegistryUrl(raw);
      if (!normalized) {
        throw new AppError('DSH_REGISTRY_INVALID', { registry: String(raw || '') }, 400);
      }

      const saved = gatewayConfig.mergeSaveGatewayConfig({ npmRegistry: normalized });
      if (!saved.ok) {
        throw new AppError('CONFIG_PERSIST_FAILED', {}, 500);
      }

      runtimeConfig.npmRegistry = normalized;
      if (dshManager && typeof dshManager.setNpmRegistry === 'function') {
        dshManager.setNpmRegistry(normalized);
      } else {
        applyRegistryToPackageManagers(normalized);
      }

      return sendJson(res, 200, {
        ok: true,
        registry: normalized,
        locale: negotiateLocale(req)
      });
    }
  }
];

module.exports = routes;
