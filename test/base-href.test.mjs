/**
 * P-F1: one injected `<base href>` keeps a deep in-scope navigation's relative
 * URLs resolving at the app root. The helper is stamped into the worker; this
 * is the unit contract for the rule itself.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { injectBase } from '../scripts/lib/base-href.mjs';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('the base element goes inside the head, before any relative URL', () => {
  const html = '<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="assets/app.css"></head><body></body></html>';
  const rewritten = injectBase(html, 'https://host/drypoint/');
  assert.match(rewritten, /<head><base href="https:\/\/host\/drypoint\/"><meta charset/);
  assert.ok(rewritten.indexOf('<base') < rewritten.indexOf('assets/app.css'), 'the base precedes the stylesheet');
  assert.equal((rewritten.match(/<base\b/gi) ?? []).length, 1);
  // The document is otherwise byte-identical.
  assert.equal(rewritten.replace('<base href="https://host/drypoint/">', ''), html);
});

test('a head with attributes is handled and a document that has a base is left alone', () => {
  const withAttributes = injectBase('<html><head data-theme="dark"><title>x</title></head></html>', 'https://host/');
  assert.match(withAttributes, /<head data-theme="dark"><base href="https:\/\/host\/">/);

  const existing = '<html><head><base href="/already/"><title>x</title></head></html>';
  assert.equal(injectBase(existing, 'https://host/'), existing, 'one base owner');
});

test('nothing is invented for a document without a head', () => {
  const fragment = '<div id="app"></div>';
  assert.equal(injectBase(fragment, 'https://host/'), fragment);
  assert.equal(injectBase('', 'https://host/'), '');
  assert.equal(injectBase(null, 'https://host/'), null);
  assert.equal(injectBase('<html><head></head></html>', ''), '<html><head></head></html>', 'no scope, no base');
});

test('the scope is escaped into the attribute', () => {
  const rewritten = injectBase('<html><head></head></html>', 'https://host/a"b&c/');
  assert.match(rewritten, /<base href="https:\/\/host\/a&quot;b&amp;c\/">/);
});

test('the page CSP allows the one base and forbids injected objects and forms', () => {
  const html = read('index.html');
  const policy = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1] ?? '';
  assert.match(policy, /base-uri 'self'/, 'the injected base is same-origin');
  assert.doesNotMatch(policy, /base-uri 'none'/, 'a base-uri none would block the worker rewrite');
  assert.match(policy, /object-src 'none'/);
  assert.match(policy, /form-action 'none'/);
  const metaCount = (html.match(/http-equiv="Content-Security-Policy"/g) ?? []).length;
  assert.equal(metaCount, 1, 'one policy owner in the page');
  // The policy is authored once: Java must not keep a second copy.
  const activity = read('android/app/src/main/java/dev/llm4people/drypoint/MainActivity.java');
  assert.doesNotMatch(activity, /Content-Security-Policy|default-src/);
});
