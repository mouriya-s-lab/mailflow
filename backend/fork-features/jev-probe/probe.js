#!/usr/bin/env node
// Jev probe: builds the Jev decision state from MailFlow message-shaped fixtures and sends it
// to the configured Jev endpoint, once with the full structured state and once with subject
// and body only, so the effect of each field on the answers can be compared.
//
//   JEV_API_KEY=… node backend/fork-features/jev-probe/probe.js [--fixtures DIR] [--questions FILE] [--mode full|body|both] [--print-state]
//
// The probe runs outside MailFlow, so it builds the Jev client's configuration from its own
// command-line environment: JEV_API_KEY, JEV_BASE_URL and JEV_MODEL, the last two defaulting to
// the client's defaults (the Command Code provider endpoint and typesafe/jev). A fixture is the
// input of the signals module's extractSignals: { message, headers, account }.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { JEV_DEFAULTS, decide, status } from '../jev/index.js';
import { extractSignals, messageBodyText } from '../signals/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_BODY_CHARS = 20_000;

const bodyOf = ({ message }) => messageBodyText({ bodyText: message.body_text, bodyHtml: message.body_html }).slice(0, MAX_BODY_CHARS);

function fullState(fixture) {
  return { ...extractSignals(fixture), bodyText: bodyOf(fixture) };
}

function bodyOnlyState(fixture) {
  return `Subject: ${fixture.message.subject || ''}\n\n${bodyOf(fixture)}`;
}

function summarize(answer) {
  switch (answer.kind) {
    case 'noul': return answer.probability.toFixed(2);
    case 'choice': return `${answer.choice} (${answer.confidence})`;
    case 'score': return `${answer.score} (${answer.confidence})`;
    default: throw new Error(`unhandled answer kind ${answer.kind}`);
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      fixtures: { type: 'string', default: join(HERE, 'fixtures') },
      questions: { type: 'string', default: join(HERE, 'questions.json') },
      mode: { type: 'string', default: 'both' },
      'print-state': { type: 'boolean', default: false },
    },
  });
  if (!['full', 'body', 'both'].includes(values.mode)) throw new Error(`--mode must be full, body or both (got ${values.mode})`);
  const config = {
    baseUrl: process.env.JEV_BASE_URL || JEV_DEFAULTS.baseUrl,
    model: process.env.JEV_MODEL || JEV_DEFAULTS.model,
    apiKey: process.env.JEV_API_KEY || null,
  };
  const jev = status(config);
  if (jev.kind === 'unconfigured') throw new Error('JEV_API_KEY is not set');

  const questions = JSON.parse(await readFile(values.questions, 'utf8'));
  const files = (await readdir(values.fixtures)).filter(f => f.endsWith('.json')).sort();
  const modes = values.mode === 'both' ? ['full', 'body'] : [values.mode];
  const questionIds = Object.keys(questions);

  console.log(`endpoint ${jev.baseUrl}  model ${jev.model}\n`);
  console.log(['fixture', 'mode', ...questionIds, 'tokens', 'ms'].join('\t'));
  let failures = 0;
  for (const file of files) {
    const fixture = JSON.parse(await readFile(join(values.fixtures, file), 'utf8'));
    for (const mode of modes) {
      const state = mode === 'full' ? fullState(fixture) : bodyOnlyState(fixture);
      if (values['print-state']) console.log(JSON.stringify(state, null, 2));
      const started = Date.now();
      const result = await decide(config, { state: typeof state === 'string' ? state : JSON.stringify(state), questions });
      const latencyMs = Date.now() - started;
      const name = basename(file, '.json');
      if (result.kind === 'error') {
        failures++;
        console.log([name, mode, JSON.stringify(result.error)].join('\t'));
        continue;
      }
      console.log([name, mode, ...questionIds.map(id => summarize(result.answers[id])), result.inputTokens, latencyMs].join('\t'));
    }
  }
  if (failures) process.exitCode = 1;
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
