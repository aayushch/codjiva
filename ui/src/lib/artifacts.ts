// Small questions about artifacts that several components ask.

import type { ArtifactSummary, FileKind, Manifest, ViewName } from './ipc';

// The prefix of the selection's path when a pipeline is selected in place of a
// file. A pipeline explains several files, so it has no file of its own to
// select.
export const PIPELINE_PREFIX = 'pipeline:';

// True for an artifact that plays: a film, or a pipeline whose current version
// is a film.
export function showsFilm(
  artifact:
    | Pick<ArtifactSummary, 'kind' | 'form'>
    | Pick<Manifest, 'kind' | 'form'>
    | null
    | undefined,
): boolean {
  return (
    !!artifact &&
    (artifact.kind === 'film' ||
      (artifact.kind === 'pipeline' && artifact.form === 'film'))
  );
}

// The four views, in the order the interface lists them, each with the name
// it is shown under and one sentence on what it is for. A map is made of a
// folder, and the other three of a file.
export const VIEWS: { name: ViewName; label: string; about: string }[] = [
  {
    name: 'schema',
    label: 'Schema',
    about:
      'The data shapes of this code: every type with its fields, how the types refer to each other, and which code reads and writes each field.',
  },
  {
    name: 'lanes',
    label: 'Lanes',
    about:
      'Who talks to whom, in time order: the parties of an exchange as lanes, played one message at a time, with a scenario for each way it can go.',
  },
  {
    name: 'structure',
    label: 'Structure',
    about:
      'A data structure as it is in memory: type a sequence of operations and step through what each one does to it.',
  },
  {
    name: 'map',
    label: 'Map',
    about:
      'How the code of this folder is organised and how its parts use each other, level by level, down to single functions.',
  },
];

// What each view of a file is, in a few words, for a place too small for the
// sentence in `about`.
const SHORT: Record<FileKind, string> = {
  visual: 'A still blueprint of the code as a machine.',
  film: 'A narrated film of one flow across files.',
  stepthrough: 'Run the code on your own input, one step at a time.',
  schema: 'The types, their fields, and what reads and writes them.',
  lanes: 'Who talks to whom, one message at a time.',
  structure: 'A data structure in memory, one operation at a time.',
};

// The six kinds of artifact that can be made of one file, in the order the
// interface lists them. Each has the tab that shows it, the name it is shown
// under, a few words on what it is (`short`), and a full sentence on what it is
// for (`about`).
export const FILE_KINDS: {
  kind: FileKind;
  tab: 'visual' | 'film' | 'steps' | ViewName;
  label: string;
  short: string;
  about: string;
}[] = [
  {
    kind: 'visual',
    tab: 'visual',
    label: 'Blueprint',
    short: SHORT.visual,
    about:
      'A still blueprint of this code as a machine: its parts, the data that moves between them, its limits and its modes. Click a part to see what it does and where it is in the code.',
  },
  {
    kind: 'film',
    tab: 'film',
    label: 'Film',
    short: SHORT.film,
    about:
      'A film in chapters, with narration, of how one thing moves through this file and the files it works with.',
  },
  {
    kind: 'stepthrough',
    tab: 'steps',
    label: 'Step-through',
    short: SHORT.stepthrough,
    about:
      'The states of this code, which you run on an input of your own, one step at a time. It suits parsers, state machines and validators.',
  },
  ...VIEWS.filter((view) => view.name !== 'map').map((view) => ({
    kind: view.name as FileKind,
    tab: view.name,
    label: view.label,
    short: SHORT[view.name as FileKind],
    about: view.about,
  })),
];

// True for a kind of artifact that is one of the four views.
export function isView(kind: string | null | undefined): kind is ViewName {
  return VIEWS.some((view) => view.name === kind);
}

// True for a kind of artifact that is played one step at a time and so has
// the strip of step panels along the bottom of its frame: a step-through, a
// lanes view and a structure view.
export function isStepped(kind: string | null | undefined): boolean {
  return kind === 'stepthrough' || kind === 'lanes' || kind === 'structure';
}

// What an artifact is called in a sentence: "blueprint", "film", "pipeline",
// "step-through", "map", or "schema view" for a view. An artifact of the
// kind `visual` is called a blueprint everywhere the user reads its name.
export function kindWord(
  artifact: Pick<ArtifactSummary, 'kind'> | null | undefined,
): string {
  const kind = artifact?.kind ?? 'visual';
  if (kind === 'visual') return 'blueprint';
  if (kind === 'stepthrough') return 'step-through';
  if (kind === 'map') return 'map';
  return isView(kind) ? kind + ' view' : kind;
}

// A short count of an artifact's ports, such as "1 in · 2 out", or an empty
// string for none.
export function portCount(artifact: Pick<ArtifactSummary, 'ports'>): string {
  const ins = artifact.ports.filter((p) => p.dir === 'in').length;
  const outs = artifact.ports.filter((p) => p.dir === 'out').length;
  return ins + outs === 0 ? '' : `${ins} in · ${outs} out`;
}

// When an artifact was last generated: the newest `createdAt` among its
// versions, as milliseconds since 1970. Returns 0 for an artifact that has no
// version with a readable time.
export function lastMade(artifact: Pick<ArtifactSummary, 'versions'>): number {
  return artifact.versions.reduce((newest, version) => {
    const made = Date.parse(version.createdAt);
    return Number.isNaN(made) ? newest : Math.max(newest, made);
  }, 0);
}

// The artifacts in the order the library lists them: the one that was
// generated last comes first. Two artifacts generated at the same time are
// ordered by title. The given list is not changed.
export function newestFirst<
  T extends Pick<ArtifactSummary, 'versions' | 'title'>,
>(artifacts: T[]): T[] {
  return [...artifacts].sort(
    (a, b) => lastMade(b) - lastMade(a) || a.title.localeCompare(b.title),
  );
}

// Splits the text of a rationale into plain words and identifiers. An
// identifier is written between backticks in the text, and is shown as a code
// chip. A backtick without a partner stays in the plain words.
export function rationaleParts(
  text: string,
): { text: string; code: boolean }[] {
  const parts: { text: string; code: boolean }[] = [];
  let at = 0;
  for (const found of text.matchAll(/`([^`]+)`/g)) {
    if (found.index > at)
      parts.push({ text: text.slice(at, found.index), code: false });
    parts.push({ text: found[1], code: true });
    at = found.index + found[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), code: false });
  return parts;
}
