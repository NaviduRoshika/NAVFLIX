#!/usr/bin/env node
'use strict';

// Syntax-checks the app before you run it:
//   node check.js       (or: npm run check)
//
// server.js is caught by node itself, but the dashboard's JavaScript lives inside
// public/index.html, where a single bad string literal silently blanks the whole
// page. This extracts that script and parses it properly.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;
let failed = 0;

function ok(msg) { console.log('  ✓ ' + msg); }
function bad(msg, err) {
  failed++;
  console.log('  ✗ ' + msg);
  if (err) console.log('      ' + String(err.message || err).split('\n')[0]);
}

// --- the modules -----------------------------------------------------------
['server.js', 'probe.js', 'qr.js'].forEach((file) => {
  try {
    new vm.Script(fs.readFileSync(path.join(ROOT, file), 'utf8'), { filename: file });
    ok(file + ' parses');
  } catch (e) {
    bad(file + ' has a syntax error', e);
  }
});

// --- inline scripts in the pages ------------------------------------------
function checkPage(rel) {
  try {
    const html = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    const blocks = html.match(/<script>([\s\S]*?)<\/script>/g) || [];
    if (!blocks.length) {
      bad(rel + ' contains no <script> block');
      return;
    }
    blocks.forEach((block, i) => {
      const code = block.replace(/^<script>/, '').replace(/<\/script>$/, '');
      // Line offset so the reported line number matches the HTML file.
      const before = html.slice(0, html.indexOf(block));
      const offset = before.split('\n').length;
      try {
        new vm.Script(code, { filename: rel, lineOffset: offset });
        ok(rel + ' script #' + (i + 1) + ' parses (' + code.split('\n').length + ' lines)');
      } catch (e) {
        bad(rel + ' script #' + (i + 1) + ' has a syntax error', e);
      }
    });
  } catch (e) {
    bad('could not read ' + rel, e);
  }
}

checkPage('public/index.html');
checkPage('public/remote.html');

console.log('');
if (failed) {
  console.log('  ' + failed + ' problem(s). NAVFLIX would not start correctly.');
  process.exit(1);
}
console.log('  All good.');
