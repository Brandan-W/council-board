#!/usr/bin/env node
// Runs the local GitHub Copilot CLI as a read-only board worker.
// The CLI is invoked in prompt mode; this adapter never enables write or shell tools.
//
//   node copilot.mjs run --project <dir> (--task "<text>" | --task-file <file>)
//   node copilot.mjs consent <project> [on|off]
//   node copilot.mjs list
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { append, BOARD_DIR, projectKey, whoAmI } from './board.mjs';
import { copilotAgent, findCopilotBin } from './lib/config.mjs';
import { loadPolicy } from './lib/policy.mjs';

const HOME = path.join(BOARD_DIR, 'copilot');
const RUNS = path.join(HOME, 'runs');
const PROJECTS = path.join(HOME, 'projects.json');
const ANSWERS = ['on', 'off'];
const timeoutMs = () => loadPolicy().providers.copilot.timeoutMinutes * 60 * 1000;
const provider = () => loadPolicy().providers.copilot;
const COPILOT = () => copilotAgent()?.name || 'Copilot';

const die = (message) => {
  console.error(`copilot.mjs: ${message}`);
  process.exit(1);
};
const readJson = (file, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.${process.pid}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
};
const taskText = (opts) => {
  if (opts['task-file']) return fs.readFileSync(opts['task-file'], 'utf8').trim();
  if (opts.task) return String(opts.task).trim();
  die('give the task with --task "<text>" or --task-file <file>');
};
const args = (argv) => {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) out._.push(a);
    else if (['--write', '--auto'].includes(a)) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
};
const consentFor = (folder) => readJson(PROJECTS, {})[projectKey(folder)] || null;

export function copilotCommand({ bin, project, task }) {
  return [
    '--no-auto-update',
    '--no-color',
    '--no-ask-user',
    '--silent',
    '--output-format',
    'text',
    '--deny-tool',
    'write',
    '--deny-tool',
    'shell',
    '--disable-builtin-mcps',
    '-C',
    project,
    '--prompt',
    task,
  ];
}

function consentCommand(opts) {
  const target = opts._[1] || die('which project folder?');
  const folder = fs.realpathSync(path.resolve(target.replace(/^~(?=\/|$)/, os.homedir())));
  const answer = opts._[2];
  if (!answer) {
    const saved = consentFor(folder);
    return console.log(saved ? `Copilot for ${projectKey(folder)}: ${saved.answer}` : `Copilot for ${projectKey(folder)}: not asked yet.`);
  }
  if (!ANSWERS.includes(answer)) die(`the answer is one of: ${ANSWERS.join(', ')}`);
  const all = readJson(PROJECTS, {});
  all[projectKey(folder)] = { answer, at: Date.now(), by: opts.from || whoAmI() };
  writeJson(PROJECTS, all);
  console.log(`Recorded: Copilot is ${answer} for ${projectKey(folder)}.`);
}

function copilotBin() {
  const bin = findCopilotBin();
  if (!bin) die('Copilot CLI not found. Install it, set "bin" for the copilot agent in agents.json, or set COPILOT_BIN.');
  let help = '';
  try {
    help = requireHelp(bin);
  } catch (error) {
    die(`Copilot CLI at ${bin} did not run: ${error.message}`);
  }
  if (!help.includes('--prompt') || !help.includes('--output-format')) die(`Copilot CLI at ${bin} lacks the prompt/output interface this adapter needs.`);
  return bin;
}

function requireHelp(bin) {
  const result = spawnSync(bin, ['--help'], { encoding: 'utf8', timeout: 15000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `exited with code ${result.status}`);
  return `${result.stdout}\n${result.stderr}`;
}

function saveRun(run) {
  fs.mkdirSync(RUNS, { recursive: true });
  fs.writeFileSync(path.join(RUNS, `${run.id}.json`), JSON.stringify(run, null, 2));
}

function runningRuns() {
  if (!fs.existsSync(RUNS)) return [];
  return fs.readdirSync(RUNS)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readJson(path.join(RUNS, name), null))
    .filter((run) => run?.status === 'running');
}

async function runCommand(opts) {
  if (!provider().enabled) die('Copilot is turned off in policy.json.');
  if (opts.write) die('Copilot editing is not supported by this adapter; use a future isolated-worktree integration.');
  if (opts.auto && !provider().autoUse) die('Bringing in Copilot automatically is off in policy.json; use it only when the user asks.');
  if (runningRuns().length >= provider().maxConcurrent) die(`${runningRuns().length} Copilot runs are already going; wait for one to finish.`);
  const requested = path.resolve(String(opts.project || die('give --project <dir>')).replace(/^~(?=\/|$)/, os.homedir()));
  if (!fs.existsSync(requested) || !fs.statSync(requested).isDirectory()) die(`no such folder: ${requested}`);
  const project = fs.realpathSync(requested);
  const task = taskText(opts);
  const consent = provider().consentRequired ? consentFor(project) : { answer: 'on' };
  if (!consent) die(`Copilot hasn't been allowed for this project yet. Ask the user once, then record it with: node ${fileURLToPath(import.meta.url)} consent "${project}" on`);
  if (consent.answer !== 'on') die(`Copilot is off for this project.`);
  const bin = copilotBin();
  const id = `cp-${Date.now().toString(36)}`;
  const run = { id, title: (opts.title || task.split('\n')[0]).replace(/\s+/g, ' ').slice(0, 80), from: opts.from || whoAmI(), project: projectKey(project), folder: project, status: 'running', startedAt: Date.now(), task: task.slice(0, 4000), bin };
  saveRun(run);
  append({ from: COPILOT(), project: run.project, kind: 'message', to: run.from, text: `Copilot started "${run.title}" (run ${id}) in read-only prompt mode.` });
  const child = spawn(bin, copilotCommand({ bin, project, task: `You are ${COPILOT()}, working for ${run.from} through the local council-board. Read the project and answer the task. Do not edit files or run commands.\\n\\nTASK:\\n${task}` }), { cwd: project, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      resolve('timeout');
    }, timeoutMs());
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
  const message = stdout.trim().slice(-4000);
  run.status = code === 0 ? 'done' : code === 'timeout' ? 'timed-out' : 'failed';
  run.endedAt = Date.now();
  run.seconds = Math.round((run.endedAt - run.startedAt) / 1000);
  run.lastMessage = message;
  run.error = code === 0 ? null : (stderr.trim() || `Copilot exited with code ${code}`).slice(-1000);
  saveRun(run);
  append({ from: COPILOT(), project: run.project, kind: 'message', to: run.from, text: `Copilot ${run.status} "${run.title}" (run ${id}, ${run.seconds}s).\\n\\n${message || run.error || '(no response)'}` });
  if (code !== 0) die(run.error || `Copilot exited with code ${code}`);
  console.log(message || '(no response)');
}

function listCommand() {
  const runs = fs.existsSync(RUNS) ? fs.readdirSync(RUNS).filter((n) => n.endsWith('.json')).sort().reverse() : [];
  for (const file of runs.slice(0, 30)) {
    const run = readJson(path.join(RUNS, file), null);
    if (run) console.log(`${run.id}  ${run.status}  ${run.folder}  "${run.title}"`);
  }
}

const opts = args(process.argv.slice(2));
const commands = { run: runCommand, consent: consentCommand, list: listCommand };
const command = commands[opts._[0]];
if (!command) die('use run, consent or list');
try {
  await command(opts);
} catch (error) {
  die(error.message);
}
