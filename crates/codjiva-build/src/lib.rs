//! Builds a Codjiva artifact.
//!
//! An agent writes a small set of source files: a plant (`plant.js`), a
//! declarative description (`film.json` for a film, `visual.json` for a still
//! visual), one module per chapter for films (`scenes/<id>.js`) and an optional
//! `extra.css`. This crate checks those files and joins them with the bundled
//! runtime, theme and fonts into one self-contained `index.html` that makes no
//! external request.

pub mod runtime;
pub mod scan;

use serde::Serialize;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::path::Path;

pub use runtime::RUNTIME_VERSION;

/// Built artifacts above this size get a warning. The reference film is about
/// 150 KB.
pub const SIZE_TARGET_BYTES: usize = 400 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Error,
    Warning,
}

/// One problem found in the sources. `file` is relative to the source folder.
/// Diagnostics are sent back to the agent as they are, so each message says
/// what to change.
#[derive(Debug, Clone, Serialize)]
pub struct Diagnostic {
    pub check: String,
    pub severity: Severity,
    pub file: String,
    pub line: Option<usize>,
    pub message: String,
}

impl Diagnostic {
    fn error(check: &str, file: &str, message: impl Into<String>) -> Self {
        Diagnostic {
            check: check.into(),
            severity: Severity::Error,
            file: file.into(),
            line: None,
            message: message.into(),
        }
    }

    fn warning(check: &str, file: &str, message: impl Into<String>) -> Self {
        Diagnostic {
            check: check.into(),
            severity: Severity::Warning,
            file: file.into(),
            line: None,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for Diagnostic {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let level = if self.severity == Severity::Error {
            "error"
        } else {
            "warning"
        };
        match self.line {
            Some(line) => write!(
                f,
                "{}:{}: {} [{}] {}",
                self.file, line, level, self.check, self.message
            ),
            None => write!(
                f,
                "{}: {} [{}] {}",
                self.file, level, self.check, self.message
            ),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind {
    Visual,
    Film,
}

/// A successful build.
#[derive(Debug)]
pub struct Built {
    pub kind: ArtifactKind,
    pub title: String,
    /// The complete `index.html`.
    pub html: String,
    /// Problems that did not stop the build.
    pub warnings: Vec<Diagnostic>,
}

/// A failed build. `diagnostics` holds at least one error and may also hold
/// warnings.
#[derive(Debug, thiserror::Error)]
#[error(
    "the artifact sources have {} problem(s)",
    diagnostics.iter().filter(|d| d.severity == Severity::Error).count()
)]
pub struct BuildFailure {
    pub diagnostics: Vec<Diagnostic>,
}

/// The sources of one artifact, already read into memory. Paths are relative to
/// the source folder and use `/` on every platform.
#[derive(Debug, Default, Clone)]
pub struct Sources {
    pub film_json: Option<String>,
    pub visual_json: Option<String>,
    pub plant_js: Option<String>,
    /// `(scene id, source)` for every file in `scenes/`.
    pub scenes: Vec<(String, String)>,
    pub extra_css: Option<String>,
    /// For a view: the data the runtime draws it from. A view has no plant
    /// and no drawing code.
    pub view_json: Option<String>,
    /// For a step-through and for a structure view: the step function, which
    /// restates what the code does with an input. Absent for anything else.
    pub sim_js: Option<String>,
    /// For a pipeline: which artifacts it joins and where each sits. Absent for
    /// anything else.
    pub pipeline_json: Option<String>,
    /// For a pipeline: `(part key, source)` for every `parts/<key>/plant.js`.
    pub parts: Vec<(String, String)>,
    /// Other files found in the folder. They are not built, only reported.
    pub unexpected: Vec<String>,
}

impl Sources {
    /// Reads an artifact source folder. A file that is missing is simply absent
    /// from the result; `build` reports what is required.
    pub fn read_dir(dir: &Path) -> std::io::Result<Sources> {
        let mut sources = Sources::default();
        let read = |name: &str| -> std::io::Result<Option<String>> {
            match fs::read_to_string(dir.join(name)) {
                Ok(text) => Ok(Some(text)),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(e),
            }
        };
        sources.film_json = read("film.json")?;
        sources.visual_json = read("visual.json")?;
        sources.plant_js = read("plant.js")?;
        sources.extra_css = read("extra.css")?;
        sources.sim_js = read("sim.js")?;
        sources.view_json = read("view.json")?;
        sources.pipeline_json = read("pipeline.json")?;
        let parts_dir = dir.join("parts");
        if parts_dir.is_dir() {
            for entry in fs::read_dir(&parts_dir)? {
                let entry = entry?;
                let key = entry.file_name().to_string_lossy().into_owned();
                match fs::read_to_string(entry.path().join("plant.js")) {
                    Ok(code) => sources.parts.push((key, code)),
                    Err(_) if !key.starts_with('.') => {
                        sources.unexpected.push(format!("parts/{key}"))
                    }
                    Err(_) => {}
                }
            }
        }
        sources.parts.sort();
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            let known = matches!(
                name.as_str(),
                "film.json"
                    | "visual.json"
                    | "plant.js"
                    | "extra.css"
                    | "sim.js"
                    | "view.json"
                    | "scenes"
                    | "pipeline.json"
                    | "parts"
            );
            if !known && !name.starts_with('.') {
                sources.unexpected.push(name);
            }
        }
        let scenes_dir = dir.join("scenes");
        if scenes_dir.is_dir() {
            for entry in fs::read_dir(&scenes_dir)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                match name.strip_suffix(".js") {
                    Some(id) => sources.scenes.push((
                        id.to_string(),
                        fs::read_to_string(entry.path())?,
                    )),
                    None if !name.starts_with('.') => {
                        sources.unexpected.push(format!("scenes/{name}"))
                    }
                    None => {}
                }
            }
        }
        sources.scenes.sort();
        sources.unexpected.sort();
        Ok(sources)
    }
}

/// Reads the folder `dir` and builds it. See [`build`].
pub fn build_dir(dir: &Path) -> Result<Built, BuildFailure> {
    let sources = Sources::read_dir(dir).map_err(|e| BuildFailure {
        diagnostics: vec![Diagnostic::error(
            "read",
            ".",
            format!("could not read the source folder: {e}"),
        )],
    })?;
    build(&sources)
}

/// Checks the sources and, if they have no errors, returns the built
/// `index.html`.
///
/// A folder with `film.json` is built as a film. A folder without it but with
/// `visual.json` is built as a still visual. A folder with neither but with
/// `view.json` is built as a view.
pub fn build(sources: &Sources) -> Result<Built, BuildFailure> {
    if let (None, None, Some(text)) =
        (&sources.film_json, &sources.visual_json, &sources.view_json)
    {
        return build_view(sources, text);
    }
    let mut found: Vec<Diagnostic> = Vec::new();

    let (kind, json_name, json_text, schema) =
        match (&sources.film_json, &sources.visual_json) {
            (Some(text), _) => {
                (ArtifactKind::Film, "film.json", text, runtime::FILM_SCHEMA)
            }
            (None, Some(text)) => (
                ArtifactKind::Visual,
                "visual.json",
                text,
                runtime::VISUAL_SCHEMA,
            ),
            (None, None) => {
                return Err(BuildFailure {
                    diagnostics: vec![Diagnostic::error(
                        "missing-file",
                        "film.json",
                        "neither film.json nor visual.json exists; write one \
                         of them",
                    )],
                })
            }
        };

    for name in &sources.unexpected {
        if name == "index.html" {
            found.push(Diagnostic::error(
                "unexpected-file",
                name,
                "do not write index.html; the app builds it from your \
                 sources. Delete this file",
            ));
        } else {
            found.push(Diagnostic::warning(
                "unexpected-file",
                name,
                "this file is not part of an artifact and is ignored",
            ));
        }
    }

    let data = validate_json(json_name, json_text, schema, &mut found);
    if let Some(data) = &data {
        lint_legend(data, json_name, &mut found);
    }

    let plant = sources.plant_js.as_deref();
    match plant {
        Some(code) => {
            found.extend(scan::scan_js("plant.js", code));
            if !code.contains("definePlant") {
                found.push(Diagnostic::error(
                    "plant",
                    "plant.js",
                    "plant.js must call CJ.definePlant({ draw, refs, set, \
                     routes, nodes, ports })",
                ));
            }
        }
        None => found.push(Diagnostic::error(
            "missing-file",
            "plant.js",
            "plant.js is missing; it must call CJ.definePlant({...})",
        )),
    }

    let mut scene_order: Vec<&(String, String)> = Vec::new();
    if kind == ArtifactKind::Film {
        if let Some(film) = &data {
            lint_film(film, &mut found);
            let ids: Vec<&str> = film["scenes"]
                .as_array()
                .map(|a| a.iter().filter_map(|s| s["id"].as_str()).collect())
                .unwrap_or_default();
            for id in &ids {
                match sources.scenes.iter().find(|(name, _)| name == id) {
                    Some(scene) => scene_order.push(scene),
                    None => found.push(Diagnostic::error(
                        "missing-file",
                        &format!("scenes/{id}.js"),
                        format!(
                            "film.json lists scene \"{id}\" but \
                             scenes/{id}.js does not exist"
                        ),
                    )),
                }
            }
            for (name, _) in &sources.scenes {
                if !ids.contains(&name.as_str()) {
                    found.push(Diagnostic::error(
                        "unexpected-file",
                        &format!("scenes/{name}.js"),
                        format!(
                            "no scene with id \"{name}\" is listed in \
                             film.json; add it there or delete the file"
                        ),
                    ));
                }
            }
        }
        for (id, code) in &sources.scenes {
            let file = format!("scenes/{id}.js");
            found.extend(scan::scan_js(&file, code));
            if !code.contains("CJ.scene(") {
                found.push(Diagnostic::error(
                    "scene",
                    &file,
                    format!(
                        "this file must call CJ.scene('{id}', {{ init, render \
                         }})"
                    ),
                ));
            }
        }
    } else {
        for (id, _) in &sources.scenes {
            found.push(Diagnostic::warning(
                "unexpected-file",
                &format!("scenes/{id}.js"),
                "a still visual has no scenes; this file is ignored",
            ));
        }
        if let Some(visual) = &data {
            lint_visual(visual, &mut found);
        }
    }

    // A visual with a `stepper` is a step-through, and needs its step
    // function. A step function without a `stepper` has nothing to drive.
    let stepper = kind == ArtifactKind::Visual
        && data.as_ref().is_some_and(|d| d["stepper"].is_object());
    match (&sources.sim_js, stepper) {
        (Some(code), true) => {
            found.extend(scan::scan_js("sim.js", code));
            found.extend(scan::scan_sim("sim.js", code));
            if !code.contains("CJ.defineSim(") {
                found.push(Diagnostic::error(
                    "sim",
                    "sim.js",
                    "sim.js must call CJ.defineSim({ init, step, vars, \
                     outputs })",
                ));
            }
            if let Some(visual) = &data {
                lint_stepper(visual, &mut found);
            }
        }
        (None, true) => found.push(Diagnostic::error(
            "missing-file",
            "sim.js",
            "visual.json has a \"stepper\", so sim.js is needed; it must \
             call CJ.defineSim({ init, step, vars, outputs })",
        )),
        (Some(_), false) => found.push(Diagnostic::warning(
            "unexpected-file",
            "sim.js",
            "visual.json has no \"stepper\", so this step function is \
             ignored",
        )),
        (None, false) => {}
    }

    if let Some(css) = &sources.extra_css {
        found.extend(scan::scan_css("extra.css", css));
    }

    let pipeline = check_pipeline(sources, &mut found);

    let (Some(data), Some(plant)) = (data, plant) else {
        return Err(BuildFailure { diagnostics: found });
    };
    if found.iter().any(|d| d.severity == Severity::Error) {
        return Err(BuildFailure { diagnostics: found });
    }

    let title = data["title"].as_str().unwrap_or("Codjiva").to_string();
    // The parts load first, so the yard's plant can draw them.
    let mut agent_js = String::new();
    if pipeline.is_some() {
        for (part, code) in &sources.parts {
            agent_js.push_str(&format!(
                "CJ.__part({}, function (CJ) {{\n'use strict';\n{}\n}});\n",
                serde_json::to_string(part).expect("a string serialises"),
                code
            ));
        }
    }
    agent_js.push_str(&wrap_agent_file("plant.js", plant));
    if let (Some(code), true) = (&sources.sim_js, stepper) {
        agent_js.push_str(&wrap_agent_file("sim.js", code));
    }
    for (id, code) in scene_order {
        agent_js.push_str(&wrap_agent_file(&format!("scenes/{id}.js"), code));
    }
    let key = if kind == ArtifactKind::Film {
        "film"
    } else {
        "visual"
    };
    let boot = match &pipeline {
        Some(pipeline) => format!(
            "CJ.boot({{\"{key}\":{},\"pipeline\":{}}});",
            json_for_script(&data),
            json_for_script(pipeline)
        ),
        None => format!("CJ.boot({{\"{key}\":{}}});", json_for_script(&data)),
    };
    let html = page(
        &title,
        kind,
        sources.extra_css.as_deref().unwrap_or(""),
        &agent_js,
        &boot,
    );

    if html.len() > SIZE_TARGET_BYTES {
        found.push(Diagnostic::warning(
            "size",
            "index.html",
            format!(
                "the built file is {} KB; the target is under {} KB. Draw \
                 with fewer elements",
                html.len() / 1024,
                SIZE_TARGET_BYTES / 1024
            ),
        ));
    }
    Ok(Built {
        kind,
        title,
        html,
        warnings: found,
    })
}

/// Checks the files only a pipeline has: `pipeline.json` and the copies of its
/// parts' plants in `parts/<key>/plant.js`. Returns the parsed `pipeline.json`
/// when the sources are a pipeline.
///
/// Every part that `pipeline.json` lists must have its plant, and the yard's
/// `plant.js` must draw it. A part folder that `pipeline.json` does not list is
/// an error, because it would be loaded and never shown.
fn check_pipeline(
    sources: &Sources,
    found: &mut Vec<Diagnostic>,
) -> Option<Value> {
    let Some(text) = &sources.pipeline_json else {
        for (key, _) in &sources.parts {
            found.push(Diagnostic::warning(
                "unexpected-file",
                &format!("parts/{key}/plant.js"),
                "there is no pipeline.json, so this part is ignored",
            ));
        }
        return None;
    };
    let file = "pipeline.json";
    let pipeline = validate_json(file, text, runtime::PIPELINE_SCHEMA, found)?;
    let keys: Vec<&str> = pipeline["parts"]
        .as_array()
        .map(|parts| parts.iter().filter_map(|p| p["key"].as_str()).collect())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    for key in &keys {
        if !seen.insert(*key) {
            found.push(Diagnostic::error(
                "pipeline",
                file,
                format!(
                    "the part key \"{key}\" is used twice; every part needs \
                     its own key"
                ),
            ));
        }
        match sources.parts.iter().find(|(name, _)| name == key) {
            None => found.push(Diagnostic::error(
                "missing-file",
                &format!("parts/{key}/plant.js"),
                format!(
                    "pipeline.json lists the part \"{key}\" but \
                     parts/{key}/plant.js does not exist. The app copies the \
                     parts; do not rename or remove them"
                ),
            )),
            Some((_, code)) => found
                .extend(scan::scan_js(&format!("parts/{key}/plant.js"), code)),
        }
        let drawn = sources.plant_js.as_deref().is_some_and(|plant| {
            plant.contains(&format!("CJ.bay('{key}')"))
                || plant.contains(&format!("CJ.bay(\"{key}\")"))
        });
        if !drawn {
            found.push(Diagnostic::error(
                "pipeline",
                "plant.js",
                format!(
                    "the part \"{key}\" is never drawn. Draw it in the yard \
                     with CJ.bay('{key}').draw(c)"
                ),
            ));
        }
    }
    for (name, _) in &sources.parts {
        if !keys.contains(&name.as_str()) {
            found.push(Diagnostic::error(
                "unexpected-file",
                &format!("parts/{name}/plant.js"),
                format!(
                    "pipeline.json does not list a part with the key \
                     \"{name}\""
                ),
            ));
        }
    }
    for (i, join) in pipeline["joins"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        for side in ["from", "to"] {
            let part = join[side]
                .as_str()
                .and_then(|s| s.split('#').next())
                .unwrap_or("");
            if !keys.contains(&part) {
                found.push(Diagnostic::error(
                    "pipeline",
                    file,
                    format!(
                        "join {i}: \"{side}\" names the part \"{part}\", \
                         which is not in \"parts\""
                    ),
                ));
            }
        }
    }
    Some(pipeline)
}

/// Checks a JSON file against one of the bundled schemas, such as
/// [`runtime::MODEL_SCHEMA`]. Returns the parsed value when the text is valid
/// JSON, and every problem found.
pub fn check_json(
    file: &str,
    text: &str,
    schema: &str,
) -> (Option<Value>, Vec<Diagnostic>) {
    let mut found = Vec::new();
    let value = validate_json(file, text, schema, &mut found);
    (value, found)
}

/// Parses `text` and checks it against `schema`. Every problem is added to
/// `found`. Returns the parsed value when the text is valid JSON, even if it
/// does not match the schema, so that later checks can still run.
fn validate_json(
    file: &str,
    text: &str,
    schema: &str,
    found: &mut Vec<Diagnostic>,
) -> Option<Value> {
    let value: Value = match serde_json::from_str(text) {
        Ok(value) => value,
        Err(e) => {
            found.push(Diagnostic {
                check: "json".into(),
                severity: Severity::Error,
                file: file.into(),
                line: Some(e.line()),
                message: format!("not valid JSON: {e}"),
            });
            return None;
        }
    };
    let schema: Value =
        serde_json::from_str(schema).expect("the bundled schema is valid JSON");
    let validator = jsonschema::validator_for(&schema)
        .expect("the bundled schema is a valid JSON Schema");
    for error in validator.iter_errors(&value) {
        let at = error.instance_path().to_string();
        let place = if at.is_empty() {
            "the top level".to_string()
        } else {
            at
        };
        found.push(Diagnostic::error(
            "schema",
            file,
            format!("at {place}: {error}"),
        ));
    }
    Some(value)
}

/// The most different packet forms the legend of one film or visual may list.
/// A viewer learns the legend from a card that is on screen for a few seconds,
/// and cannot keep more shapes than this apart.
pub const MAX_LEGEND_FORMS: usize = 3;

/// Checks the rules of a legend that the JSON Schema cannot express. `file` is
/// `film.json` or `visual.json`, whichever holds the legend.
///
/// A row is `{ "kind", "form", "html" }`. A row without `form` is a crate.
///   - A row of the kind `batch` or `tally` must not name a form, because
///     those two kinds have a shape of their own.
///   - The rows of the other kinds may name at most [`MAX_LEGEND_FORMS`]
///     different forms between them.
fn lint_legend(data: &Value, file: &str, found: &mut Vec<Diagnostic>) {
    let mut forms: Vec<&str> = Vec::new();
    for (i, row) in data["legend"].as_array().into_iter().flatten().enumerate()
    {
        let kind = row["kind"].as_str().unwrap_or("");
        let form = row["form"].as_str();
        if kind == "batch" || kind == "tally" {
            if form.is_some_and(|form| form != "crate") {
                found.push(Diagnostic::error(
                    "legend",
                    file,
                    format!(
                        "legend row {i}: the kind \"{kind}\" has its own \
                         shape and takes no form. Remove \"form\" from this \
                         row"
                    ),
                ));
            }
            continue;
        }
        let form = form.unwrap_or("crate");
        if !forms.contains(&form) {
            forms.push(form);
        }
    }
    if forms.len() > MAX_LEGEND_FORMS {
        found.push(Diagnostic::error(
            "legend",
            file,
            format!(
                "the legend lists {} different packet forms ({}); a viewer \
                 cannot keep more than {MAX_LEGEND_FORMS} apart. Draw only \
                 the things the story follows as packets of their own form, \
                 and show the others with labels or bubbles",
                forms.len(),
                forms.join(", ")
            ),
        ));
    }
}

/// Checks the rules of a film that the JSON Schema cannot express.
fn lint_film(film: &Value, found: &mut Vec<Diagnostic>) {
    let file = "film.json";
    let Some(scenes) = film["scenes"].as_array() else {
        return;
    };
    let mut ids = HashSet::new();
    for (index, scene) in scenes.iter().enumerate() {
        let id = scene["id"].as_str().unwrap_or("?");
        if !ids.insert(id) {
            found.push(Diagnostic::error(
                "film",
                file,
                format!(
                    "scene id \"{id}\" is used twice; every scene needs its \
                     own id"
                ),
            ));
        }
        let length = scene["animLength"].as_f64().unwrap_or(0.0);

        let mut previous = f64::NEG_INFINITY;
        for (i, bubble) in scene["bubbles"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
        {
            let at = bubble["at"].as_f64().unwrap_or(0.0);
            if at < previous {
                found.push(Diagnostic::error(
                    "film",
                    file,
                    format!(
                        "scene \"{id}\": bubble {i} has at={at}, earlier than \
                         the bubble before it. List bubbles in the order they \
                         appear"
                    ),
                ));
            }
            if at > length {
                found.push(Diagnostic::error(
                    "film",
                    file,
                    format!(
                        "scene \"{id}\": bubble {i} has at={at}, after the \
                         scene's animLength of {length}"
                    ),
                ));
            }
            previous = at;
        }

        let mut camera_time = f64::NEG_INFINITY;
        for (i, key) in
            scene["camera"].as_array().into_iter().flatten().enumerate()
        {
            match key["t"].as_f64() {
                None if i == 0 && index == 0 => {}
                None => found.push(Diagnostic::error(
                    "film",
                    file,
                    format!(
                        "scene \"{id}\": camera key {i} needs \"t\" and \
                         \"dur\". Only the first key of the first scene may \
                         be a starting framing without them; every later \
                         scene starts on the framing the scene before it \
                         ended on"
                    ),
                )),
                Some(t) => {
                    if t < camera_time {
                        found.push(Diagnostic::error(
                            "film",
                            file,
                            format!(
                                "scene \"{id}\": camera key {i} starts at \
                                 t={t}, before the previous move has ended. \
                                 Leave a hold between moves"
                            ),
                        ));
                    }
                    camera_time = t + key["dur"].as_f64().unwrap_or(1.0);
                }
            }
        }

        for (i, cue) in
            scene["cues"].as_array().into_iter().flatten().enumerate()
        {
            let at = cue["at"].as_f64().unwrap_or(0.0);
            if at < 0.0 || at > length {
                found.push(Diagnostic::error(
                    "film",
                    file,
                    format!(
                        "scene \"{id}\": cue {i} has at={at}, outside the \
                         scene's animLength of {length}"
                    ),
                ));
            }
        }
    }
}

/// Checks the rules of a still visual that the JSON Schema cannot express.
fn lint_visual(visual: &Value, found: &mut Vec<Diagnostic>) {
    let file = "visual.json";
    let mut ids = HashSet::new();
    for node in visual["nodes"].as_array().into_iter().flatten() {
        let id = node["id"].as_str().unwrap_or("?");
        if !ids.insert(id) {
            found.push(Diagnostic::error(
                "visual",
                file,
                format!(
                    "node id \"{id}\" is used twice; every node needs its own \
                     id"
                ),
            ));
        }
        if node["select"].as_array().is_none_or(|s| s.is_empty()) {
            found.push(Diagnostic::error(
                "visual",
                file,
                format!(
                    "node \"{id}\" has an empty \"select\"; list the name of \
                     the element that highlights when it is hovered"
                ),
            ));
        }
    }
}

/// Builds a view: an artifact that the runtime draws from the data in
/// `view.json`, without a plant. `text` is the content of that file.
///
/// The value of `"view"` in the file names the view, and the file is checked
/// against that view's schema. A structure view is stepped through, so it
/// also needs the step function in `sim.js`. No other view has one.
fn build_view(sources: &Sources, text: &str) -> Result<Built, BuildFailure> {
    let file = "view.json";
    let mut found: Vec<Diagnostic> = Vec::new();
    for name in &sources.unexpected {
        found.push(if name == "index.html" {
            Diagnostic::error(
                "unexpected-file",
                name,
                "do not write index.html; the app builds it from your \
                 sources. Delete this file",
            )
        } else {
            Diagnostic::warning(
                "unexpected-file",
                name,
                "this file is not part of an artifact and is ignored",
            )
        });
    }
    if sources.plant_js.is_some() {
        found.push(Diagnostic::warning(
            "unexpected-file",
            "plant.js",
            "a view is drawn by the runtime from view.json, so this plant \
             is ignored",
        ));
    }
    let Ok(data) = serde_json::from_str::<Value>(text) else {
        // The text is not JSON. Checking it against any schema reports
        // where.
        validate_json(file, text, runtime::VIEW_SCHEMAS[0].1, &mut found);
        return Err(BuildFailure { diagnostics: found });
    };
    let name = data["view"].as_str().unwrap_or("");
    let Some((_, schema)) =
        runtime::VIEW_SCHEMAS.iter().find(|(view, _)| *view == name)
    else {
        let known: Vec<&str> = runtime::VIEW_SCHEMAS
            .iter()
            .map(|(view, _)| *view)
            .collect();
        found.push(Diagnostic::error(
            "view",
            file,
            format!(
                "\"view\" is \"{name}\", which is not a view. Set it to \
                 one of: {}",
                known.join(", ")
            ),
        ));
        return Err(BuildFailure { diagnostics: found });
    };
    validate_json(file, text, schema, &mut found);
    lint_view(&data, name, &mut found);

    let stepped = name == "structure";
    match (&sources.sim_js, stepped) {
        (Some(code), true) => {
            found.extend(scan::scan_js("sim.js", code));
            found.extend(scan::scan_sim("sim.js", code));
            for needed in ["CJ.defineSim(", "structure("] {
                if !code.contains(needed) {
                    found.push(Diagnostic::error(
                        "sim",
                        "sim.js",
                        "the sim.js of a structure view must call \
                         CJ.defineSim({ init, step, vars, outputs, structure \
                         }), where structure(m) returns what is in memory",
                    ));
                    break;
                }
            }
        }
        (None, true) => found.push(Diagnostic::error(
            "missing-file",
            "sim.js",
            "a structure view is stepped through, so sim.js is needed; it \
             must call CJ.defineSim({ init, step, vars, outputs, structure })",
        )),
        (Some(_), false) => found.push(Diagnostic::warning(
            "unexpected-file",
            "sim.js",
            "only a structure view has a step function, so this one is \
             ignored",
        )),
        (None, false) => {}
    }
    if let Some(css) = &sources.extra_css {
        found.extend(scan::scan_css("extra.css", css));
    }
    if found.iter().any(|d| d.severity == Severity::Error) {
        return Err(BuildFailure { diagnostics: found });
    }

    let title = data["title"].as_str().unwrap_or("Codjiva").to_string();
    let agent_js = match (&sources.sim_js, stepped) {
        (Some(code), true) => wrap_agent_file("sim.js", code),
        _ => String::new(),
    };
    let boot = format!("CJ.boot({{\"view\":{}}});", json_for_script(&data));
    let html = page(
        &title,
        ArtifactKind::Visual,
        sources.extra_css.as_deref().unwrap_or(""),
        &agent_js,
        &boot,
    );
    Ok(Built {
        kind: ArtifactKind::Visual,
        title,
        html,
        warnings: found,
    })
}

/// The most nodes a map may have inside one parent. A level with more boxes
/// than this cannot be read at a glance, so the agent is asked to group them.
pub const MAX_MAP_CHILDREN: usize = 12;

/// Checks the rules of a view that the JSON Schema cannot express. `name` is
/// the view: `schema`, `lanes`, `structure` or `map`.
///
/// For every view, each node has its own id. Beyond that:
///   - schema: a relation joins two nodes, and the field it names is a field
///     of its `from` node. A use names a field of a node.
///   - lanes: every message goes from a node to a node, and each scenario
///     has its own id.
///   - map: a `parent` is the id of another node, no node is inside itself,
///     a link joins two nodes, and no parent holds more than
///     [`MAX_MAP_CHILDREN`] nodes.
fn lint_view(data: &Value, name: &str, found: &mut Vec<Diagnostic>) {
    let file = "view.json";
    let list = |key: &str| data[key].as_array().into_iter().flatten();
    let mut ids = HashSet::new();
    for node in list("nodes") {
        let id = node["id"].as_str().unwrap_or("?");
        if !ids.insert(id) {
            found.push(Diagnostic::error(
                "view",
                file,
                format!(
                    "node id \"{id}\" is used twice; every node needs its \
                     own id"
                ),
            ));
        }
    }
    let mut unknown = |what: String, id: &str| {
        if !ids.contains(id) {
            found.push(Diagnostic::error(
                "view",
                file,
                format!("{what} names \"{id}\", which is not the id of a node"),
            ));
        }
    };
    let fields_of = |id: &str| -> Vec<&str> {
        list("nodes")
            .find(|node| node["id"].as_str() == Some(id))
            .and_then(|node| node["fields"].as_array())
            .into_iter()
            .flatten()
            .filter_map(|field| field["name"].as_str())
            .collect()
    };
    match name {
        "schema" => {
            let mut missing: Vec<String> = Vec::new();
            for (i, relation) in list("relations").enumerate() {
                for end in ["from", "to"] {
                    unknown(
                        format!("relation {i}: \"{end}\""),
                        relation[end].as_str().unwrap_or(""),
                    );
                }
                let from = relation["from"].as_str().unwrap_or("");
                if let Some(field) = relation["field"].as_str() {
                    if !fields_of(from).contains(&field) {
                        missing.push(format!(
                            "relation {i} goes through the field \
                             \"{field}\", which \"{from}\" does not have"
                        ));
                    }
                }
            }
            for (i, used) in list("uses").enumerate() {
                let node = used["node"].as_str().unwrap_or("");
                unknown(format!("use {i}: \"node\""), node);
                let field = used["field"].as_str().unwrap_or("");
                if ids.contains(node) && !fields_of(node).contains(&field) {
                    missing.push(format!(
                        "use {i} names the field \"{field}\", which \
                         \"{node}\" does not have"
                    ));
                }
            }
            for message in missing {
                found.push(Diagnostic::error("view", file, message));
            }
        }
        "lanes" => {
            let mut scenarios = HashSet::new();
            let mut twice: Vec<String> = Vec::new();
            for scenario in list("scenarios") {
                let id = scenario["id"].as_str().unwrap_or("?");
                if !scenarios.insert(id) {
                    twice.push(id.to_string());
                }
                for (i, step) in scenario["steps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .enumerate()
                {
                    for end in ["from", "to"] {
                        unknown(
                            format!("scenario \"{id}\", step {i}: \"{end}\""),
                            step[end].as_str().unwrap_or(""),
                        );
                    }
                }
            }
            for id in twice {
                found.push(Diagnostic::error(
                    "view",
                    file,
                    format!(
                        "scenario id \"{id}\" is used twice; every scenario \
                         needs its own id"
                    ),
                ));
            }
        }
        "map" => {
            let parent_of = |id: &str| -> Option<&str> {
                list("nodes")
                    .find(|node| node["id"].as_str() == Some(id))
                    .and_then(|node| node["parent"].as_str())
            };
            let mut problems: Vec<String> = Vec::new();
            let mut inside: std::collections::BTreeMap<&str, usize> =
                std::collections::BTreeMap::new();
            for node in list("nodes") {
                let id = node["id"].as_str().unwrap_or("?");
                let Some(parent) = node["parent"].as_str() else {
                    *inside.entry("").or_default() += 1;
                    continue;
                };
                unknown(format!("node \"{id}\": \"parent\""), parent);
                *inside.entry(parent).or_default() += 1;
                // Walks up from the node. A walk that comes back to the node
                // means the node is inside itself.
                let mut at = Some(parent);
                for _ in 0..32 {
                    match at {
                        Some(up) if up == id => {
                            problems.push(format!(
                                "node \"{id}\" is inside itself; follow \
                                 \"parent\" upwards and remove the loop"
                            ));
                            break;
                        }
                        Some(up) => at = parent_of(up),
                        None => break,
                    }
                }
            }
            for (i, link) in list("links").enumerate() {
                for end in ["from", "to"] {
                    unknown(
                        format!("link {i}: \"{end}\""),
                        link[end].as_str().unwrap_or(""),
                    );
                }
            }
            for (parent, count) in inside {
                if count > MAX_MAP_CHILDREN {
                    let place = if parent.is_empty() {
                        "the top level".to_string()
                    } else {
                        format!("\"{parent}\"")
                    };
                    problems.push(format!(
                        "{place} holds {count} nodes; a level is readable \
                         with at most {MAX_MAP_CHILDREN}. Group related \
                         nodes under a node of their own"
                    ));
                }
            }
            for message in problems {
                found.push(Diagnostic::error("view", file, message));
            }
        }
        _ => {}
    }
}

/// Checks the rules of a step-through's `stepper` that the JSON Schema cannot
/// express.
///   - Every transition has its own id.
///   - The `from` and the `to` of a transition are ids of nodes.
///   - An example's input is not longer than the input may be.
fn lint_stepper(visual: &Value, found: &mut Vec<Diagnostic>) {
    let file = "visual.json";
    let stepper = &visual["stepper"];
    let nodes: HashSet<&str> = visual["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|node| node["id"].as_str())
        .collect();
    let mut ids = HashSet::new();
    for edge in stepper["edges"].as_array().into_iter().flatten() {
        let id = edge["id"].as_str().unwrap_or("?");
        if !ids.insert(id) {
            found.push(Diagnostic::error(
                "stepper",
                file,
                format!(
                    "the transition id \"{id}\" is used twice; every \
                     transition needs its own id"
                ),
            ));
        }
        for end in ["from", "to"] {
            let node = edge[end].as_str().unwrap_or("");
            if !nodes.contains(node) {
                found.push(Diagnostic::error(
                    "stepper",
                    file,
                    format!(
                        "transition \"{id}\": \"{end}\" names \"{node}\", \
                         which is not the id of a node"
                    ),
                ));
            }
        }
    }
    let longest = stepper["input"]["maxLength"].as_u64().unwrap_or(200);
    for preset in stepper["presets"].as_array().into_iter().flatten() {
        let length =
            preset["input"].as_str().unwrap_or("").chars().count() as u64;
        if length > longest {
            found.push(Diagnostic::error(
                "stepper",
                file,
                format!(
                    "the example \"{}\" is {length} characters long, but \
                     the input may be at most {longest}. Raise \
                     input.maxLength (at most 500) or shorten the example",
                    preset["label"].as_str().unwrap_or("?")
                ),
            ));
        }
    }
}

/// Wraps one agent file so that it runs with `CJ` as its only handle on the
/// runtime, and so that an error thrown while it loads is recorded under the
/// file's name.
fn wrap_agent_file(name: &str, code: &str) -> String {
    format!(
        "CJ.__file({}, function (CJ) {{\n'use strict';\n{}\n}});\n",
        serde_json::to_string(name).expect("a string serialises"),
        code
    )
}

/// Makes JavaScript safe to place inside a `<script>` element. The HTML parser
/// ends a script at the text `</script` and treats `<!--` specially, wherever
/// they occur, even inside a string.
fn escape_for_script(code: &str) -> String {
    let mut out = String::with_capacity(code.len());
    let lower = code.to_ascii_lowercase();
    let mut at = 0;
    while let Some(hit) = lower[at..].find("</script") {
        out.push_str(&code[at..at + hit]);
        out.push_str("<\\/");
        at += hit + 2;
    }
    out.push_str(&code[at..]);
    out.replace("<!--", "<\\!--")
}

/// Serialises JSON so it can be embedded in a `<script>` element: `<` is
/// written as an escape, and so are the two line separator characters that are
/// legal in JSON but not in older scripts.
fn json_for_script(value: &Value) -> String {
    serde_json::to_string(value)
        .expect("a JSON value serialises")
        .replace('<', "\\u003c")
        .replace('\u{2028}', "\\u2028")
        .replace('\u{2029}', "\\u2029")
}

fn escape_html(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// The policy every artifact carries. It allows inline script and style, and
/// data URLs for images, fonts and media. Everything else is blocked, including
/// every network request.
pub const CONTENT_SECURITY_POLICY: &str =
    "default-src 'none'; script-src 'unsafe-inline'; style-src \
     'unsafe-inline'; img-src data:; font-src data:; media-src data:";

fn page(
    title: &str,
    kind: ArtifactKind,
    extra_css: &str,
    agent_js: &str,
    boot: &str,
) -> String {
    let what = if kind == ArtifactKind::Film {
        "A film"
    } else {
        "A still, interactive visual"
    };
    let keys = if kind == ArtifactKind::Film {
        "\n  Keys: Space play/pause, Left/Right seek 5 s, PageUp/PageDown \
         chapter, M sound, F full screen."
    } else {
        ""
    };
    format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="{csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Codjiva runtime {version}">
<title>{title}</title>
<!--
  {what} made with Codjiva. One self-contained file: plain HTML, CSS and JavaScript,
  no external files, libraries or network requests.
  Font: JetBrains Mono (SIL Open Font License 1.1), embedded below.{keys}
-->
<style>
{base_css}
{extra_css}
</style>
</head>
<body>
<script>
{runtime}</script>
<script>
{agent}</script>
<script>
{boot}
</script>
</body>
</html>
"#,
        csp = CONTENT_SECURITY_POLICY,
        version = RUNTIME_VERSION,
        title = escape_html(title),
        base_css = runtime::base_css(),
        extra_css = extra_css.replace("</style", "<\\/style"),
        runtime = escape_for_script(&runtime::runtime_js()),
        agent = escape_for_script(agent_js),
        boot = boot,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn visual_sources() -> Sources {
        Sources {
            visual_json: Some(r#"{"schemaVersion":1,"title":"T","camera":{"cx":960,"cy":560,"z":1},"nodes":[{"id":"a","label":"A","role":"r","select":["a"]}]}"#.into()),
            plant_js: Some("CJ.definePlant({ draw({ c }) { return '<svg class=\"art\"></svg>'; } });".into()),
            ..Sources::default()
        }
    }

    #[test]
    fn builds_a_minimal_visual() {
        let built = build(&visual_sources()).expect("builds");
        assert_eq!(built.kind, ArtifactKind::Visual);
        assert!(built.html.starts_with("<!DOCTYPE html>"));
        assert!(built.html.contains("CJ.boot({\"visual\":"));
        assert!(built.html.contains(CONTENT_SECURITY_POLICY));
    }

    #[test]
    fn rejects_a_plant_that_calls_fetch_and_names_the_line() {
        let mut sources = visual_sources();
        sources.plant_js = Some("CJ.definePlant({});\nfetch('/x');\n".into());
        let failure = build(&sources).unwrap_err();
        let d = failure
            .diagnostics
            .iter()
            .find(|d| d.check == "forbidden-token")
            .expect("reported");
        assert_eq!((d.file.as_str(), d.line), ("plant.js", Some(2)));
    }

    #[test]
    fn rejects_an_index_html_written_by_the_agent() {
        let mut sources = visual_sources();
        sources.unexpected.push("index.html".into());
        assert!(build(&sources)
            .unwrap_err()
            .diagnostics
            .iter()
            .any(|d| d.check == "unexpected-file"
                && d.severity == Severity::Error));
    }

    #[test]
    fn reports_schema_errors_with_their_place() {
        let mut sources = visual_sources();
        sources.visual_json = Some(r#"{"schemaVersion":1,"title":"T","camera":{"cx":960,"cy":560,"z":9},"nodes":[]}"#.into());
        let failure = build(&sources).unwrap_err();
        assert!(
            failure.diagnostics.iter().any(|d| d.check == "schema"
                && d.message.contains("/camera/z")),
            "{:?}",
            failure.diagnostics
        );
    }

    /// A pipeline of two parts, `a` and `b`, with one join and a yard that
    /// draws both.
    fn pipeline_sources() -> Sources {
        let part = "CJ.definePlant({ draw({ c }) { return '<svg \
                    class=\"art\"></svg>'; } });"
            .to_string();
        Sources {
            pipeline_json: Some(r#"{"schemaVersion":1,"title":"T","parts":[{"key":"a","artifact":"visual-a-000000","version":1,"bay":[40,200],"scale":0.45},
                {"key":"b","artifact":"visual-b-000000","version":2,"bay":[1000,200],"scale":0.45}],"joins":[{"from":"a#out:x.send","to":"b#in:x.receive","kind":"call"}]}"#.into()),
            plant_js: Some("CJ.definePlant({ draw({ c }) { return '<svg class=\"art\"></svg>' + CJ.bay('a').draw(c) + CJ.bay(\"b\").draw(c); } });".into()),
            parts: vec![("a".into(), part.clone()), ("b".into(), part)],
            ..visual_sources()
        }
    }

    #[test]
    fn a_pipeline_loads_its_parts_before_the_yard_and_carries_its_placement() {
        let built = build(&pipeline_sources()).expect("builds");
        let part_a = built
            .html
            .find("CJ.__part(\"a\", function (CJ)")
            .expect("part a is loaded");
        let yard = built
            .html
            .find("CJ.__file(\"plant.js\"")
            .expect("the yard is loaded");
        assert!(part_a < yard);
        assert!(built.html.contains("CJ.__part(\"b\""));
        assert!(
            built.html.contains("\"pipeline\":{")
                && built.html.contains("\"bay\":[40,200]")
        );
    }

    /// The pipeline a real agent composed from two real visuals of the Go
    /// fixture. It must keep building, parts included, when the builder or the
    /// schemas change.
    #[test]
    fn a_pipeline_recorded_from_a_real_agent_still_builds() {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../fixtures/replay/go-orders-pipeline/turn-1/files/src");
        let sources = Sources::read_dir(&dir)
            .expect("the recording is in the repository");
        assert_eq!(
            sources
                .parts
                .iter()
                .map(|(key, _)| key.as_str())
                .collect::<Vec<_>>(),
            vec!["handler", "store"]
        );
        let built = build(&sources)
            .unwrap_or_else(|failure| panic!("{:?}", failure.diagnostics));
        assert!(
            built.html.contains("CJ.__part(\"handler\"")
                && built.html.contains("CJ.__part(\"store\"")
                && built.html.contains("\"pipeline\":{")
        );
        assert_eq!(built.kind, ArtifactKind::Visual);
    }

    #[test]
    fn pipeline_mistakes_are_reported_with_what_to_do() {
        let mut sources = pipeline_sources();
        sources.parts.remove(1);
        sources
            .parts
            .push(("c".into(), "CJ.definePlant({});\nfetch('/x');".into()));
        sources.plant_js = Some(
            "CJ.definePlant({ draw({ c }) { return CJ.bay('a').draw(c); } });"
                .into(),
        );
        sources.pipeline_json = Some(
            sources
                .pipeline_json
                .unwrap()
                .replace("b#in:x.receive", "z#in:x.receive"),
        );
        let found = build(&sources).unwrap_err().diagnostics;
        let has = |file: &str, part: &str| {
            found
                .iter()
                .any(|d| d.file == file && d.message.contains(part))
        };
        assert!(has("parts/b/plant.js", "does not exist"), "{found:?}");
        assert!(has("plant.js", "\"b\" is never drawn"), "{found:?}");
        assert!(has("parts/c/plant.js", "does not list a part"), "{found:?}");
        assert!(has("pipeline.json", "names the part \"z\""), "{found:?}");

        // Parts without a pipeline.json are ignored, and the visual still
        // builds.
        let mut stray = visual_sources();
        stray.parts.push(("a".into(), "CJ.definePlant({});".into()));
        let built = build(&stray).expect("builds");
        assert!(
            !built.html.contains("CJ.__part(")
                && built.warnings.iter().any(|d| d.file == "parts/a/plant.js")
        );
    }

    #[test]
    fn script_end_tags_inside_agent_code_cannot_end_the_script_element() {
        let mut sources = visual_sources();
        sources.plant_js =
            Some("CJ.definePlant({ note: 'a </SCRIPT> b <!-- c' });".into());
        let built = build(&sources).expect("builds");
        assert!(built.html.contains("a <\\/SCRIPT> b <\\!-- c"));
    }

    /// A visual whose legend holds the given rows.
    fn visual_with_legend(rows: &str) -> Sources {
        let mut sources = visual_sources();
        sources.visual_json = Some(format!(
            r#"{{"schemaVersion":1,"title":"T","camera":{{"cx":960,"cy":560,"z":1}},"nodes":[],"legend":[{rows}]}}"#
        ));
        sources
    }

    #[test]
    fn a_legend_row_may_name_the_form_of_its_packet() {
        let built = build(&visual_with_legend(
            r#"{"kind":"primary","form":"element","html":"a button"},
               {"kind":"secondary","form":"value","html":"a number"},
               {"kind":"transient","html":"a probe"},
               {"kind":"batch","html":"a batch"}"#,
        ))
        .unwrap_or_else(|failure| panic!("{:?}", failure.diagnostics));
        assert!(built.html.contains(r#""form":"element""#));

        let unknown = build(&visual_with_legend(
            r#"{"kind":"primary","form":"pill","html":"a button"}"#,
        ))
        .unwrap_err();
        assert!(
            unknown
                .diagnostics
                .iter()
                .any(|d| d.check == "schema" && d.message.contains("/legend/0")),
            "{:?}",
            unknown.diagnostics
        );
    }

    #[test]
    fn a_legend_is_limited_in_rows_and_in_forms() {
        let row = |form: &str| {
            format!(r#"{{"kind":"primary","form":"{form}","html":"x"}}"#)
        };
        // Four forms: one more than a legend may list. Rows of the kinds batch
        // and tally are not counted, because they name no form.
        let four = ["crate", "record", "value", "key"].map(row).join(",");
        let failure = build(&visual_with_legend(&format!(
            r#"{four},{{"kind":"batch","html":"x"}}"#
        )))
        .unwrap_err();
        assert!(
            failure.diagnostics.iter().any(|d| d.check == "legend"
                && d.message.contains("4 different packet forms")
                && d.message.contains("crate, record, value, key")),
            "{:?}",
            failure.diagnostics
        );

        let three = ["crate", "record", "value"].map(row).join(",");
        build(&visual_with_legend(&format!(
            r#"{three},{{"kind":"batch","html":"x"}},{{"kind":"tally","html":"x"}}"#
        )))
        .unwrap_or_else(|failure| panic!("{:?}", failure.diagnostics));

        // Seven rows: one more than the schema allows.
        let seven = vec![row("record"); 7].join(",");
        let failure = build(&visual_with_legend(&seven)).unwrap_err();
        assert!(
            failure
                .diagnostics
                .iter()
                .any(|d| d.check == "schema" && d.message.contains("/legend")),
            "{:?}",
            failure.diagnostics
        );
    }

    #[test]
    fn a_legend_row_of_the_kind_batch_or_tally_takes_no_form() {
        let failure = build(&visual_with_legend(
            r#"{"kind":"batch","form":"record","html":"x"}"#,
        ))
        .unwrap_err();
        assert!(
            failure.diagnostics.iter().any(|d| d.check == "legend"
                && d.message.contains("legend row 0")
                && d.message.contains("\"batch\" has its own shape")),
            "{:?}",
            failure.diagnostics
        );
    }

    #[test]
    fn film_lint_reports_bubbles_out_of_order_and_missing_scene_files() {
        let sources = Sources {
            film_json: Some(r#"{"schemaVersion":1,"title":"T","legend":[],"scenes":[{"id":"one","title":"1 · One","animLength":10,"bubbles":[
                {"at":5,"x":0,"y":0,"kicker":"A","html":"a"},{"at":2,"x":0,"y":0,"kicker":"B","html":"b"}]}]}"#.into()),
            plant_js: Some("CJ.definePlant({});".into()),
            ..Sources::default()
        };
        let failure = build(&sources).unwrap_err();
        assert!(failure
            .diagnostics
            .iter()
            .any(|d| d.message.contains("earlier than the bubble before it")));
        assert!(failure
            .diagnostics
            .iter()
            .any(|d| d.file == "scenes/one.js" && d.check == "missing-file"));
    }
}
