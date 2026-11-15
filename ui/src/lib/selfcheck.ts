// The interface's side of the app's self-check mode (see
// ui/src-tauri/src/selfcheck.rs).
//
// It tours the real window: opens a folder, selects a file, shows its source,
// plays the example film inside the sandboxed frame and opens the example
// visual. Each step is recorded as a named check, with a screenshot, and the
// report is handed back to the app, which then quits.

import { invoke } from '@tauri-apps/api/core';
import { tick } from 'svelte';
import { app } from './state/app.svelte';

// A skipped check could not be carried out in this environment. It does not
// fail the tour.
type Check = { name: string; ok: boolean; skipped?: boolean; detail?: string };

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

// Waits until `test` returns a value that is not false, null or undefined, and
// returns it. Returns null when that does not happen within `timeout`
// milliseconds.
async function until<T>(
  test: () => T | false | null | undefined,
  timeout = 15000,
): Promise<T | null> {
  const began = performance.now();
  for (;;) {
    const value = test();
    if (value !== false && value != null) return value;
    if (performance.now() - began > timeout) return null;
    await sleep(100);
  }
}

const text = (selector: string) =>
  document.querySelector(selector)?.textContent?.trim() ?? '';

// Runs one Visualise job on `file` and checks what the app shows for it: the
// job's steps, the result of its checks, the visual in its frame and the
// inspector beside it.
//
// With `cancelAfter` set, the job is cancelled after that many seconds instead,
// and the tour checks that it stops within five seconds and leaves no version
// behind.
async function visualiseTour(
  file: string,
  instructions: string,
  cancelAfter: number | null,
  record: (name: string, ok: boolean, detail?: string) => void,
  shot: (name: string) => Promise<void>,
) {
  await until(() => app.agentsLoaded, 30000);
  record(
    'an agent is available to run the job',
    !!app.activeAgent,
    app.activeAgent
      ? `${app.activeAgent.name} ${app.activeAgent.version ?? ''}`
      : app.agents.map((a) => a.note).join(' | '),
  );
  if (!app.activeAgent) return;
  await app.selectFile(file);
  await app.setTab('visual');
  await app.startJob({ kind: 'visualise', subject: [file], instructions });
  const began = performance.now();
  await sleep(1500);
  await shot('10-job-running');
  if (cancelAfter != null) {
    await sleep(cancelAfter * 1000);
    const versionsBefore = app.visualArtifact?.versions.length ?? 0;
    record(
      'cancel: the agent was still working when the job was cancelled',
      app.job?.status === 'running',
      `phase: ${app.job?.phase}, ${app.job?.log.length} log lines`,
    );
    const asked = performance.now();
    await app.cancelJob();
    const stopped = await until(
      () => (app.job && app.job.status !== 'running' ? app.job : null),
      20000,
    );
    const took = Math.round(performance.now() - asked);
    record(
      'cancel: the job stops within five seconds',
      stopped?.status === 'cancelled' && took <= 5000,
      `status: ${stopped?.status}, after ${took} ms`,
    );
    await app.reloadArtifacts();
    record(
      'cancel: no version is added',
      (app.visualArtifact?.versions.length ?? 0) === versionsBefore,
    );
    await shot('11-job-cancelled');
    return;
  }
  // A real agent takes minutes. The job itself gives up on an agent that goes
  // silent.
  const ended = await until(
    () => (app.job && app.job.status !== 'running' ? app.job : null),
    25 * 60 * 1000,
  );
  const seconds = Math.round((performance.now() - began) / 1000);
  const job = app.job;
  await shot('11-job-ended');
  record(
    'the job ends by itself',
    !!ended,
    `status: ${job?.status}, after ${seconds} s`,
  );
  if (!job) return;
  record(
    "the write guard found no change outside the app's folder",
    job.violations.length === 0,
    job.violations.map((v) => v.path).join(', '),
  );
  record(
    'the job produced a version',
    job.status === 'done' && !!job.result,
    job.error ? `${job.error.code}: ${job.error.message}` : undefined,
  );
  const lastLines = job.log
    .slice(-6)
    .map((l) => l.text)
    .join(' | ');
  if (job.status !== 'done' || !job.result) {
    record('the job log', false, lastLines);
    return;
  }
  record(
    'the result passed its checks',
    job.result.passed,
    `${job.result.errors} error(s), ${job.result.warnings} warning(s), ${job.fixRound} fix round(s), cost ${job.usage?.costUsd ?? 'unknown'}, ${seconds} s`,
  );
  const issues = (job.report?.issues ?? [])
    .filter((i) => i.severity === 'error')
    .slice(0, 5)
    .map(
      (i) => `${i.check}: ${i.message ?? i.hint ?? ''} ${i.a?.selector ?? ''}`,
    );
  if (issues.length) record('remaining problems', false, issues.join(' | '));

  await until(() => document.querySelector('.inspector'), 15000);
  record(
    'the visual is shown with the inspector beside it',
    !!document.querySelector('.inspector') &&
      !!document.querySelector('.canvas iframe'),
  );
  record(
    'the file has a badge in the tree and an entry in the library',
    !!document.querySelector('.row.selected .badge') &&
      !!document.querySelector('.lib-item'),
  );
  const nodes = app.detail?.definition?.nodes ?? [];
  record(
    'the visual declares clickable parts with code references',
    nodes.length > 0 && nodes.some((n) => (n.refs?.length ?? 0) > 0),
    `${nodes.length} nodes`,
  );
  await sleep(2500);
  app.dockOpen = false;
  await tick();
  await sleep(400);
  await shot('12-visual');
  if (nodes.length) {
    app.selectedNode = nodes[0].id;
    app.frameSend?.({ cj: 'select', nodeId: nodes[0].id });
    await tick();
    await sleep(600);
    await shot('13-visual-selected');
  }

  // Reopening the workspace shows the saved visual from disk, without any
  // agent.
  const root = app.workspace!.root;
  await app.closeWorkspace();
  await app.openWorkspace(root);
  const reopened = performance.now();
  await app.selectFile(file);
  const back = await until(
    () => (app.detail && document.querySelector('.inspector') ? true : null),
    5000,
  );
  record(
    'reopening the workspace shows the saved visual at once',
    !!back && app.job === null,
    `${Math.round(performance.now() - reopened)} ms, ${app.artifacts.length} artifact(s)`,
  );

  // Editing the source file marks the visual stale, and nothing is regenerated.
  const versionsBefore = app.currentArtifact?.versions.length ?? 0;
  const edited = performance.now();
  await invoke('selfcheck_edit_file', { relPath: file });
  const stale = await until(
    () => (app.currentArtifact?.stale ? true : null),
    5000,
  );
  const took = Math.round(performance.now() - edited);
  record(
    'editing the source marks the visual stale within two seconds',
    !!stale && took <= 2000,
    `${took} ms`,
  );
  await sleep(500);
  record(
    'a stale visual is not regenerated by itself',
    app.job === null &&
      (app.currentArtifact?.versions.length ?? 0) === versionsBefore,
  );
  await tick();
  await shot('14-stale');
}

// Waits for the running job to end and records how it went. Returns true when
// it made a version.
async function recordJob(
  label: string,
  began: number,
  record: (name: string, ok: boolean, detail?: string) => void,
): Promise<boolean> {
  // A real agent takes minutes. The job itself gives up on an agent that goes
  // silent.
  const ended = await until(
    () => (app.job && app.job.status !== 'running' ? app.job : null),
    40 * 60 * 1000,
  );
  const seconds = Math.round((performance.now() - began) / 1000);
  const job = app.job;
  record(
    `${label}: the job ends by itself`,
    !!ended,
    `status: ${job?.status}, after ${seconds} s`,
  );
  if (!job) return false;
  record(
    `${label}: the write guard found no change the agent must not make`,
    job.violations.length === 0,
    job.violations.map((v) => v.path).join(', '),
  );
  record(
    `${label}: the job produced a version`,
    job.status === 'done' && !!job.result,
    job.error ? `${job.error.code}: ${job.error.message}` : undefined,
  );
  if (job.status !== 'done' || !job.result) {
    record(
      `${label}: the job log`,
      false,
      job.log
        .slice(-6)
        .map((l) => l.text)
        .join(' | '),
    );
    return false;
  }
  record(
    `${label}: the result passed its checks`,
    job.result.passed,
    `${job.result.errors} error(s), ${job.result.warnings} warning(s), ${job.fixRound} fix round(s), cost ${job.usage?.costUsd ?? 'unknown'}, ${seconds} s`,
  );
  const issues = (job.report?.issues ?? [])
    .filter((i) => i.severity === 'error')
    .slice(0, 6)
    .map(
      (i) =>
        `${i.check}${i.scene ? ' @' + i.scene : ''}: ${i.message ?? i.hint ?? ''} ${i.a?.selector ?? ''}`,
    );
  if (issues.length)
    record(`${label}: remaining problems`, false, issues.join(' | '));
  return true;
}

// Runs one Animate job on `file` and checks what the app shows for it: the
// suggested companions, the outline while the film is made, and the film with
// its chapters. Then, when `feedback` is given, sends it about a moment of the
// film and checks that a second version is made from the first.
async function animateTour(
  file: string,
  instructions: string,
  feedback: string | null,
  lengthSeconds: number,
  record: (name: string, ok: boolean, detail?: string) => void,
  shot: (name: string) => Promise<void>,
) {
  await until(() => app.agentsLoaded, 30000);
  record(
    'film: an agent is available to run the job',
    !!app.activeAgent,
    app.activeAgent
      ? `${app.activeAgent.name} ${app.activeAgent.version ?? ''}`
      : app.agents.map((a) => a.note).join(' | '),
  );
  if (!app.activeAgent) return;
  await app.selectFile(file);
  await app.setTab('film');
  const suggested = await invoke<
    { path: string; why: string; score: number }[]
  >('companions_suggest', { relPath: file });
  record(
    'film: companion files are suggested',
    suggested.length > 0,
    suggested.map((s) => `${s.path} (${s.why})`).join(' | '),
  );
  const companions = suggested
    .filter((s) => s.score >= 8)
    .slice(0, 6)
    .map((s) => s.path);

  let began = performance.now();
  await app.startJob({
    kind: 'animate',
    subject: [file],
    companions,
    instructions,
    lengthSeconds,
  });
  const outline = await until(
    () => app.job?.outline ?? (app.job?.status !== 'running' ? false : null),
    30 * 60 * 1000,
  );
  if (outline) {
    await tick();
    await sleep(400);
    await shot('20-outline');
  }
  // A recorded session writes all its files at once, so its outline arrives as
  // the turn ends. A real agent writes the outline minutes before it finishes.
  record(
    'film: the outline is shown in the job panel',
    !!outline,
    outline
      ? `${app.job?.status === 'running' ? 'while the agent was still working' : 'as the agent finished'}: ${outline.chapters.map((c) => c.title).join(' | ')}`
      : 'no outline arrived',
  );
  if (!(await recordJob('film', began, record))) {
    await shot('21-film-job-ended');
    return;
  }

  await until(() => document.querySelector('.player:not(.waiting)'), 20000);
  const chapters = app.detail?.manifest.chapters ?? [];
  record(
    'film: the film is shown with its chapters',
    !!document.querySelector('.player:not(.waiting)') && chapters.length >= 2,
    `${chapters.length} chapters, ${Math.round(app.detail?.manifest.durationSec ?? 0)} s: ${chapters.map((c) => c.name).join(' | ')}`,
  );
  app.dockOpen = false;
  await tick();
  // One picture from the middle of every chapter, where its bubbles and motion
  // are.
  for (const [i, chapter] of chapters.entries()) {
    app.frameSend?.({ cj: 'seek', t: chapter.start + chapter.dur * 0.55 });
    await sleep(900);
    await shot(`22-film-chapter-${i + 1}`);
  }

  if (!feedback || chapters.length < 2) return;
  const at = chapters[1].start + chapters[1].dur * 0.55;
  app.frameSend?.({ cj: 'seek', t: at });
  await until(
    () => (app.filmMoment && Math.abs(app.filmMoment.t - at) < 1 ? true : null),
    5000,
  );
  began = performance.now();
  await app.sendFeedback(feedback);
  record(
    'feedback: the request names the moment the user was at',
    app.job?.request.feedback?.scene === chapters[1].id &&
      app.job.request.feedback.time != null,
    JSON.stringify({ ...app.job?.request.feedback, text: undefined }),
  );
  if (!(await recordJob('feedback', began, record))) return;
  await until(() => (app.detail?.manifest.version === 2 ? true : null), 15000);
  record(
    'feedback: a second version is shown, made from the first',
    app.detail?.manifest.version === 2 &&
      app.detail.manifest.parent === 1 &&
      app.detail.manifest.feedback === feedback,
    `version ${app.detail?.manifest.version}, parent ${app.detail?.manifest.parent}`,
  );
  app.dockOpen = false;
  await until(() => document.querySelector('.player:not(.waiting)'), 20000);
  app.frameSend?.({ cj: 'seek', t: at });
  await sleep(900);
  await shot('23-film-after-feedback');
}

// Joins the visuals of `files` into a still pipeline and checks what the app
// shows for it: the joins it proposes, the job, and the pipeline with its parts
// and joins in the inspector.
async function composeTour(
  files: string[],
  instructions: string,
  film: boolean,
  lengthSeconds: number,
  record: (name: string, ok: boolean, detail?: string) => void,
  shot: (name: string) => Promise<void>,
) {
  await until(() => app.agentsLoaded, 30000);
  await app.reloadArtifacts();
  const ids = files
    .map(
      (file) =>
        app.artifacts.find((a) => a.kind === 'visual' && a.subject[0] === file)
          ?.id,
    )
    .filter((id): id is string => !!id);
  record(
    'pipeline: every file has a visual to join',
    ids.length === files.length && ids.length >= 2,
    `${ids.length} of ${files.length}: ${ids.join(', ')}`,
  );
  if (ids.length < 2 || !app.activeAgent) return;
  const proposal = await invoke<{
    parts: { title: string; ports: { id: string; symbol: string }[] }[];
    joins: any[];
  }>('compose_propose', { artifactIds: ids });
  record(
    'pipeline: the app proposes a join between the artifacts',
    proposal.joins.length > 0,
    proposal.joins
      .map((j) => `${j.fromPort} → ${j.toPort} (${j.strength}: ${j.reason})`)
      .join(' | ') ||
      proposal.parts
        .map((p) => `${p.title}: ${p.ports.map((x) => x.id).join(', ')}`)
        .join(' | '),
  );
  if (!proposal.joins.length) return;

  const began = performance.now();
  await app.startJob(
    {
      kind: 'compose',
      subject: [],
      parts: ids,
      joins: proposal.joins,
      film,
      lengthSeconds,
      instructions,
    },
    'pipeline',
  );
  await sleep(1500);
  await shot('30-compose-running');
  if (!(await recordJob('pipeline', began, record))) {
    await shot('31-compose-ended');
    return;
  }
  await until(
    () =>
      app.selectedPipelineId && app.detail?.manifest.kind === 'pipeline'
        ? true
        : null,
    15000,
  );
  const manifest = app.detail?.manifest;
  record(
    'pipeline: it opens with its parts and joins listed',
    manifest?.kind === 'pipeline' &&
      (manifest.parts?.length ?? 0) === ids.length &&
      (manifest.joins?.length ?? 0) > 0,
    `${manifest?.title}: parts ${manifest?.parts?.map((p) => p.key).join(', ')}; joins ${manifest?.joins?.map((j) => j.symbol).join(', ')}`,
  );
  app.dockOpen = false;
  if (film) {
    // A pipeline film: it must play, with chapters, and is pictured once per
    // chapter.
    await until(() => document.querySelector('.player:not(.waiting)'), 20000);
    const chapters = manifest?.chapters ?? [];
    record(
      'pipeline: the film is shown with its chapters',
      manifest?.form === 'film' && chapters.length >= 2,
      `${chapters.length} chapters, ${Math.round(manifest?.durationSec ?? 0)} s: ${chapters.map((c) => c.name).join(' | ')}`,
    );
    await tick();
    for (const [i, chapter] of chapters.entries()) {
      app.frameSend?.({ cj: 'seek', t: chapter.start + chapter.dur * 0.55 });
      await sleep(900);
      await shot(`34-pipeline-film-chapter-${i + 1}`);
    }
    return;
  }
  const nodes = app.detail?.definition?.nodes ?? [];
  record(
    'pipeline: each part and each join can be clicked',
    nodes.length >= ids.length + 1,
    `${nodes.length} nodes: ${nodes.map((n) => n.label).join(' | ')}`,
  );
  await tick();
  await sleep(2500);
  await shot('32-pipeline');
  app.frameSend?.({ cj: 'zoom', factor: 2.2 });
  await sleep(900);
  await shot('33-pipeline-zoomed');
}

// What the environment asked the tour to do, as the `selfcheck_config` command
// reports it.
type SelfCheckConfig = {
  workspace: string | null;
  visualise: string | null;
  instructions: string | null;
  animate: string | null;
  feedback: string | null;
  cancelAfter: number | null;
  compose: string[];
  composeFilm: boolean;
  length: number | null;
};

// Starts the tour if the app was started for a self-check. Returns true if
// it was, without waiting for the tour to end.
export async function runSelfCheckIfAsked(): Promise<boolean> {
  const config = await invoke<SelfCheckConfig | null>('selfcheck_config');
  if (!config) return false;
  void runSelfCheck(config);
  return true;
}

async function runSelfCheck(config: SelfCheckConfig): Promise<void> {
  const checks: Check[] = [];
  const record = (name: string, ok: boolean, detail?: string) => {
    checks.push({ name, ok, detail });
  };
  const shot = async (name: string) => {
    try {
      await invoke('selfcheck_capture', { name });
    } catch (error: any) {
      record(
        `screenshot ${name}`,
        false,
        error?.detail ?? error?.message ?? String(error),
      );
    }
  };

  try {
    await until(() => app.info);
    record(
      'the app reports its platform',
      !!app.info?.platform,
      app.info?.platform,
    );
    record(
      'the app font is loaded',
      document.fonts.check('13px "JetBrains Mono"'),
    );
    await shot('01-welcome');

    if (config.workspace) {
      await app.openWorkspace(config.workspace);
      await tick();
      const rows = await until(() => (app.rows.length > 0 ? app.rows : null));
      record(
        'the workspace opens and the tree lists its entries',
        !!rows,
        `${app.rows.length} rows`,
      );
      const firstFile = async (): Promise<string | null> => {
        for (let guard = 0; guard < 6; guard++) {
          const file = app.rows.find(
            (r) =>
              r.entry.kind === 'file' &&
              /\.(go|rs|ts|js|py|cpp|c|h|java|md)$/i.test(r.entry.name),
          );
          if (file) return file.entry.relPath;
          const dir = app.rows.find(
            (r) => r.entry.kind === 'dir' && !r.expanded,
          );
          if (!dir) return null;
          await app.toggleDir(dir.entry.relPath);
        }
        return null;
      };
      const file = await firstFile();
      if (file) {
        await app.selectFile(file);
        await until(() => app.fileInfo);
        record(
          'selecting a file shows its details',
          !!app.fileInfo && app.fileInfo.bytes >= 0,
          `${file}: ${app.fileInfo?.lang ?? '?'}, ${app.fileInfo?.lines ?? '?'} lines`,
        );
        await tick();
        await sleep(200);
        await shot('02-empty-state');
        await app.setTab('source');
        const line = await until(() => document.querySelector('.source-line'));
        record(
          'the source tab shows the file',
          !!line,
          text('.source-line').slice(0, 60),
        );
        await sleep(300);
        await shot('03-source');
      } else {
        record('a source file was found to select', false);
      }
    }

    if (config.workspace && config.visualise)
      await visualiseTour(
        config.visualise,
        config.instructions ?? '',
        config.cancelAfter,
        record,
        shot,
      );
    if (config.workspace && config.compose.length)
      await composeTour(
        config.compose,
        config.instructions ?? '',
        config.composeFilm,
        config.length ?? 90,
        record,
        shot,
      );
    if (config.workspace && config.animate)
      await animateTour(
        config.animate,
        config.instructions ?? '',
        config.feedback,
        config.length ?? 60,
        record,
        shot,
      );

    // Counts the frames this page is given in one second. A window hidden
    // behind others is given none, and then a film cannot play; the count tells
    // that case apart from a real fault.
    const frames = await new Promise<number>((done) => {
      let count = 0;
      const step = () => {
        count++;
        requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      setTimeout(() => done(count), 1000);
    });
    const drawn = frames > 5 && document.visibilityState === 'visible';
    checks.push({
      name: 'the window is visible and is being drawn',
      ok: drawn,
      skipped: !drawn,
      detail: `${frames} frames in one second, visibility: ${document.visibilityState}`,
    });

    // The example film: the real custom URL scheme, the sandboxed frame and the
    // messages between them.
    app.example = 'film';
    await tick();
    const chapter = await until(
      () =>
        /^1 \/ \d+/.test(text('.player .chap')) ? text('.player .chap') : null,
      20000,
    );
    record(
      'the example film loads in the sandboxed frame and reports its chapters',
      !!chapter,
      chapter ?? `chapter label: "${text('.player .chap')}"`,
    );
    const frame = document.querySelector<HTMLIFrameElement>('.canvas iframe');
    record(
      'the artifact frame allows scripts and nothing else',
      frame?.getAttribute('sandbox') === 'allow-scripts',
      frame?.getAttribute('sandbox') ?? 'no frame',
    );
    record(
      "the artifact frame is served by the app's own scheme",
      /^(codjiva:|http:\/\/codjiva\.localhost)/.test(frame?.src ?? ''),
      frame?.src,
    );
    if (drawn) {
      document.querySelector<HTMLButtonElement>('.player .ibtn')?.click();
      const moved = await until(
        () =>
          !text('.player .time').startsWith('0:00')
            ? text('.player .time')
            : null,
        8000,
      );
      record(
        'the film plays when asked through the host bar',
        !!moved,
        text('.player .time'),
      );
      document.querySelector<HTMLButtonElement>('.player .ibtn')?.click();
    } else {
      // A film advances once per drawn frame, so it cannot play in a window
      // that is not drawn.
      checks.push({
        name: 'the film plays when asked through the host bar',
        ok: false,
        skipped: true,
        detail: 'the window is not being drawn',
      });
    }
    const bar = document.querySelector<HTMLElement>('.player .scrub');
    if (bar) {
      const r = bar.getBoundingClientRect();
      // The middle of the scrubber is inside the third of the example film's
      // four chapters.
      const at = {
        clientX: r.left + r.width * 0.5,
        clientY: r.top + r.height / 2,
        pointerId: 1,
        bubbles: true,
      };
      bar.dispatchEvent(new PointerEvent('pointerdown', at));
      bar.dispatchEvent(new PointerEvent('pointerup', at));
    }
    const sought = await until(
      () =>
        /^3 \/ \d+/.test(text('.player .chap')) ? text('.player .chap') : null,
      8000,
    );
    record(
      'seeking from the host bar moves the film',
      !!sought,
      text('.player .chap'),
    );
    await sleep(500);
    await shot('04-film');

    app.example = 'visual';
    await tick();
    await until(() => document.querySelector('.zoomctl'));
    await sleep(1500);
    await shot('05-visual');
    record('the example visual opens', !!document.querySelector('.zoomctl'));
    app.example = null;
  } catch (error: any) {
    record(
      'the self-check ran to the end',
      false,
      error?.message ?? String(error),
    );
  }

  const ok = checks.every((c) => c.ok || c.skipped);
  await invoke('selfcheck_done', {
    report: {
      ok,
      platform: app.info?.platform,
      userAgent: navigator.userAgent,
      checks,
    },
  });
}
