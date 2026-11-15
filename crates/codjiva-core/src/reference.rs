//! The reference examples that ship inside the app: a film, a still visual and
//! a pipeline.
//!
//! All three explain the made-up Go program in `fixtures/go-orders`. The app
//! shows the film and the visual from the welcome screen, and agents are
//! pointed at the sources as worked examples. The sources are compiled into the
//! binary, and the pages are built from them the first time they are asked for.

use codjiva_build::{build, Sources};
use std::sync::OnceLock;

macro_rules! reference_file {
    ($path:literal) => {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime/reference/",
            $path
        ))
    };
}

const FILM_PLANT: &str = reference_file!("film/plant.js");
const FILM_JSON: &str = reference_file!("film/film.json");
const VISUAL_PLANT: &str = reference_file!("visual/plant.js");
const VISUAL_JSON: &str = reference_file!("visual/visual.json");

/// `(scene id, source)` for the film's chapters.
const SCENES: &[(&str, &str)] = &[
    ("overview", reference_file!("film/scenes/overview.js")),
    ("routing", reference_file!("film/scenes/routing.js")),
    ("budget", reference_file!("film/scenes/budget.js")),
    ("flush", reference_file!("film/scenes/flush.js")),
];

/// `(part key, plant source)` for the two parts of the reference pipeline.
const PIPELINE_PARTS: &[(&str, &str)] = &[
    (
        "handler",
        reference_file!("pipeline/parts/handler/plant.js"),
    ),
    ("store", reference_file!("pipeline/parts/store/plant.js")),
];

/// The reference film's source files, in the form the builder takes.
pub fn film_sources() -> Sources {
    Sources {
        film_json: Some(FILM_JSON.to_string()),
        plant_js: Some(FILM_PLANT.to_string()),
        scenes: SCENES
            .iter()
            .map(|(id, code)| (id.to_string(), code.to_string()))
            .collect(),
        ..Sources::default()
    }
}

/// The source files of the reference visual, a still picture of the file the
/// film is about.
pub fn visual_sources() -> Sources {
    Sources {
        visual_json: Some(VISUAL_JSON.to_string()),
        plant_js: Some(VISUAL_PLANT.to_string()),
        ..Sources::default()
    }
}

/// Writes the reference sources into `dir`, as `film/`, `visual/` and
/// `pipeline/`, for an agent to read as worked examples.
pub fn write_sources(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("film/scenes"))?;
    std::fs::create_dir_all(dir.join("visual"))?;
    std::fs::write(dir.join("film/plant.js"), FILM_PLANT)?;
    std::fs::write(dir.join("film/film.json"), FILM_JSON)?;
    for (id, code) in SCENES {
        std::fs::write(dir.join(format!("film/scenes/{id}.js")), code)?;
    }
    std::fs::write(dir.join("visual/plant.js"), VISUAL_PLANT)?;
    std::fs::write(dir.join("visual/visual.json"), VISUAL_JSON)?;
    // The pipeline joins two parts in one yard. Each part is the plant of a
    // visual.
    for (key, plant) in PIPELINE_PARTS {
        std::fs::create_dir_all(dir.join("pipeline/parts").join(key))?;
        std::fs::write(
            dir.join("pipeline/parts").join(key).join("plant.js"),
            plant,
        )?;
    }
    std::fs::write(
        dir.join("pipeline/pipeline.json"),
        reference_file!("pipeline/pipeline.json"),
    )?;
    std::fs::write(
        dir.join("pipeline/plant.js"),
        reference_file!("pipeline/plant.js"),
    )?;
    std::fs::write(
        dir.join("pipeline/visual.json"),
        reference_file!("pipeline/visual.json"),
    )
}

/// The built reference film as one HTML page.
pub fn film_html() -> &'static str {
    static HTML: OnceLock<String> = OnceLock::new();
    HTML.get_or_init(|| {
        build(&film_sources())
            .expect("the bundled reference film builds")
            .html
    })
}

/// The built reference visual as one HTML page.
pub fn visual_html() -> &'static str {
    static HTML: OnceLock<String> = OnceLock::new();
    HTML.get_or_init(|| {
        build(&visual_sources())
            .expect("the bundled reference visual builds")
            .html
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bundled_reference_pages_build() {
        assert!(film_html().contains("CJ.boot({\"film\":"));
        assert!(visual_html().contains("CJ.boot({\"visual\":"));
    }
}
