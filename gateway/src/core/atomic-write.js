'use strict';

/**
 * Synchronous atomic file writer (write temp file + set mode + rename).
 * Ensures readers always see either the complete previous file or the complete new file.
 */

const fs = require('fs');
const path = require('path');

let counter = 0;

/**
 * Write content atomically to filePath.
 * @param {string} filePath
 * @param {string|Buffer} content
 * @param {{mode?: number, encoding?: BufferEncoding}} [options]
 */
function writeFileAtomicSync(filePath, content, options = {}) {
  const dir = path.dirname(filePath);
  const mode = Number.isInteger(options.mode) ? options.mode : 0o644;
  const encoding = options.encoding || 'utf8';
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {}
  counter = (counter + 1) & 0xffff;
  const tmp = path.join(dir, '.' + path.basename(filePath) + '.tmp-' + process.pid + '-' + counter);
  try {
    if (Buffer.isBuffer(content)) {
      fs.writeFileSync(tmp, content, { mode });
    } else {
      fs.writeFileSync(tmp, content, { encoding, mode });
    }
    try {
      fs.chmodSync(tmp, mode);
    } catch {}
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw err;
  }
}

module.exports = { writeFileAtomicSync };
