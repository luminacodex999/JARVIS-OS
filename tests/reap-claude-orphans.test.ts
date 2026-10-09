import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const SCRIPT = path.join(process.cwd(), 'scripts', 'reap-claude-orphans.sh');
const NOW = 2_000_000_000;

type ProcessFixture = {
  pid: number;
  ppid: number;
  tty: string;
  etime: string;
  rss?: number;
  comm: string;
  cputime?: string;
  ignoresTerm?: boolean;
};

type ReaperResult = {
  log: string;
  signaledPids: number[];
};

function elapsedSeconds(value: string): number {
  const [clock, fraction = ''] = value.split('.');
  void fraction;
  const [dayPart, timePart] = clock.includes('-') ? clock.split('-') : ['0', clock];
  const fields = timePart.split(':').map(Number);
  const [hours, minutes, seconds] =
    fields.length === 3 ? fields : fields.length === 2 ? [0, ...fields] : [0, 0, fields[0]];
  return Number(dayPart) * 86_400 + hours * 3_600 + minutes * 60 + seconds;
}

function writeCommand(binDir: string, name: string, source: string): void {
  const file = path.join(binDir, name);
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runReaper(
  processes: ProcessFixture[],
  options: { minAgeSeconds?: number; cpuDeltaSeconds?: number } = {},
): ReaperResult {
  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'claude-reaper-test-'));
  const binDir = path.join(fixtureDir, 'bin');
  const homeDir = path.join(fixtureDir, 'home');
  const stateDir = path.join(homeDir, 'Library', 'Application Support', 'claude-reaper');
  mkdirSync(binDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    path.join(fixtureDir, 'processes'),
    processes
      .map(({ pid, ppid, tty, etime, rss = 204_800, comm }) => `${pid} ${ppid} ${tty} ${etime} ${rss} ${comm}`)
      .join('\n') + '\n',
  );
  writeFileSync(
    path.join(fixtureDir, 'cpu'),
    processes.map(({ pid, cputime = '00:10:00' }) => `${pid} ${cputime}`).join('\n') + '\n',
  );
  writeFileSync(
    path.join(fixtureDir, 'stubborn'),
    processes.filter(({ ignoresTerm }) => ignoresTerm).map(({ pid }) => pid).join('\n') + '\n',
  );

  const candidates = processes.filter(({ ppid }) => ppid === 1);
  writeFileSync(
    path.join(stateDir, 'activity.state'),
    candidates
      .map(({ pid, etime, cputime = '00:10:00' }) => `${pid} ${NOW - elapsedSeconds(etime)} ${elapsedSeconds(cputime)}`)
      .join('\n') + '\n',
  );

  writeCommand(
    binDir,
    'date',
    `#!/bin/bash
if [[ "\${1:-}" == "+%s" ]]; then
  printf '${NOW}\\n'
else
  printf '2026-10-09 12:00:00\\n'
fi
`,
  );
  writeCommand(
    binDir,
    'pgrep',
    `#!/bin/bash
if [[ "\${1:-}" == "-P" && -n "\${2:-}" ]]; then
  awk -v parent="$2" '$2 == parent { print $1 }' "$REAPER_FIXTURE/processes"
fi
`,
  );
  writeCommand(
    binDir,
    'kill',
    `#!/bin/bash
signal=TERM
if [[ "\${1:-}" == -* ]]; then
  signal="$1"
  shift
fi

is_alive() {
  awk -v pid="$1" '$1 == pid { found = 1 } END { exit !found }' "$REAPER_FIXTURE/processes" || return 1
  ! grep -qx "$1" "$REAPER_FIXTURE/killed" 2>/dev/null
}

if [[ "$signal" == "-0" ]]; then
  is_alive "$1"
  exit $?
fi

for pid in "$@"; do
  [[ -z "$pid" ]] && continue
  printf '%s\\n' "$pid" >> "$REAPER_FIXTURE/signals"
  if [[ "$signal" == "-9" ]] || ! grep -qx "$pid" "$REAPER_FIXTURE/stubborn" 2>/dev/null; then
    printf '%s\\n' "$pid" >> "$REAPER_FIXTURE/killed"
  fi
done
exit 0
`,
  );
  writeCommand(binDir, 'sleep', '#!/bin/bash\nexit 0\n');
  writeCommand(
    binDir,
    'ps',
    `#!/bin/bash
if [[ "\${1:-}" == "-Ao" ]]; then
  cat "$REAPER_FIXTURE/processes"
  exit 0
fi

pid=""
previous=""
for argument in "$@"; do
  if [[ "$previous" == "-p" ]]; then pid="$argument"; fi
  previous="$argument"
done
pid="\${pid%%,*}"

is_alive() {
  awk -v pid="$1" '$1 == pid { found = 1 } END { exit !found }' "$REAPER_FIXTURE/processes" || return 1
  ! grep -qx "$1" "$REAPER_FIXTURE/killed" 2>/dev/null
}

is_alive "$pid" || exit 1
arguments="$*"
if [[ "$arguments" == *"cputime="* ]]; then
  awk -v pid="$pid" '$1 == pid { print $2 }' "$REAPER_FIXTURE/cpu"
elif [[ "$arguments" == *"tty="* ]]; then
  if [[ "$arguments" == *"pid="* ]]; then
    awk -v pid="$pid" '$1 == pid { print $1, $3 }' "$REAPER_FIXTURE/processes"
  else
    awk -v pid="$pid" '$1 == pid { print $3 }' "$REAPER_FIXTURE/processes"
  fi
elif [[ "$arguments" == *"pid="* ]]; then
  printf '%s\\n' "$pid"
else
  printf '%s process\\n' "$pid"
fi
`,
  );

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: homeDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    REAPER_FIXTURE: fixtureDir,
  };
  delete env.MIN_AGE_SECONDS;
  delete env.CPU_DELTA_SECONDS;
  if (options.minAgeSeconds !== undefined) env.MIN_AGE_SECONDS = String(options.minAgeSeconds);
  if (options.cpuDeltaSeconds !== undefined) env.CPU_DELTA_SECONDS = String(options.cpuDeltaSeconds);

  const result = spawnSync(
    '/bin/bash',
    ['-c', 'enable -n kill; source "$1"', 'reaper-test', SCRIPT],
    { encoding: 'utf8', env },
  );
  expect(result.status, `stderr: ${result.stderr}`).toBe(0);

  const signalsFile = path.join(fixtureDir, 'signals');
  const logFile = path.join(homeDir, 'Library', 'Logs', 'claude-reaper.log');
  return {
    log: existsSync(logFile) ? readFileSync(logFile, 'utf8') : '',
    signaledPids: existsSync(signalsFile)
      ? readFileSync(signalsFile, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)
      : [],
  };
}

function processFixture(overrides: Partial<ProcessFixture> = {}): ProcessFixture {
  return {
    pid: 401,
    ppid: 1,
    tty: '??',
    etime: '04:00:00',
    comm: 'claude bg-pty-host',
    ...overrides,
  };
}

function actionLine(log: string, pid: number, action: RegExp): string {
  return log
    .split('\n')
    .find((line) => line.includes(`pid=${pid}`) && action.test(line)) ?? '';
}

function expectMeasuredState(line: string, before: RegExp, after: RegExp): void {
  expect(line).toMatch(new RegExp(`\\bbefore=.*${before.source}.*\\bafter=.*${after.source}`, 'i'));
}

describe('reap-claude-orphans', () => {
  test('skips the entire tree and names a TTY grandchild and its tty (rejects checking only direct children once)', () => {
    const result = runReaper([
      processFixture(),
      processFixture({ pid: 402, ppid: 401, tty: '??', etime: '03:00:00', comm: 'claude bg-worker' }),
      processFixture({ pid: 403, ppid: 402, tty: 'ttys021', etime: '02:00:00', comm: 'claude bg-spare' }),
    ]);

    expect(result.signaledPids).toEqual([]);
    const line = actionLine(result.log, 401, /skip/i);
    expect(line).toMatch(/\b403\b/);
    expect(line).toContain('ttys021');
    expectMeasuredState(line, /(alive|present|running)/, /(alive|present|running)/);
  });

  test('kills a detached parent and all detached children with measured state (rejects treating ?? as an attached tty)', () => {
    const result = runReaper([
      processFixture(),
      processFixture({ pid: 402, ppid: 401, tty: '??', etime: '03:00:00', comm: 'claude bg-worker' }),
      processFixture({ pid: 403, ppid: 401, tty: '??', etime: '03:00:00', comm: 'claude bg-helper' }),
    ]);

    expect([...new Set(result.signaledPids)].sort()).toEqual([401, 402, 403]);
    const line = actionLine(result.log, 401, /(reap|kill)/i);
    expectMeasuredState(line, /(alive|present|running)/, /(dead|gone|absent|stopped|missing)/);
  });

  test('kills an eligible parent with no children and reports measured state (rejects requiring pgrep output)', () => {
    const result = runReaper([processFixture()]);

    expect([...new Set(result.signaledPids)]).toEqual([401]);
    const line = actionLine(result.log, 401, /(reap|kill)/i);
    expectMeasuredState(line, /(alive|present|running)/, /(dead|gone|absent|stopped|missing)/);
  });

  test('retains CPU_DELTA_SECONDS and activity.state in the tracked script (rejects an age-only baseline)', () => {
    const source = readFileSync(SCRIPT, 'utf8');

    expect(source).toContain('CPU_DELTA_SECONDS');
    expect(source).toContain('activity.state');
  });

  test('uses an exact default age boundary of 12600 seconds (rejects the legacy 7200-second default)', () => {
    const atBoundary = runReaper([processFixture({ etime: '03:30:00' })]);
    const aboveBoundary = runReaper([processFixture({ etime: '03:30:01' })]);

    expect({
      atBoundary: atBoundary.signaledPids,
      aboveBoundary: [...new Set(aboveBoundary.signaledPids)],
    }).toEqual({ atBoundary: [], aboveBoundary: [401] });
  });

  test('matches a claude bg-pty-host command and records its observed transition (rejects whole-command equality filtering)', () => {
    const result = runReaper([processFixture({ comm: 'claude bg-pty-host' })]);

    expect([...new Set(result.signaledPids)]).toEqual([401]);
    const line = actionLine(result.log, 401, /(reap|kill)/i);
    expectMeasuredState(line, /(alive|present|running)/, /(dead|gone|absent|stopped|missing)/);
  });

  test('every kill or skip line reflects before and after process state (rejects using a successful signal call as the outcome)', () => {
    const result = runReaper([
      processFixture({ pid: 701 }),
      processFixture({ pid: 702, ppid: 701, tty: '??', comm: 'claude bg-worker' }),
      processFixture({ pid: 703, ppid: 702, tty: 'ttys031', comm: 'claude bg-spare' }),
      processFixture({ pid: 711 }),
      processFixture({ pid: 712, ppid: 711, tty: '??', comm: 'claude bg-worker' }),
      processFixture({ pid: 721, ignoresTerm: true }),
    ]);
    const actionLines = result.log
      .split('\n')
      .filter((line) => line.length > 0)
      .filter((line) => !/\brun complete:/i.test(line))
      .filter((line) => /\b(?:skip|reap|kill)\w*|\bSIG(?:TERM|KILL)\b/i.test(line));

    for (const line of actionLines) {
      expectMeasuredState(
        line,
        /(alive|present|running|dead|gone|absent|stopped|missing)/,
        /(alive|present|running|dead|gone|absent|stopped|missing)/,
      );
    }
    expect(actionLines.some((line) => /skip/i.test(line))).toBe(true);
    expect(actionLines.some((line) => /(?:reap|kill|SIGTERM|SIGKILL)/i.test(line))).toBe(true);
  });
});
