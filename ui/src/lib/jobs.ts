// The state of one job as the interface shows it, built up from the events the
// job sends. `reduceJob` is a pure function so the whole progression can be
// tested without a window.

import type {
  ArtifactSummary,
  Estimate,
  JobEvent,
  JobRequest,
  Outline,
  Scope,
  ValidationReport,
  Violation,
} from './ipc';

export type JobStatus = 'running' | 'done' | 'failed' | 'cancelled';

export type JobView = {
  // A number that no other job of this window has. The window uses it to find
  // the job again when one of the job's events arrives.
  key: number;
  // Names the artifact the job makes a version of. See `targetOf`.
  target: string;
  request: JobRequest;
  // The file the job is about. A feedback request does not name it, so it is
  // kept here.
  subject: string;
  status: JobStatus;
  jobId: string | null;
  artifactId: string | null;
  version: number | null;
  agent: string | null;
  // The phase the job is in now, and every phase it has been in, in order.
  phase: string;
  seen: string[];
  // While a film's chapters are written: which chapter is in work, and how many
  // there are.
  chapter: { n: number; of: number } | null;
  // The outline of a film, once the agent has written it.
  outline: Outline | null;
  // How many times the result has been sent back to the agent.
  fixRound: number;
  log: { level: 'info' | 'tool' | 'warn' | 'error' | 'guard'; text: string }[];
  violations: Violation[];
  report: ValidationReport | null;
  usage: {
    costUsd: number | null;
    inputTokens: number;
    outputTokens: number;
  } | null;
  result: { passed: boolean; errors: number; warnings: number } | null;
  error: { code: string; message: string } | null;
  startedAt: number;
  endedAt: number | null;
  // How long the job is expected to take. Null until the estimate arrives,
  // and when none can be made.
  estimate: Estimate | null;
};

export type Step = { phase: string; label: string };

// The steps each kind of job is shown as going through. Building and validating
// are one step for the user: the result is being checked.
export const VISUALISE_STEPS: Step[] = [
  { phase: 'reading', label: 'Reading the code' },
  { phase: 'analysing', label: 'Analysing' },
  { phase: 'drawing', label: 'Drawing the plant' },
  { phase: 'annotating', label: 'Annotating' },
  { phase: 'validating', label: 'Building and checking' },
];
export const ANIMATE_STEPS: Step[] = [
  { phase: 'reading', label: 'Reading the code' },
  { phase: 'analysing', label: 'Analysing' },
  { phase: 'outline', label: 'Writing the story outline' },
  { phase: 'drawing', label: 'Drawing the plant' },
  { phase: 'chapter', label: 'Animating the chapters' },
  { phase: 'validating', label: 'Building and checking' },
];
// A step-through has the steps of a visual and, between drawing and
// annotating, the writing of the step function.
export const STEPTHROUGH_STEPS: Step[] = [
  { phase: 'reading', label: 'Reading the code' },
  { phase: 'analysing', label: 'Analysing' },
  { phase: 'drawing', label: 'Drawing the states' },
  { phase: 'stepping', label: 'Writing the step function' },
  { phase: 'annotating', label: 'Annotating' },
  { phase: 'validating', label: 'Running the examples' },
];
// A view is drawn by the runtime, so its job has no drawing step. A structure
// view also has a step function to write.
export const VIEW_STEPS: Step[] = [
  { phase: 'reading', label: 'Reading the code' },
  { phase: 'analysing', label: 'Analysing' },
  { phase: 'annotating', label: 'Writing the view' },
  { phase: 'validating', label: 'Laying out and checking' },
];
export const STRUCTURE_STEPS: Step[] = [
  ...VIEW_STEPS.slice(0, 2),
  { phase: 'stepping', label: 'Writing the step function' },
  ...VIEW_STEPS.slice(2),
];
// A pipeline visual and a pipeline film. Both check the joins in the code
// before drawing.
export const COMPOSE_VISUAL_STEPS: Step[] = [
  { phase: 'reading', label: 'Reading the parts' },
  { phase: 'joining', label: 'Checking the joins in the code' },
  { phase: 'drawing', label: 'Drawing the yard' },
  { phase: 'annotating', label: 'Annotating' },
  { phase: 'validating', label: 'Building and checking' },
];
export const COMPOSE_FILM_STEPS: Step[] = [
  { phase: 'reading', label: 'Reading the parts' },
  { phase: 'joining', label: 'Checking the joins in the code' },
  { phase: 'outline', label: 'Writing the story outline' },
  { phase: 'drawing', label: 'Drawing the yard' },
  { phase: 'chapter', label: 'Animating the chapters' },
  { phase: 'validating', label: 'Building and checking' },
];
export const FEEDBACK_STEPS: Step[] = [
  { phase: 'revising', label: 'Making the change' },
  { phase: 'validating', label: 'Building and checking' },
];

// The steps of a job, with the chapter count in the chapter step's label once
// it is known.
export function stepsFor(job: JobView): Step[] {
  if (job.request.kind === 'feedback') return FEEDBACK_STEPS;
  if (job.request.kind === 'compose' && !job.request.film)
    return COMPOSE_VISUAL_STEPS;
  if (job.request.kind === 'visualise') return VISUALISE_STEPS;
  if (job.request.kind === 'stepthrough') return STEPTHROUGH_STEPS;
  if (job.request.kind === 'view')
    return job.request.view === 'structure' ? STRUCTURE_STEPS : VIEW_STEPS;
  return (
    job.request.kind === 'compose' ? COMPOSE_FILM_STEPS : ANIMATE_STEPS
  ).map((step) =>
    step.phase === 'chapter' && job.chapter
      ? {
          ...step,
          label: `Animating chapter ${job.chapter.n} of ${job.chapter.of}`,
        }
      : step,
  );
}

// What a kind of job is called in the interface.
export const JOB_NAMES: Record<JobRequest['kind'], string> = {
  visualise: 'Visualise',
  animate: 'Animate',
  compose: 'Compose',
  stepthrough: 'Step through',
  view: 'View',
  feedback: 'Feedback',
};

// The step of the list a phase belongs to.
const stepOf = (phase: string): string =>
  phase === 'building' ? 'validating' : phase;

// Names the artifact of the given kind for the given source files, or for
// the part of the one source file that `scope` names. The name is the same
// whatever order the files are in.
function targetName(
  kind: ArtifactSummary['kind'],
  subject: string[],
  scope?: Scope,
): string {
  return (
    kind + ':' + [...subject].sort().join('\n') + (scope ? '#' + scope.id : '')
  );
}

// Names the artifact that `artifact` is, in the same form as `targetOf`.
export function targetOfArtifact(
  artifact: Pick<ArtifactSummary, 'kind' | 'subject' | 'scope'>,
): string {
  return targetName(artifact.kind, artifact.subject, artifact.scope);
}

// Names the artifact that a job with this request makes a version of. Two
// requests give the same name exactly when they make versions of the same
// artifact. The window uses this to refuse a second job for an artifact while
// the first one is running. `artifacts` is the list of the workspace's
// artifacts.
//
// An artifact is identified by its kind, the source files it explains and,
// for an artifact of a part of a file, the scope of that part.
//   - A Visualise request makes the visual of its one file or folder.
//   - An Animate request makes the film of its one file.
//   - A Step through request makes the step-through of its one file.
//   - A View request makes the view it names of its one file or folder.
//   - A Compose request makes the pipeline of the files that its parts
//     explain.
//   - A Feedback request makes a version of the artifact it names.
export function targetOf(
  request: JobRequest,
  artifacts: ArtifactSummary[],
): string {
  const byId = (id: string | undefined) => artifacts.find((a) => a.id === id);
  if (request.kind === 'feedback') {
    const artifact = byId(request.artifactId);
    return artifact
      ? targetOfArtifact(artifact)
      : 'id:' + (request.artifactId ?? '');
  }
  if (request.kind === 'compose')
    return targetName(
      'pipeline',
      (request.parts ?? []).map((id) => byId(id)?.subject[0] ?? id),
    );
  return targetName(
    request.kind === 'animate'
      ? 'film'
      : request.kind === 'stepthrough'
        ? 'stepthrough'
        : request.kind === 'view'
          ? (request.view ?? 'schema')
          : 'visual',
    request.subject,
    request.scope,
  );
}

// The state of a job that has just been started. `key` and `target` are the
// fields of the same names in `JobView`.
export function newJob(
  request: JobRequest,
  now: number,
  subject: string = request.subject[0] ?? '',
  key = 0,
  target = '',
): JobView {
  return {
    key,
    target,
    request,
    subject,
    status: 'running',
    jobId: null,
    artifactId: null,
    version: null,
    agent: null,
    phase: 'starting',
    seen: [],
    chapter: null,
    outline: null,
    fixRound: 0,
    log: [],
    violations: [],
    report: null,
    usage: null,
    result: null,
    error: null,
    startedAt: now,
    endedAt: null,
    estimate: null,
  };
}

// Returns the job after `event`. `now` is the time the event arrived, in
// milliseconds.
export function reduceJob(job: JobView, event: JobEvent, now: number): JobView {
  const next: JobView = { ...job, log: job.log, seen: job.seen };
  const log = (level: JobView['log'][number]['level'], text: string) => {
    next.log = [...next.log, { level, text }];
  };
  switch (event.type) {
    case 'started':
      Object.assign(next, {
        jobId: event.jobId,
        artifactId: event.artifactId,
        version: event.version,
        agent: event.agent,
      });
      break;
    case 'phase': {
      const step = stepOf(event.phase);
      next.phase = step;
      if (event.phase === 'fixing') next.fixRound = job.fixRound + 1;
      if (
        event.phase === 'chapter' &&
        event.chapter != null &&
        event.of != null
      )
        next.chapter = { n: event.chapter, of: event.of };
      if (!next.seen.includes(step)) next.seen = [...next.seen, step];
      if (event.detail) log('info', event.detail);
      break;
    }
    case 'outline':
      next.outline = event.outline;
      if (!job.outline)
        log(
          'info',
          `The outline has ${event.outline.chapters.length} chapters.`,
        );
      break;
    case 'log':
      log(event.level, event.text);
      break;
    case 'guard':
      next.violations = event.violations;
      log(
        'guard',
        event.violations.length
          ? `${event.violations.length} file(s) outside the version folder changed while the job ran`
          : 'no file outside the version folder changed',
      );
      break;
    case 'validation': {
      next.report = event.report;
      const errors =
        event.report.issues.filter((i) => i.severity === 'error').length +
        (event.report.build ?? []).filter((p) => p.severity === 'error').length;
      log(
        errors ? 'warn' : 'info',
        errors
          ? `The checks found ${errors} problem(s).`
          : 'All checks passed.',
      );
      break;
    }
    case 'usage':
      next.usage = {
        costUsd: event.costUsd,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      };
      break;
    case 'result':
      Object.assign(next, {
        status: 'done',
        phase: 'done',
        endedAt: now,
        artifactId: event.artifactId,
        version: event.version,
      });
      next.result = {
        passed: event.passed,
        errors: event.errors,
        warnings: event.warnings,
      };
      break;
    case 'failed':
      Object.assign(next, {
        status: 'failed',
        endedAt: now,
        error: { code: event.code, message: event.message },
      });
      log('error', event.message);
      break;
    case 'cancelled':
      Object.assign(next, { status: 'cancelled', endedAt: now });
      log('info', 'Cancelled.');
      break;
  }
  return next;
}

// How each step of the list should be drawn for a job: finished, current or
// still to come.
export function stepStates(
  job: JobView,
  steps: Step[],
): { label: string; state: 'done' | 'now' | 'todo' }[] {
  const at =
    job.phase === 'fixing'
      ? steps.length
      : steps.findIndex((s) => s.phase === job.phase);
  return steps.map((step, i) => {
    if (job.status === 'done')
      return { label: step.label, state: 'done' as const };
    if (job.phase === 'fixing')
      return { label: step.label, state: 'done' as const };
    if (at < 0)
      return {
        label: step.label,
        state: job.seen.includes(step.phase)
          ? ('done' as const)
          : ('todo' as const),
      };
    return {
      label: step.label,
      state:
        i < at
          ? ('done' as const)
          : i === at && job.status === 'running'
            ? ('now' as const)
            : i === at
              ? ('done' as const)
              : ('todo' as const),
    };
  });
}

// Says an estimate as a range of whole minutes: "8–13 min". A range that
// rounds to one number is "about 3 min", and anything up to a minute and a
// half is "about a minute".
export function formatEstimate(estimate: Estimate): string {
  const low = Math.max(1, Math.round(estimate.lowSeconds / 60));
  const high = Math.max(low, Math.round(estimate.highSeconds / 60));
  if (high <= 1) return 'about a minute';
  return low === high ? `about ${low} min` : `${low}–${high} min`;
}

// What the job panel says about a running job's estimate, given the
// milliseconds the job has run. It is the usual range until the job has run
// longer than the top of the range, and "longer than usual" after that.
export function estimateNote(estimate: Estimate, elapsedMs: number): string {
  return elapsedMs > estimate.highSeconds * 1000
    ? 'longer than usual'
    : `usually ${formatEstimate(estimate)}`;
}

// Formats elapsed milliseconds as minutes and seconds, "1:42".
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
