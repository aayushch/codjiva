// The words the source view shows for the last change of a line, kept apart
// from the components so they can be tested.

import type { Blame } from './ipc';

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
// The units a length of time is told in, from the longest. Each has the
// number of seconds in it. A month counts as 30 days and a year as 365.
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * DAY],
  ['month', 30 * DAY],
  ['week', 7 * DAY],
  ['day', DAY],
  ['hour', HOUR],
  ['minute', MINUTE],
];

// How long before `now` the time `then` was, in words such as "5 minutes
// ago", "yesterday" or "last week". Both are in seconds since the start of
// 1970. The longest unit that fits at least once is used. Less than a
// minute, and a time after `now`, is "just now".
export function agoOf(then: number, now: number): string {
  const passed = now - then;
  const unit = UNITS.find(([, seconds]) => passed >= seconds);
  if (!unit) return 'just now';
  return new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
    -Math.floor(passed / unit[1]),
    unit[0],
  );
}

// Who made a change, as the source view names them: "You" for the user's own
// commit and the author's name for any other.
export const whoOf = (blame: Blame) => (blame.byUser ? 'You' : blame.author);

// The text at the end of a line for its last change. A line that is not
// committed says so. `now` is in seconds since the start of 1970.
export function blameLabel(blame: Blame, now: number): string {
  if (!blame.committed) return 'Not committed yet';
  return `${whoOf(blame)}, ${agoOf(blame.time, now)} • ${blame.summary}`;
}

// The day and the time of a commit in the user's own notation, such as
// "14 November 2026 at 22:50".
export const dateOf = (time: number) =>
  new Date(time * 1000).toLocaleString(undefined, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
