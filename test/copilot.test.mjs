import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox, succeeds, refuses } from './helpers.mjs';

const launch = (s, extra = []) => s.run('copilot.mjs', ['run', '--project', s.project, '--task', 'Inspect this isolated fixture.', ...extra]);
const consent = (s, answer = 'on') => succeeds(s.run('copilot.mjs', ['consent', s.project, answer]));
const calls = (s) => fs.existsSync(s.env.FAKE_COPILOT_CALLS) ? fs.readFileSync(s.env.FAKE_COPILOT_CALLS, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];

test('copilot: refuses before enablement or project consent', (t) => {
  const s = sandbox(t, { policy: { providers: { copilot: { enabled: false } } } });
  refuses(launch(s), /Copilot is turned off/);
  assert.deepEqual(calls(s), []);
  s.json(path.join(s.board, 'policy.json'), { providers: { copilot: { enabled: true } } });
  refuses(launch(s), /hasn't been allowed/);
  assert.equal(calls(s).length, 0);
});

test('copilot: consent off is enforced and successful runs post board events', (t) => {
  const s = sandbox(t, { policy: { providers: { copilot: { enabled: true } } } });
  consent(s, 'off');
  refuses(launch(s), /Copilot is off/);
  consent(s, 'on');
  assert.match(succeeds(launch(s)), /Fake Copilot completed/);
  const execution = calls(s).find((call) => call.args.includes('--prompt'));
  assert.ok(execution);
  assert.ok(execution.args.includes('--deny-tool') && execution.args.includes('write'));
  assert.ok(execution.args.includes('shell'));
  const events = fs.readFileSync(path.join(s.board, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.ok(events.every((event) => event.from === 'Local Copilot'));
});

test('copilot: write requests are rejected even when policy is enabled', (t) => {
  const s = sandbox(t, { policy: { providers: { copilot: { enabled: true, allowWrite: true } } } });
  consent(s);
  refuses(launch(s, ['--write']), /editing is not supported/);
});
