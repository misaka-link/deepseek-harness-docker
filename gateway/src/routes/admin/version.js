'use strict';

/**
 * Admin suite & DSH version check endpoint:
 *   GET ${ADMIN_PATH}/api/version/check
 */

const { sendJson } = require('../../http/respond');

const routes = [
  {
    method: 'GET',
    path: '/api/version/check',
    async handler({ res, query, versionService, dshManager }) {
      const force = query.get('refresh') === '1';
      const checkRes = await versionService.check(force, dshManager);
      checkRes.isRemoteMeta = versionService.isUsingRemoteMeta();
      return sendJson(res, 200, checkRes);
    }
  }
];

module.exports = routes;
