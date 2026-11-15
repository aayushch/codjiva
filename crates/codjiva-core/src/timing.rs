//! Estimates how long a job will take, before it starts.
//!
//! An estimate is made in two steps.
//!
//! The first step is a formula, [`formula_seconds`]. It works from what is
//! known before the job starts, which is collected in a [`JobShape`]: the kind
//! of job, how long a film should be, how much code the agent reads and how
//! many branches that code has, and whether the agent starts from an earlier
//! result. The constants of the formula match jobs that were timed with a
//! command-line agent and a mid-size model. The tests at the end of this file
//! hold those timings.
//!
//! The second step corrects the formula with the user's own jobs. Every job
//! that finishes is saved as a [`Timing`] in `timings.json` in the app's
//! settings folder: its `JobShape` and the seconds it took. [`estimate`]
//! divides the seconds of each earlier job by what the formula says for that
//! job. It multiplies the formula's answer for the new job by the middle one
//! of those ratios. A slower model, a faster agent or unusually dense code
//! all show up in the ratios, so the estimate follows them after a few jobs.
//!
//! The same code can take one agent four minutes on one day and seven on the
//! next, so an [`Estimate`] is a range and not one number.
//!
//! `timings.json` holds numbers and the names of the agent and the model. It
//! holds no file names and no code.

use crate::artifacts::{self, ArtifactKind};
use crate::companions;
use crate::error::Result;
use crate::jobs::{JobKind, JobRequest};
use crate::util;
use crate::workspace::Workspace;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// The file in the settings folder that holds the finished jobs.
const FILE: &str = "timings.json";

/// How many finished jobs are kept. The oldest are dropped first.
const KEEP: usize = 200;

/// A file larger than this is not read when code is measured. It counts as
/// empty. Source files of this size are generated or are data.
const MEASURE_LIMIT_BYTES: u64 = 4 * 1024 * 1024;

/// How much one branch adds to the weight of code, in lines.
const BRANCH_LINES: f64 = 1.5;

/// The share of a companion file's weight that counts. The agent reads a
/// companion to understand the subject and draws little of it.
const COMPANION_SHARE: f64 = 0.25;

/// Up to this weight, every unit of weight adds one second. Above it the
/// agent's work grows much more slowly, because a drawing holds a limited
/// number of parts however long the code is. [`effective_weight`] applies
/// this.
const LINEAR_WEIGHT: f64 = 300.0;
const SECONDS_ABOVE_LINEAR: f64 = 100.0;

/// A visual takes at least this long, however short the file is.
const VISUAL_MIN_SECONDS: f64 = 30.0;

/// The share of the time for a visual that the agent needs when it makes a
/// visual of a file again and starts from the version that exists.
const REGENERATE_SHARE: f64 = 0.5;

/// A film is a drawing and a number of chapters. The drawing takes this share
/// of the time for a visual of the same code, because a film's drawing is
/// simpler. It takes the smaller share when the agent starts from a visual or
/// a film that already exists.
const FILM_DRAWING_SHARE: f64 = 0.5;
const FILM_DRAWING_SHARE_WITH_START: f64 = 0.15;

/// The seconds a film needs besides its drawing: a fixed part for the outline,
/// and a part for each chapter.
const FILM_BASE_SECONDS: f64 = 30.0;
const SECONDS_PER_CHAPTER: f64 = 60.0;

/// A pipeline reuses the drawings of its parts, so it takes a fixed part, a
/// part for each artifact it joins and, as a film, a part for each chapter.
const COMPOSE_BASE_SECONDS: f64 = 30.0;
const COMPOSE_SECONDS_PER_PART: f64 = 15.0;
const COMPOSE_SECONDS_PER_CHAPTER: f64 = 32.0;

/// A feedback job changes a small part of a finished version.
const FEEDBACK_SECONDS: f64 = 45.0;

/// What every job adds after the agent has written: building the page and
/// running its self-test.
const CHECK_SECONDS: f64 = 15.0;

/// The range around the formula's answer while fewer than [`ENOUGH_JOBS`]
/// earlier jobs are known. The timed jobs lie between these two factors.
const LOW_FACTOR: f64 = 0.6;
const HIGH_FACTOR: f64 = 1.5;

/// From this many earlier jobs on, the range comes from how far those jobs
/// spread, and no longer from [`LOW_FACTOR`] and [`HIGH_FACTOR`].
const ENOUGH_JOBS: usize = 3;

/// The most earlier jobs one estimate uses. Newer jobs say more about the
/// agent as it is now.
const RECENT_JOBS: usize = 12;

/// With enough earlier jobs, the range is still at least this wide around the
/// middle, so that three jobs that happened to take the same time do not
/// promise more than they can.
const NARROWEST_LOW: f64 = 0.8;
const NARROWEST_HIGH: f64 = 1.25;

/// One earlier job can move an estimate by at most these factors. A job that
/// took far longer than the formula says, for example because the computer
/// slept, would otherwise distort every later estimate.
const RATIO_MIN: f64 = 0.25;
const RATIO_MAX: f64 = 4.0;

/// The size of some code: its lines that hold code, and the branches in them.
#[derive(
    Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize,
)]
#[serde(rename_all = "camelCase", default)]
pub struct CodeSize {
    /// Lines that are neither empty nor only a comment.
    pub lines: u32,
    /// Places where the code chooses or repeats: `if`, `for`, `while`,
    /// `case`, `catch`, `&&`, `||` and the like.
    pub branches: u32,
}

impl CodeSize {
    /// One number for how much there is to understand in this code.
    fn weight(self) -> f64 {
        f64::from(self.lines) + BRANCH_LINES * f64::from(self.branches)
    }

    fn add(&mut self, other: CodeSize) {
        self.lines += other.lines;
        self.branches += other.branches;
    }
}

/// Words that start a branch or a loop in the languages the app is used with.
const BRANCH_WORDS: [&str; 16] = [
    "if", "elif", "for", "foreach", "while", "until", "loop", "switch", "case",
    "match", "select", "when", "catch", "except", "guard", "unless",
];

/// Measures source text.
///
/// The count is approximate and works the same for every language. A line
/// counts as code unless it is empty or starts like a comment. A branch is
/// one of [`BRANCH_WORDS`] as a whole word, or `&&` or `||`. A branch word
/// inside a string on a code line is counted too.
pub fn measure(text: &str) -> CodeSize {
    let mut size = CodeSize::default();
    for line in text.lines() {
        let line = line.trim();
        let comment = line.starts_with("//")
            || line.starts_with("/*")
            || line.starts_with("*/")
            || line.starts_with("* ")
            || line == "*"
            || line.starts_with("# ")
            || line == "#"
            || line.starts_with("-- ");
        if line.is_empty() || comment {
            continue;
        }
        size.lines += 1;
        let words = line
            .split(|c: char| !c.is_alphanumeric() && c != '_')
            .filter(|word| BRANCH_WORDS.contains(word))
            .count();
        let operators = line.matches("&&").count() + line.matches("||").count();
        size.branches += (words + operators) as u32;
    }
    size
}

/// Measures one file of the workspace. A file that cannot be read, is not
/// text or is larger than [`MEASURE_LIMIT_BYTES`] counts as empty.
fn measure_file(ws: &Workspace, rel: &str) -> CodeSize {
    let Ok(path) = ws.resolve(rel) else {
        return CodeSize::default();
    };
    let small = std::fs::metadata(&path)
        .is_ok_and(|meta| meta.is_file() && meta.len() <= MEASURE_LIMIT_BYTES);
    if !small {
        return CodeSize::default();
    }
    std::fs::read_to_string(&path)
        .map(|text| measure(&text))
        .unwrap_or_default()
}

/// What is known about a job before it starts, as far as it decides how long
/// the job takes.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct JobShape {
    pub kind: JobKind,
    /// True when the job makes a film: an Animate job, or a Compose job in
    /// film form.
    pub film: bool,
    /// For a film: how long it should be, in real seconds.
    pub length_seconds: u32,
    /// The code the job is about. For a folder, this is every code file in
    /// it.
    pub subject: CodeSize,
    /// The other files the agent reads.
    pub companions: CodeSize,
    /// For a Compose job: how many artifacts it joins.
    pub parts: u32,
    /// True when the agent starts from an earlier result. For a Visualise or
    /// an Animate job that is an earlier version of the same artifact. For an
    /// Animate job it is also a visual of the same file.
    pub has_start: bool,
    /// The id of the agent that runs the job, and the model it is asked for.
    pub agent: String,
    pub model: Option<String>,
}

/// Works out the [`JobShape`] of `request` in the workspace `ws`, for the
/// agent with the id `agent` and the model `model`.
///
/// It reads the subject and the companion files to measure them. It must be
/// called before the job runs, because `has_start` is about the versions that
/// exist before the job adds one.
pub fn shape(
    ws: &Workspace,
    request: &JobRequest,
    agent: &str,
    model: Option<String>,
) -> JobShape {
    let mut shape = JobShape {
        kind: request.kind,
        agent: agent.to_string(),
        model,
        ..JobShape::default()
    };
    match request.kind {
        JobKind::Feedback => {}
        JobKind::Compose => {
            shape.film = request.film;
            shape.parts = request.parts.len() as u32;
        }
        JobKind::Visualise | JobKind::Animate => {
            shape.film = request.kind == JobKind::Animate;
            let mut subject = request.subject.clone();
            for path in &request.subject {
                match path.strip_suffix('/') {
                    Some(dir) => {
                        let info = companions::folder_info(
                            ws,
                            dir,
                            &ws.indexed_files(),
                        );
                        for file in &info.files {
                            shape.subject.add(measure_file(ws, file));
                        }
                        subject = vec![format!("{}/", info.rel_path)];
                    }
                    None => shape.subject.add(measure_file(ws, path)),
                }
            }
            for path in &request.companions {
                shape.companions.add(measure_file(ws, path));
            }
            let exists = |kind: ArtifactKind| {
                let id = artifacts::artifact_id(kind, &subject);
                artifacts::read_meta(ws, &id).is_ok()
            };
            shape.has_start = if shape.film {
                exists(ArtifactKind::Film) || exists(ArtifactKind::Visual)
            } else {
                exists(ArtifactKind::Visual)
            };
        }
    }
    if shape.film {
        shape.length_seconds = request.length_seconds.unwrap_or(180);
    }
    shape
}

/// The weight that decides the agent's time. It is `weight` itself up to
/// [`LINEAR_WEIGHT`]. Above that it grows with the logarithm of `weight`:
/// code ten times as long as `LINEAR_WEIGHT` counts as about 530.
fn effective_weight(weight: f64) -> f64 {
    if weight <= LINEAR_WEIGHT {
        weight
    } else {
        LINEAR_WEIGHT + SECONDS_ABOVE_LINEAR * (weight / LINEAR_WEIGHT).ln()
    }
}

/// How many chapters a film of `length_seconds` usually has. The prompt for a
/// film asks for 4 to 8 chapters. A film of one minute has 4, a film of three
/// minutes 6 and a film of five minutes 8.
fn chapters_for(length_seconds: u32) -> f64 {
    f64::from((3 + length_seconds / 60).clamp(4, 8))
}

/// The seconds a job of this shape takes, by the formula alone.
pub fn formula_seconds(shape: &JobShape) -> f64 {
    let weight = effective_weight(
        shape.subject.weight() + COMPANION_SHARE * shape.companions.weight(),
    );
    let chapters = chapters_for(shape.length_seconds);
    let agent = match shape.kind {
        JobKind::Feedback => FEEDBACK_SECONDS,
        JobKind::Compose => {
            let film = if shape.film {
                chapters * COMPOSE_SECONDS_PER_CHAPTER
            } else {
                0.0
            };
            COMPOSE_BASE_SECONDS
                + COMPOSE_SECONDS_PER_PART * f64::from(shape.parts)
                + film
        }
        JobKind::Visualise => {
            let share = if shape.has_start {
                REGENERATE_SHARE
            } else {
                1.0
            };
            (weight * share).max(VISUAL_MIN_SECONDS)
        }
        JobKind::Animate => {
            let share = if shape.has_start {
                FILM_DRAWING_SHARE_WITH_START
            } else {
                FILM_DRAWING_SHARE
            };
            weight * share + FILM_BASE_SECONDS + chapters * SECONDS_PER_CHAPTER
        }
    };
    agent + CHECK_SECONDS
}

/// One finished job: what it was like and how long it took from the click to
/// the saved version.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Timing {
    #[serde(flatten)]
    pub shape: JobShape,
    pub seconds: f64,
    /// When the job finished, as an RFC 3339 timestamp.
    pub at: String,
}

/// How long a job is expected to take.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Estimate {
    /// Most jobs like this one finish between these two.
    pub low_seconds: u32,
    pub high_seconds: u32,
    /// The single most likely time.
    pub typical_seconds: u32,
    /// How many earlier jobs the estimate was corrected with. With 0 it is
    /// the formula alone.
    pub samples: u32,
}

/// The earlier jobs that say most about a job of `shape`, oldest first.
///
/// Only jobs run by the same agent are used, because agents differ in speed.
/// Among them, the first of these groups that has at least [`ENOUGH_JOBS`]
/// jobs is taken:
///
///   - Jobs with the same model that made the same thing. "The same thing"
///     means the same kind of job and, for a Compose job, the same form.
///   - Jobs with the same model.
///   - All jobs of the agent.
///
/// If no group has that many, all jobs of the agent are taken.
fn comparable<'a>(shape: &JobShape, history: &'a [Timing]) -> Vec<&'a Timing> {
    let by_agent: Vec<&Timing> = history
        .iter()
        .filter(|t| t.shape.agent == shape.agent && t.seconds > 0.0)
        .collect();
    let by_model: Vec<&Timing> = by_agent
        .iter()
        .copied()
        .filter(|t| t.shape.model == shape.model)
        .collect();
    let same_thing: Vec<&Timing> = by_model
        .iter()
        .copied()
        .filter(|t| t.shape.kind == shape.kind && t.shape.film == shape.film)
        .collect();
    let chosen = if same_thing.len() >= ENOUGH_JOBS {
        same_thing
    } else if by_model.len() >= ENOUGH_JOBS {
        by_model
    } else {
        by_agent
    };
    let skip = chosen.len().saturating_sub(RECENT_JOBS);
    chosen.into_iter().skip(skip).collect()
}

/// The value at `share` of the way through `sorted`, from 0.0 for the first
/// to 1.0 for the last. Between two values it is interpolated. `sorted` must
/// not be empty.
fn quantile(sorted: &[f64], share: f64) -> f64 {
    let position = share * (sorted.len() - 1) as f64;
    let below = position.floor() as usize;
    let above = position.ceil() as usize;
    sorted[below] + (sorted[above] - sorted[below]) * (position - below as f64)
}

/// Estimates how long a job of `shape` takes, given the finished jobs in
/// `history`, oldest first.
///
/// Each comparable earlier job gives a ratio: the seconds it took, divided by
/// the formula's answer for it.
///
///   - With at least [`ENOUGH_JOBS`] ratios, the typical time is the
///     formula's answer times the middle ratio. The range goes from the ratio
///     a fifth of the way up to the ratio four fifths of the way up, and is
///     never narrower than [`NARROWEST_LOW`] to [`NARROWEST_HIGH`] of the
///     typical time.
///   - With fewer ratios, each missing one counts as 1, which is the formula
///     unchanged. The typical time is the formula's answer times the average,
///     and the range is [`LOW_FACTOR`] to [`HIGH_FACTOR`] of it.
pub fn estimate(shape: &JobShape, history: &[Timing]) -> Estimate {
    let formula = formula_seconds(shape);
    let mut ratios: Vec<f64> = comparable(shape, history)
        .iter()
        .map(|t| {
            (t.seconds / formula_seconds(&t.shape)).clamp(RATIO_MIN, RATIO_MAX)
        })
        .collect();
    ratios.sort_by(f64::total_cmp);
    let (low, typical, high) = if ratios.len() >= ENOUGH_JOBS {
        let middle = quantile(&ratios, 0.5);
        (
            quantile(&ratios, 0.2).min(middle * NARROWEST_LOW),
            middle,
            quantile(&ratios, 0.8).max(middle * NARROWEST_HIGH),
        )
    } else {
        let missing = (ENOUGH_JOBS - ratios.len()) as f64;
        let average =
            (ratios.iter().sum::<f64>() + missing) / ENOUGH_JOBS as f64;
        (average * LOW_FACTOR, average, average * HIGH_FACTOR)
    };
    Estimate {
        low_seconds: (formula * low).round() as u32,
        high_seconds: (formula * high).round() as u32,
        typical_seconds: (formula * typical).round() as u32,
        samples: ratios.len() as u32,
    }
}

/// The finished jobs saved in the settings folder `config_dir`, oldest first.
/// A file that is missing or cannot be read gives an empty list.
pub fn load(config_dir: &Path) -> Vec<Timing> {
    util::read_json(&config_dir.join(FILE))
        .ok()
        .flatten()
        .unwrap_or_default()
}

/// Adds a finished job to the saved list and drops the oldest jobs beyond
/// [`KEEP`].
pub fn record(config_dir: &Path, timing: Timing) -> Result<()> {
    let mut list = load(config_dir);
    list.push(timing);
    let extra = list.len().saturating_sub(KEEP);
    list.drain(..extra);
    util::write_json(&config_dir.join(FILE), &list)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn size(lines: u32, branches: u32) -> CodeSize {
        CodeSize { lines, branches }
    }

    fn visual(subject: CodeSize, companions: CodeSize) -> JobShape {
        JobShape {
            kind: JobKind::Visualise,
            subject,
            companions,
            agent: "claude-code".into(),
            ..JobShape::default()
        }
    }

    fn film(
        subject: CodeSize,
        companions: CodeSize,
        length_seconds: u32,
    ) -> JobShape {
        JobShape {
            kind: JobKind::Animate,
            film: true,
            length_seconds,
            ..visual(subject, companions)
        }
    }

    fn timing(shape: &JobShape, seconds: f64) -> Timing {
        Timing {
            shape: shape.clone(),
            seconds,
            at: "2026-11-15T10:00:00Z".into(),
        }
    }

    #[test]
    fn code_is_measured_without_empty_lines_and_comments() {
        let text = "\
// Sends one order.
func send(o Order) error {

    if o.Empty() || o.Closed() {
        return errEmpty
    }
    for _, line := range o.Lines {
        switch line.Kind {
        case Gift:
            wrap(line)
        }
    }
    return nil
}
";
        // The `||`, `if`, `for`, `switch` and `case` are five branches.
        assert_eq!(measure(text), size(12, 5));
        assert_eq!(
            measure("# a note\n#\n-- a note\n/* a\n * b\n */\n"),
            size(0, 0)
        );
        // A line that starts with `#` and no space is code.
        assert_eq!(measure("#include <a.h>\n#define N 4\n"), size(2, 0));
        // A word that only contains a branch word is not a branch.
        assert_eq!(measure("notify(format, iffy)\n"), size(1, 0));
    }

    #[test]
    fn the_range_of_the_formula_holds_the_jobs_that_were_timed() {
        // Each row is one job run by a command-line agent: its shape, and the
        // seconds the agent took.
        let none = size(0, 0);
        let again = JobShape {
            has_start: true,
            ..visual(size(152, 24), none)
        };
        let film_from_visual = JobShape {
            has_start: true,
            ..film(size(225, 33), size(129, 18), 60)
        };
        let pipeline = JobShape {
            kind: JobKind::Compose,
            parts: 2,
            agent: "claude-code".into(),
            ..JobShape::default()
        };
        let pipeline_film = JobShape {
            film: true,
            length_seconds: 180,
            ..pipeline.clone()
        };
        let timed: [(JobShape, f64); 12] = [
            (visual(size(63, 5), none), 70.0),
            (visual(size(152, 24), none), 178.0),
            (again, 67.0),
            (visual(size(225, 33), none), 294.0),
            (visual(size(207, 31), size(95, 7)), 263.0),
            (visual(size(213, 43), size(113, 13)), 449.0),
            (visual(size(213, 43), size(187, 29)), 345.0),
            (film_from_visual, 349.0),
            (film(size(207, 31), size(165, 17), 60), 632.0),
            (film(size(661, 84), size(4201, 550), 180), 393.0),
            (pipeline, 50.0),
            (pipeline_film, 234.0),
        ];
        for (shape, seconds) in timed {
            let range = estimate(&shape, &[]);
            assert!(
                f64::from(range.low_seconds) <= seconds
                    && seconds <= f64::from(range.high_seconds),
                "{seconds} s is outside {range:?} for {shape:?}"
            );
            assert_eq!(range.samples, 0);
        }
    }

    #[test]
    fn longer_films_and_heavier_code_take_longer() {
        let small = size(60, 4);
        let large = size(900, 160);
        let none = size(0, 0);
        let seconds = |shape: &JobShape| estimate(shape, &[]).typical_seconds;
        assert!(seconds(&visual(small, none)) < seconds(&visual(large, none)));
        assert!(
            seconds(&film(large, none, 60)) < seconds(&film(large, none, 180))
        );
        assert!(
            seconds(&film(large, none, 180)) < seconds(&film(large, none, 300))
        );
        // The same lines with more branches weigh more.
        assert!(
            seconds(&visual(size(200, 5), none))
                < seconds(&visual(size(200, 60), none))
        );
        // Starting from a visual that exists saves part of the drawing.
        let from_visual = JobShape {
            has_start: true,
            ..film(large, none, 180)
        };
        assert!(seconds(&from_visual) < seconds(&film(large, none, 180)));
    }

    #[test]
    fn earlier_jobs_of_the_same_agent_correct_the_formula() {
        let shape = film(size(300, 40), size(200, 20), 180);
        let formula = formula_seconds(&shape);
        // Three earlier films all took twice what the formula says.
        let history: Vec<Timing> = [60, 180, 300]
            .iter()
            .map(|&length| {
                let earlier = film(size(250, 30), size(0, 0), length);
                timing(&earlier, 2.0 * formula_seconds(&earlier))
            })
            .collect();
        let corrected = estimate(&shape, &history);
        assert_eq!(corrected.samples, 3);
        assert_eq!(corrected.typical_seconds, (2.0 * formula).round() as u32);
        assert_eq!(
            corrected.low_seconds,
            (2.0 * NARROWEST_LOW * formula).round() as u32
        );
        assert_eq!(
            corrected.high_seconds,
            (2.0 * NARROWEST_HIGH * formula).round() as u32
        );

        // One earlier job moves the estimate a third of the way.
        let one = estimate(&shape, &history[..1]);
        assert_eq!(one.samples, 1);
        assert_eq!(one.typical_seconds, (formula * 4.0 / 3.0).round() as u32);

        // Jobs of another agent say nothing about this one.
        let other = JobShape {
            agent: "cursor-agent".into(),
            ..shape.clone()
        };
        assert_eq!(estimate(&other, &history), estimate(&other, &[]));
    }

    #[test]
    fn jobs_with_the_same_model_that_made_the_same_thing_are_preferred() {
        let shape = JobShape {
            model: Some("large".into()),
            ..film(size(300, 40), size(0, 0), 180)
        };
        let mut history = Vec::new();
        // Visuals with another model were as fast as the formula says.
        for _ in 0..5 {
            let earlier = visual(size(100, 10), size(0, 0));
            history.push(timing(&earlier, formula_seconds(&earlier)));
        }
        // Films with this model took three times as long.
        for _ in 0..3 {
            history.push(timing(&shape, 3.0 * formula_seconds(&shape)));
        }
        let corrected = estimate(&shape, &history);
        assert_eq!(corrected.samples, 3);
        assert_eq!(
            corrected.typical_seconds,
            (3.0 * formula_seconds(&shape)).round() as u32
        );
    }

    #[test]
    fn one_very_slow_job_cannot_move_the_estimate_far() {
        let shape = visual(size(200, 20), size(0, 0));
        let formula = formula_seconds(&shape);
        let history = vec![timing(&shape, 500.0 * formula)];
        let corrected = estimate(&shape, &history);
        // The ratio counts as RATIO_MAX, next to two ratios of 1.
        assert_eq!(
            corrected.typical_seconds,
            (formula * (RATIO_MAX + 2.0) / 3.0).round() as u32
        );
    }

    #[test]
    fn finished_jobs_are_saved_and_only_the_newest_are_kept() {
        let config = tempfile::tempdir().unwrap();
        assert!(load(config.path()).is_empty());
        let shape = film(size(120, 9), size(40, 2), 300);
        for n in 0..KEEP + 5 {
            record(config.path(), timing(&shape, n as f64)).unwrap();
        }
        let saved = load(config.path());
        assert_eq!(saved.len(), KEEP);
        assert_eq!(saved[0].seconds, 5.0);
        assert_eq!(saved[KEEP - 1].shape, shape);

        // The file names the agent and holds numbers. A file that cannot be
        // read counts as no history.
        let text = fs::read_to_string(config.path().join(FILE)).unwrap();
        assert!(text.contains("\"agent\": \"claude-code\""));
        assert!(text.contains("\"lengthSeconds\": 300"));
        fs::write(config.path().join(FILE), "not json").unwrap();
        assert!(load(config.path()).is_empty());
    }

    #[test]
    fn the_shape_of_a_request_is_read_from_the_workspace() {
        let dir = tempfile::tempdir().unwrap();
        let write = |rel: &str, text: &str| {
            let path = dir.path().join(rel);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        };
        write(
            "src/a.go",
            "func a() {\n    if x {\n        b()\n    }\n}\n",
        );
        write("src/b.go", "// helper\nfunc b() {\n}\n");
        let ws = Workspace::open(dir.path()).unwrap();

        let request = JobRequest {
            kind: JobKind::Animate,
            subject: vec!["src/a.go".into()],
            companions: vec!["src/b.go".into(), "src/missing.go".into()],
            length_seconds: Some(300),
            ..JobRequest::default()
        };
        let found = shape(&ws, &request, "claude-code", Some("m".into()));
        assert_eq!(
            found,
            JobShape {
                kind: JobKind::Animate,
                film: true,
                length_seconds: 300,
                subject: size(5, 1),
                companions: size(2, 0),
                parts: 0,
                has_start: false,
                agent: "claude-code".into(),
                model: Some("m".into()),
            }
        );

        let compose = JobRequest {
            kind: JobKind::Compose,
            parts: vec!["one".into(), "two".into(), "three".into()],
            film: false,
            ..JobRequest::default()
        };
        let found = shape(&ws, &compose, "claude-code", None);
        assert_eq!(
            (found.parts, found.film, found.length_seconds),
            (3, false, 0)
        );
    }
}
