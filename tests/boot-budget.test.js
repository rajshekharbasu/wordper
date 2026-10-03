'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'script.js'), 'utf8');

const tags = [...html.matchAll(/<script\b([^>]*)>/gi)].map((match) => match[1]);
const srcTags = tags.filter((attrs) => /\ssrc=/.test(attrs));

assert.ok(srcTags.length >= 4, 'boot document should still load the app scripts');
for (const attrs of srcTags) {
    assert.match(attrs, /\sdefer\b/, `boot script is parser-blocking: ${attrs}`);
}

assert.equal(html.includes('matter'), false, 'matter.min.js must not be on the boot document');
assert.match(app, /cdnjs\.cloudflare\.com\/ajax\/libs\/matter-js\/0\.19\.0\/matter\.min\.js/);
assert.match(app, /function loadMatterScript\(/);

console.log(`ok boot scripts are deferred (${srcTags.length}) and matter is not on the boot document`);
