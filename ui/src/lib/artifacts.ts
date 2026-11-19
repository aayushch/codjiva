// Small questions about artifacts that several components ask.

import type { ArtifactSummary, Manifest, ViewName } from './ipc';

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

// What an artifact is called in a sentence: "visual", "film", "pipeline",
// "step-through", "map", or "schema view" for a view.
export function kindWord(
  artifact: Pick<ArtifactSummary, 'kind'> | null | undefined,
): string {
  const kind = artifact?.kind ?? 'visual';
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
