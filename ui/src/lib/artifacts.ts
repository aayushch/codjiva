// Small questions about artifacts that several components ask.

import type { ArtifactSummary, Manifest } from './ipc';

// The prefix of the selection's path when a pipeline is selected in place of a file. A pipeline
// explains several files, so it has no file of its own to select.
export const PIPELINE_PREFIX = 'pipeline:';

// True for an artifact that plays: a film, or a pipeline whose current version is a film.
export function showsFilm(artifact: Pick<ArtifactSummary, 'kind' | 'form'> | Pick<Manifest, 'kind' | 'form'> | null | undefined): boolean {
  return !!artifact && (artifact.kind === 'film' || (artifact.kind === 'pipeline' && artifact.form === 'film'));
}

// What an artifact is called in a sentence: "visual", "film" or "pipeline".
export function kindWord(artifact: Pick<ArtifactSummary, 'kind'> | null | undefined): string {
  return artifact?.kind ?? 'visual';
}

// A short count of an artifact's ports, such as "1 in · 2 out", or an empty string for none.
export function portCount(artifact: Pick<ArtifactSummary, 'ports'>): string {
  const ins = artifact.ports.filter((p) => p.dir === 'in').length;
  const outs = artifact.ports.filter((p) => p.dir === 'out').length;
  return ins + outs === 0 ? '' : `${ins} in · ${outs} out`;
}
