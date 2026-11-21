//! Assembles the prompts a job sends to an agent, from the prompt files bundled
//! with the app.
//!
//! Every job gets a system prompt (the core guide, the guide for the kind of
//! job, and the runtime's API reference) and a short user prompt that names the
//! files and carries the user's instructions. The files in `resources/prompts`
//! use two placeholder forms:
//!
//!   {{name}}                    replaced by the value
//!   {{#name}} ... {{/name}}     kept only when the value is not empty
//!   {{^name}} ... {{/name}}     kept only when the value is empty

use std::collections::BTreeMap;

/// Raised whenever a change to the prompt files could change what agents
/// produce. It is recorded in every manifest.
pub const PROMPT_VERSION: &str = "1.9.0";

macro_rules! prompt_file {
    ($name:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../resources/prompts/",
            $name
        ))
    };
}

const CORE: &str = prompt_file!("core.md");
const VISUALISE: &str = prompt_file!("visualise.md");
const ANIMATE: &str = prompt_file!("animate.md");
const COMPOSE: &str = prompt_file!("compose.md");
const STEPTHROUGH: &str = prompt_file!("stepthrough.md");
const VIEW: &str = prompt_file!("view.md");
const VIEW_SCHEMA: &str = prompt_file!("view-schema.md");
const VIEW_LANES: &str = prompt_file!("view-lanes.md");
const VIEW_STRUCTURE: &str = prompt_file!("view-structure.md");
const VIEW_MAP: &str = prompt_file!("view-map.md");
const USER_VIEW: &str = prompt_file!("user-view.md");
const FIX: &str = prompt_file!("fix.md");
const USER_VISUALISE: &str = prompt_file!("user-visualise.md");
const USER_ANIMATE: &str = prompt_file!("user-animate.md");
const USER_COMPOSE: &str = prompt_file!("user-compose.md");
const USER_STEPTHROUGH: &str = prompt_file!("user-stepthrough.md");
const USER_FIX_REPORT: &str = prompt_file!("user-fix-report.md");
const USER_FIX_FEEDBACK: &str = prompt_file!("user-fix-feedback.md");
const SUGGEST: &str = prompt_file!("suggest.md");
const USER_SUGGEST: &str = prompt_file!("user-suggest.md");

/// The values a prompt's placeholders are filled with.
pub type Values = BTreeMap<&'static str, String>;

/// Fills the placeholders of `template`. A placeholder with no value becomes
/// empty.
pub fn render(template: &str, values: &Values) -> String {
    let value = |name: &str| values.get(name).map(String::as_str).unwrap_or("");
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find("{{") {
        out.push_str(&rest[..open]);
        let after = &rest[open + 2..];
        let Some(close) = after.find("}}") else {
            out.push_str(&rest[open..]);
            return out;
        };
        let tag = &after[..close];
        let following = &after[close + 2..];
        if let Some(name) =
            tag.strip_prefix('#').or_else(|| tag.strip_prefix('^'))
        {
            let end_tag = format!("{{{{/{name}}}}}");
            let Some(end) = following.find(&end_tag) else {
                rest = following;
                continue;
            };
            let wanted = tag.starts_with('#') != value(name).trim().is_empty();
            if wanted {
                out.push_str(&render(&following[..end], values));
            }
            rest = &following[end + end_tag.len()..];
        } else {
            out.push_str(value(tag));
            rest = following;
        }
    }
    out.push_str(rest);
    out
}

/// The kinds of job that have their own guide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Guide {
    Visualise,
    Animate,
    Compose,
    Stepthrough,
    /// A view. The text is the view's name: `schema`, `lanes`, `structure`
    /// or `map`.
    View(&'static str),
    Fix,
}

/// The system prompt for a job: the core guide, then the job's guide, then the
/// runtime API.
pub fn system_prompt(guide: Guide, values: &Values) -> String {
    // A view's guide is the part all views share, then the view's own.
    let view;
    let job = match guide {
        Guide::Visualise => VISUALISE,
        Guide::Animate => ANIMATE,
        Guide::Compose => COMPOSE,
        Guide::Stepthrough => STEPTHROUGH,
        Guide::View(name) => {
            let own = match name {
                "lanes" => VIEW_LANES,
                "structure" => VIEW_STRUCTURE,
                "map" => VIEW_MAP,
                _ => VIEW_SCHEMA,
            };
            view = format!("{VIEW}\n\n{own}");
            view.as_str()
        }
        Guide::Fix => FIX,
    };
    let api = codjiva_build::runtime::runtime_api_doc();
    format!(
        "{}\n\n---\n\n{}\n\n---\n\n{}",
        render(CORE, values),
        render(job, values),
        api
    )
}

/// The system prompt for the question of which kind of artifact suits a file.
/// It stands alone: the agent draws nothing, so it gets neither the core
/// guide nor the runtime's API.
pub fn system_suggest() -> &'static str {
    SUGGEST
}

pub fn user_suggest(values: &Values) -> String {
    render(USER_SUGGEST, values)
}

pub fn user_visualise(values: &Values) -> String {
    render(USER_VISUALISE, values)
}

pub fn user_animate(values: &Values) -> String {
    render(USER_ANIMATE, values)
}

pub fn user_stepthrough(values: &Values) -> String {
    render(USER_STEPTHROUGH, values)
}

pub fn user_view(values: &Values) -> String {
    render(USER_VIEW, values)
}

pub fn user_compose(values: &Values) -> String {
    render(USER_COMPOSE, values)
}

pub fn user_fix_report(values: &Values) -> String {
    render(USER_FIX_REPORT, values)
}

pub fn user_fix_feedback(values: &Values) -> String {
    render(USER_FIX_FEEDBACK, values)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn values(pairs: &[(&'static str, &str)]) -> Values {
        pairs.iter().map(|(k, v)| (*k, v.to_string())).collect()
    }

    #[test]
    fn fills_values_and_keeps_or_drops_sections() {
        let template = "A {{x}}.{{#y}} Has y: {{y}}.{{/y}}{{^y}} No y.{{/y}} \
                        End {{missing}}.";
        assert_eq!(
            render(template, &values(&[("x", "1"), ("y", "2")])),
            "A 1. Has y: 2. End ."
        );
        assert_eq!(
            render(template, &values(&[("x", "1")])),
            "A 1. No y. End ."
        );
        assert_eq!(render("broken {{x", &values(&[])), "broken {{x");
    }

    #[test]
    fn the_visualise_prompts_name_the_folders_and_carry_the_instructions() {
        let v = values(&[
            ("artifactDir", ".codjiva/artifacts/a/v1"),
            ("srcDir", ".codjiva/artifacts/a/v1/src"),
            ("schemasDir", ".codjiva/jobs/j/schemas"),
            ("referenceDir", ".codjiva/jobs/j/reference"),
            ("subject", "src/a.go"),
            ("instructions", "Show the retry path"),
        ]);
        let system = system_prompt(Guide::Visualise, &v);
        assert!(system.contains("Write only inside `.codjiva/artifacts/a/v1`"));
        assert!(system.contains("# Job: Visualise"));
        assert!(system.contains("# Codjiva runtime API"));
        assert!(
            !system.contains("{{"),
            "an unfilled placeholder is left in the system prompt"
        );
        let user = user_visualise(&v);
        assert!(
            user.contains("Subject: src/a.go")
                && user.contains("Show the retry path")
        );
        assert!(
            !user.contains("gave no special instructions")
                && !user.contains("Also read")
                && !user.contains("{{")
        );
        let plain = user_visualise(&values(&[("subject", "src/a.go")]));
        assert!(plain.contains("gave no special instructions"));
    }

    #[test]
    fn the_animate_prompts_carry_the_length_the_outline_and_the_existing_visual(
    ) {
        let v = values(&[
            ("artifactDir", ".codjiva/artifacts/f/v1"),
            ("srcDir", ".codjiva/artifacts/f/v1/src"),
            ("schemasDir", "s"),
            ("referenceDir", "r"),
            ("subject", "src/a.go"),
            ("companions", "src/b.go, src/c.go"),
            ("length", "180"),
            ("outline", "1. Overview"),
            ("visual", ".codjiva/artifacts/v/v2"),
        ]);
        let system = system_prompt(Guide::Animate, &v);
        assert!(
            system.contains("# Job: Animate")
                && system.contains("**180 seconds**")
                && !system.contains("{{")
        );
        let user = user_animate(&v);
        assert!(
            user.contains("about 180 seconds")
                && user.contains(
                    "Companions (read these too): src/b.go, src/c.go"
                )
        );
        assert!(
            user.contains("Follow it exactly")
                && user.contains("1. Overview")
                && user.contains("exists at .codjiva/artifacts/v/v2")
        );
        let plain =
            user_animate(&values(&[("subject", "src/a.go"), ("length", "60")]));
        assert!(
            !plain.contains("approved this outline")
                && !plain.contains("still visual")
                && !plain.contains("Companions")
                && !plain.contains("{{")
        );
    }

    #[test]
    fn the_feedback_prompt_includes_only_what_the_user_gave() {
        let full = user_fix_feedback(&values(&[
            ("artifactDir", "d"),
            ("srcDir", "d/src"),
            ("feedback", "The bubble covers the gauge"),
            ("time", "72.5"),
            ("chapter", "3 · Limits"),
            ("scene", "limits"),
            ("sceneTime", "4.2"),
            ("pointAt", "{\"selector\":\".limits-bub1\"}"),
            ("screenshot", ".codjiva/jobs/j/frame.png"),
        ]));
        assert!(
            full.contains("The bubble covers the gauge")
                && full.contains("72.5 seconds")
                && full.contains("chapter \"3 · Limits\"")
        );
        assert!(
            full.contains("animation second 4.2 of scene `limits`")
                && full.contains(".limits-bub1")
                && full.contains("frame.png")
                && !full.contains("{{")
        );
        let bare = user_fix_feedback(&values(&[
            ("artifactDir", "d"),
            ("srcDir", "d/src"),
            ("feedback", "Shorter labels please"),
        ]));
        assert!(
            !bare.contains("They were at")
                && !bare.contains("pointed at")
                && !bare.contains("screenshot")
                && !bare.contains("selected")
                && !bare.contains("{{")
        );
    }

    #[test]
    fn no_prompt_names_a_default_language_or_the_old_product_name() {
        for text in [
            CORE,
            VISUALISE,
            ANIMATE,
            COMPOSE,
            FIX,
            USER_VISUALISE,
            USER_ANIMATE,
            USER_COMPOSE,
            USER_FIX_REPORT,
            USER_FIX_FEEDBACK,
        ] {
            assert!(
                !text.contains("Codeviz") && !text.contains("CV."),
                "an old name is left in a prompt"
            );
        }
    }
}
