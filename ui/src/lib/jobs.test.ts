import { describe, expect, it } from 'vitest';
import type { JobEvent } from './ipc';
import { formatElapsed, newJob, reduceJob, stepsFor, stepStates, VISUALISE_STEPS } from './jobs';

const run = (events: JobEvent[]) => events.reduce((job, event, i) => reduceJob(job, event, 1000 + i), newJob({ kind: 'visualise', subject: ['a.go'] }, 1000));
const states = (events: JobEvent[]) => stepStates(run(events), VISUALISE_STEPS).map((s) => s.state);

describe('reduceJob', () => {
  it('follows a job from start to a passing result', () => {
    const job = run([
      { type: 'started', jobId: 'j1', artifactId: 'visual-a', version: 2, agent: 'Claude Code' },
      { type: 'phase', phase: 'reading', detail: null },
      { type: 'log', level: 'tool', text: 'Read a.go' },
      { type: 'phase', phase: 'drawing', detail: 'plant has 6 machines' },
      { type: 'usage', costUsd: 0.3, inputTokens: 10, outputTokens: 5 },
      { type: 'guard', violations: [] },
      { type: 'phase', phase: 'building', detail: null },
      { type: 'phase', phase: 'validating', detail: null },
      { type: 'validation', report: { ok: true, issues: [{ check: 'idle', severity: 'warning' }] }, iteration: 0 },
      { type: 'result', artifactId: 'visual-a', version: 2, passed: true, errors: 0, warnings: 1 },
    ]);
    expect(job.status).toBe('done');
    expect([job.jobId, job.artifactId, job.version, job.agent]).toEqual(['j1', 'visual-a', 2, 'Claude Code']);
    expect(job.result).toEqual({ passed: true, errors: 0, warnings: 1 });
    expect(job.usage?.costUsd).toBe(0.3);
    expect(job.log.map((l) => l.text)).toEqual(['Read a.go', 'plant has 6 machines', '0 writes outside .codjiva/', 'All checks passed.']);
    expect(job.log[2].level).toBe('guard');
    expect(job.endedAt).not.toBeNull();
  });

  it('counts fix rounds and reports the problems the checks found', () => {
    const job = run([
      { type: 'phase', phase: 'validating', detail: null },
      { type: 'validation', report: { ok: false, build: [{ check: 'schema', severity: 'error', file: 'visual.json', line: null, message: 'x' }], issues: [{ check: 'text-overlap', severity: 'error' }] }, iteration: 0 },
      { type: 'phase', phase: 'fixing', detail: null },
    ]);
    expect(job.fixRound).toBe(1);
    expect(job.phase).toBe('fixing');
    expect(job.log.at(-1)?.text).toBe('The checks found 2 problem(s).');
  });

  it('records a failure and a cancel as the end of the job', () => {
    const failed = run([{ type: 'failed', code: 'write_guard', message: 'The agent changed files outside .codjiva: src/a.go.' }]);
    expect([failed.status, failed.error?.code, failed.log.at(-1)?.level]).toEqual(['failed', 'write_guard', 'error']);
    expect(run([{ type: 'cancelled' }]).status).toBe('cancelled');
  });
});

describe('stepStates', () => {
  it('marks earlier steps done, the current one now, and later ones to do', () => {
    expect(states([{ type: 'phase', phase: 'reading', detail: null }, { type: 'phase', phase: 'drawing', detail: null }])).toEqual(['done', 'done', 'now', 'todo', 'todo']);
  });

  it('treats building as part of the checking step', () => {
    expect(states([{ type: 'phase', phase: 'building', detail: null }])).toEqual(['done', 'done', 'done', 'done', 'now']);
  });

  it('shows every step done once the job has a result', () => {
    expect(states([{ type: 'result', artifactId: 'a', version: 1, passed: true, errors: 0, warnings: 0 }])).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
});

describe('film and feedback jobs', () => {
  const outline = { schemaVersion: 1 as const, title: 'T', chapters: [{ id: 'a', title: 'A', summary: 's', beats: [{ what: 'w' }] }, { id: 'b', title: 'B', summary: 's', beats: [{ what: 'w' }] }] };

  it('shows the outline and names the chapter in work', () => {
    const events: JobEvent[] = [
      { type: 'phase', phase: 'analysing', detail: null },
      { type: 'phase', phase: 'outline', detail: null },
      { type: 'outline', outline },
      { type: 'outline', outline },
      { type: 'phase', phase: 'chapter', detail: null, chapter: 2, of: 5 },
    ];
    const job = events.reduce((j, event, i) => reduceJob(j, event, 1000 + i), newJob({ kind: 'animate', subject: ['a.go'] }, 1000));
    expect(job.outline?.chapters.length).toBe(2);
    expect(job.log.map((l) => l.text)).toEqual(['The outline has 2 chapters.']);
    expect(job.chapter).toEqual({ n: 2, of: 5 });
    const steps = stepStates(job, stepsFor(job));
    expect(steps.find((s) => s.state === 'now')?.label).toBe('Animating chapter 2 of 5');
    expect(steps.slice(0, 4).every((s) => s.state === 'done')).toBe(true);
  });

  it('keeps the file a feedback job is about, although the request does not name it', () => {
    const job = newJob({ kind: 'feedback', subject: [], artifactId: 'film-a', baseVersion: 1, feedback: { text: 'x' } }, 1000, 'src/a.go');
    expect(job.subject).toBe('src/a.go');
    expect(stepsFor(job).map((s) => s.phase)).toEqual(['revising', 'validating']);
    expect(stepStates(reduceJob(job, { type: 'phase', phase: 'revising', detail: null }, 1001), stepsFor(job))[0].state).toBe('now');
  });
});

describe('formatElapsed', () => {
  it('shows minutes and seconds', () => {
    expect([formatElapsed(0), formatElapsed(102_400), formatElapsed(600_000)]).toEqual(['0:00', '1:42', '10:00']);
  });
});
