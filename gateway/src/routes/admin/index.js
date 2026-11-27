'use strict';

/**
 * Aggregated Admin API router combining all domain admin route tables.
 */

const { createRouter } = require('../../http/router');
const { sendError } = require('../../http/respond');
const { AppError } = require('../../i18n/errors');

const statusRoutes = require('./status');
const versionRoutes = require('./version');
const dshVersionsRoutes = require('./dsh-versions');
const dshRollbackRoutes = require('./dsh-rollback');
const dshLifecycleRoutes = require('./dsh-lifecycle');
const desktopRoutes = require('./desktop');
const snapshotsRoutes = require('./snapshots');
const pluginsRoutes = require('./plugins');
const configRoutes = require('./config');
const maintenanceRoutes = require('./maintenance');

const ALL_ADMIN_ROUTES = [
  ...statusRoutes,
  ...versionRoutes,
  ...dshVersionsRoutes,
  ...dshRollbackRoutes,
  ...dshLifecycleRoutes,
  ...desktopRoutes,
  ...snapshotsRoutes,
  ...pluginsRoutes,
  ...configRoutes,
  ...maintenanceRoutes
];

function createAdminRouter() {
  const router = createRouter(ALL_ADMIN_ROUTES);

  async function handleAdminApi(req, res, pathname, query, ctx) {
    const subPath = pathname.slice(ctx.runtimeConfig.adminPath.length);
    const matched = await router.dispatch(req, res, subPath, { ...ctx, query });
    if (!matched) {
      return sendError(res, req, new AppError('NOT_FOUND', {}, 404, 'NOT_FOUND'));
    }
  }

  return {
    handleAdminApi,
    routes: router.routes
  };
}

module.exports = {
  ALL_ADMIN_ROUTES,
  createAdminRouter
};
