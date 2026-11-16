#!/usr/bin/env node
/**
 * The aggregate merge-gate check, in a tested script instead of inline YAML.
 *
 * The `required` job passes its whole `needs` map:
 *
 *   NEEDS: ${{ toJSON(needs) }}
 *
 * Every leg must be `success`. A failed, skipped or cancelled leg fails this
 * check: a skipped required check is reported as success by GitHub, which is
 * exactly the bypass this script exists to close. A missing or malformed map
 * is a usage error, never a pass.
 *
 * Usage:
 *   NEEDS='{"web":{"result":"success"}}' node scripts/check-required.mjs
 *   node scripts/check-required.mjs --needs '{"web":{"result":"failure"}}'
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The legs that did not succeed, formatted as `name=result`.
 *
 * @param {unknown} needs the parsed `toJSON(needs)` value
 * @returns {string[]} one message per failing leg, empty when every leg passed
 */
export function requiredFindings(needs) {
  if (needs == null || typeof needs !== 'object' || Array.isArray(needs)) {
    throw new Error('NEEDS must be the JSON object from toJSON(needs)');
  }
  const entries = Object.entries(needs);
  if (entries.length === 0) {
    throw new Error('the needs map is empty; the aggregate would pass without checking a leg');
  }
  const findings = [];
  for (const [name, job] of entries) {
    const result = job?.result;
    if (result !== 'success') findings.push(`${name}=${result ?? 'missing'}`);
  }
  return findings;
}

/**
 * Read the needs map from an argument or the environment.
 *
 * @param {{needs?: string, env?: Record<string, string|undefined>}} [options]
 * @returns {unknown}
 */
export function readNeeds({ needs, env = process.env } = {}) {
  const text = needs ?? env.NEEDS;
  if (text == null || text === '') throw new Error('NEEDS is not set; pass --needs <json> or set NEEDS');
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`NEEDS is not valid JSON: ${error.message}`);
  }
}

function parseArguments(argv) {
  const options = { needs: undefined };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--needs') {
      options.needs = argv[++index];
      if (options.needs == null) throw new Error('--needs needs a JSON object');
    } else {
      throw new Error(`unknown option ${argument}`);
    }
  }
  return options;
}

function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
    const needs = readNeeds(options);
    const findings = requiredFindings(needs);
    if (findings.length) {
      for (const finding of findings) console.error(`required: leg did not succeed: ${finding}`);
      return 1;
    }
    console.log(`required: ${Object.keys(needs).join(', ')} all succeeded`);
    return 0;
  } catch (error) {
    console.error(`required: ${error.message}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
