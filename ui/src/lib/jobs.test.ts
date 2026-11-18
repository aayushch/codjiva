import { describe, expect, it } from 'vitest';
import type { ArtifactSummary, JobEvent } from './ipc';
import {
  estimateNote,
  formatElapsed,
  formatEstimate,
  newJob,
  reduceJob,
  stepsFor,
  stepStates,
  targetOf,
  targetOfArtifact,
  VISUALISE_STEPS,
} from './jobs';

const run = (events: JobEvent[]) =>
  events.reduce(
    (job, event, i) => reduceJob(job, event, 1000 + i),
    newJob({ kind: 'visualise', subject: ['a.go'] }, 1000),
  );
const states = (events: JobEvent[]) =>
  stepStates(run(events), VISUALISE_STEPS).map((s) => s.state);

describe('reduceJob', () => {
  it('follows a job from start to a passing result', () => {
    const job = run([
      {
        type: 'started',
        jobId: 'j1',
        artifactId: 'visual-a',
        version: 2,
        agent: 'Claude Code',
      },
      { type: 'phase', phase: 'reading', detail: null },
      { type: 'log', level: 'tool', text: 'Read a.go' },
      { type: 'phase', phase: 'drawing', detail: 'plant has 6 machines' },
      { type: 'usage', costUsd: 0.3, inputTokens: 10, outputTokens: 5 },
      { type: 'guard', violations: [] },
      { type: 'phase', phase: 'building', detail: null },
      { type: 'phase', phase: 'validating', detail: null },
      {
        type: 'validation',
        report: { ok: true, issues: [{ check: 'idle', severity: 'warning' }] },
        iteration: 0,
      },
      {
        type: 'result',
        artifactId: 'visual-a',
        version: 2,
        passed: true,
        errors: 0,
        warnings: 1,
      },
    ]);
    expect(job.status).toBe('done');
    expect([job.jobId, job.artifactId, job.version, job.agent]).toEqual([
      'j1',
      'visual-a',
      2,
      'Claude Code',
    ]);
    expect(job.result).toEqual({ passed: true, errors: 0, warnings: 1 });
    expect(job.usage?.costUsd).toBe(0.3);
    expect(job.log.map((l) => l.text)).toEqual([
      'Read a.go',
      'plant has 6 machines',
      'no file outside the version folder changed',
      'All checks passed.',
    ]);
    expect(job.log[2].level).toBe('guard');
    expect(job.endedAt).not.toBeNull();
  });

  it('counts fix rounds and reports the problems the checks found', () => {
    const job = run([
      { type: 'phase', phase: 'validating', detail: null },
      {
        type: 'validation',
        report: {
          ok: false,
          build: [
            {
              check: 'schema',
              severity: 'error',
              file: 'visual.json',
              line: null,
              message: 'x',
            },
          ],
          issues: [{ check: 'text-overlap', severity: 'error' }],
        },
        iteration: 0,
      },
      { type: 'phase', phase: 'fixing', detail: null },
    ]);
    expect(job.fixRound).toBe(1);
    expect(job.phase).toBe('fixing');
    expect(job.log.at(-1)?.text).toBe('The checks found 2 problem(s).');
  });

  it('records a failure and a cancel as the end of the job', () => {
    const failed = run([
      {
        type: 'failed',
        code: 'write_guard',
        message: 'The agent changed files outside .codjiva: src/a.go.',
      },
    ]);
    expect([
      failed.status,
      failed.error?.code,
      failed.log.at(-1)?.level,
    ]).toEqual(['failed', 'write_guard', 'error']);
    expect(run([{ type: 'cancelled' }]).status).toBe('cancelled');
  });
});

describe('stepStates', () => {
  it('marks earlier steps done, the current one now, and later ones to do', () => {
    expect(
      states([
        { type: 'phase', phase: 'reading', detail: null },
        { type: 'phase', phase: 'drawing', detail: null },
      ]),
    ).toEqual(['done', 'done', 'now', 'todo', 'todo']);
  });

  it('treats building as part of the checking step', () => {
    expect(
      states([{ type: 'phase', phase: 'building', detail: null }]),
    ).toEqual(['done', 'done', 'done', 'done', 'now']);
  });

  it('shows every step done once the job has a result', () => {
    expect(
      states([
        {
          type: 'result',
          artifactId: 'a',
          version: 1,
          passed: true,
          errors: 0,
          warnings: 0,
        },
      ]),
    ).toEqual(['done', 'done', 'done', 'done', 'done']);
  });
});

describe('film and feedback jobs', () => {
  const outline = {
    schemaVersion: 1 as const,
    title: 'T',
    chapters: [
      { id: 'a', title: 'A', summary: 's', beats: [{ what: 'w' }] },
      { id: 'b', title: 'B', summary: 's', beats: [{ what: 'w' }] },
    ],
  };

  it('shows the outline and names the chapter in work', () => {
    const events: JobEvent[] = [
      { type: 'phase', phase: 'analysing', detail: null },
      { type: 'phase', phase: 'outline', detail: null },
      { type: 'outline', outline },
      { type: 'outline', outline },
      { type: 'phase', phase: 'chapter', detail: null, chapter: 2, of: 5 },
    ];
    const job = events.reduce(
      (j, event, i) => reduceJob(j, event, 1000 + i),
      newJob({ kind: 'animate', subject: ['a.go'] }, 1000),
    );
    expect(job.outline?.chapters.length).toBe(2);
    expect(job.log.map((l) => l.text)).toEqual(['The outline has 2 chapters.']);
    expect(job.chapter).toEqual({ n: 2, of: 5 });
    const steps = stepStates(job, stepsFor(job));
    expect(steps.find((s) => s.state === 'now')?.label).toBe(
      'Animating chapter 2 of 5',
    );
    expect(steps.slice(0, 4).every((s) => s.state === 'done')).toBe(true);
  });

  it('keeps the file a feedback job is about, although the request does not name it', () => {
    const job = newJob(
      {
        kind: 'feedback',
        subject: [],
        artifactId: 'film-a',
        baseVersion: 1,
        feedback: { text: 'x' },
      },
      1000,
      'src/a.go',
    );
    expect(job.subject).toBe('src/a.go');
    expect(stepsFor(job).map((s) => s.phase)).toEqual([
      'revising',
      'validating',
    ]);
    expect(
      stepStates(
        reduceJob(
          job,
          { type: 'phase', phase: 'revising', detail: null },
          1001,
        ),
        stepsFor(job),
      )[0].state,
    ).toBe('now');
  });
});

describe('formatElapsed', () => {
  it('shows minutes and seconds', () => {
    expect([
      formatElapsed(0),
      formatElapsed(102_400),
      formatElapsed(600_000),
    ]).toEqual(['0:00', '1:42', '10:00']);
  });
});

describe('formatEstimate', () => {
  const range = (lowSeconds: number, highSeconds: number) => ({
    lowSeconds,
    highSeconds,
    typicalSeconds: (lowSeconds + highSeconds) / 2,
    samples: 0,
  });

  it('says a range in whole minutes', () => {
    expect(formatEstimate(range(480, 790))).toBe('8–13 min');
    expect(formatEstimate(range(100, 250))).toBe('2–4 min');
  });

  it('says one number when both ends round to it', () => {
    expect(formatEstimate(range(160, 200))).toBe('about 3 min');
  });

  it('never says less than a minute', () => {
    expect(formatEstimate(range(20, 50))).toBe('about a minute');
    expect(formatEstimate(range(20, 130))).toBe('1–2 min');
  });

  it('turns into "longer than usual" past the upper end', () => {
    expect(estimateNote(range(480, 790), 60_000)).toBe('usually 8–13 min');
    expect(estimateNote(range(480, 790), 790_000)).toBe('usually 8–13 min');
    expect(estimateNote(range(480, 790), 791_000)).toBe('longer than usual');
  });
});

describe('targetOf', () => {
  // Only the fields that `targetOf` reads.
  const artifact = (
    id: string,
    kind: ArtifactSummary['kind'],
    subject: string[],
  ) => ({ id, kind, subject }) as ArtifactSummary;
  const visual = artifact('visual-a', 'visual', ['src/a.go']);
  const film = artifact('film-a', 'film', ['src/a.go']);
  const other = artifact('visual-b', 'visual', ['src/b.go']);
  const pipeline = artifact('pipeline-ab', 'pipeline', [
    'src/a.go',
    'src/b.go',
  ]);
  const all = [visual, film, other, pipeline];

  it('gives a new version, a regeneration and feedback of one artifact the same name', () => {
    const regenerate = targetOf(
      { kind: 'visualise', subject: ['src/a.go'] },
      all,
    );
    expect(regenerate).toBe(targetOfArtifact(visual));
    expect(
      targetOf({ kind: 'feedback', subject: [], artifactId: 'visual-a' }, all),
    ).toBe(regenerate);
  });

  it('tells the visual and the film of one file apart, and the visuals of two files', () => {
    const names = [
      targetOf({ kind: 'visualise', subject: ['src/a.go'] }, all),
      targetOf({ kind: 'animate', subject: ['src/a.go'] }, all),
      targetOf({ kind: 'visualise', subject: ['src/b.go'] }, all),
    ];
    expect(new Set(names).size).toBe(3);
    expect(names[1]).toBe(targetOfArtifact(film));
  });

  it('names a pipeline by the files of its parts, in any order', () => {
    expect(
      targetOf(
        { kind: 'compose', subject: [], parts: ['visual-b', 'visual-a'] },
        all,
      ),
    ).toBe(targetOfArtifact(pipeline));
  });
});
