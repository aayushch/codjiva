//! The reference examples that agents are given as worked examples: a film, a
//! still visual, a pipeline, a step-through and four views.
//!
//! All of them explain the made-up Go program in `fixtures/go-orders`. Their
//! source files are compiled into the binary as text, and `write_sources`
//! writes them into the folder of a job. The app does not show them.

use codjiva_build::Sources;

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

/// The sources of the four reference views, by the name of the view. A view
/// is one `view.json`. The structure view also has its step function.
const VIEW_SOURCES: &[(&str, &[(&str, &str)])] = &[
    (
        "schema",
        &[("view.json", reference_file!("views/schema/view.json"))],
    ),
    (
        "lanes",
        &[("view.json", reference_file!("views/lanes/view.json"))],
    ),
    (
        "structure",
        &[
            ("view.json", reference_file!("views/structure/view.json")),
            ("sim.js", reference_file!("views/structure/sim.js")),
        ],
    ),
    (
        "map",
        &[("view.json", reference_file!("views/map/view.json"))],
    ),
];

/// The source files of the reference view with the given name, or `None`
/// when there is no such view.
pub fn view_sources(view: &str) -> Option<Sources> {
    let (_, files) = VIEW_SOURCES.iter().find(|(name, _)| *name == view)?;
    let text = |wanted: &str| {
        files
            .iter()
            .find(|(name, _)| *name == wanted)
            .map(|(_, text)| text.to_string())
    };
    Some(Sources {
        view_json: text("view.json"),
        sim_js: text("sim.js"),
        ..Sources::default()
    })
}

/// The source files of the reference step-through, which runs the rate
/// limiter of the same program on a sequence of orders.
pub fn stepthrough_sources() -> Sources {
    Sources {
        visual_json: Some(
            reference_file!("stepthrough/visual.json").to_string(),
        ),
        plant_js: Some(reference_file!("stepthrough/plant.js").to_string()),
        sim_js: Some(reference_file!("stepthrough/sim.js").to_string()),
        ..Sources::default()
    }
}

/// Writes the reference sources into `dir`, as `film/`, `visual/`,
/// `stepthrough/` and `pipeline/`, for an agent to read as worked examples.
pub fn write_sources(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir.join("film/scenes"))?;
    std::fs::create_dir_all(dir.join("visual"))?;
    std::fs::create_dir_all(dir.join("stepthrough"))?;
    for (view, files) in VIEW_SOURCES {
        let folder = dir.join("views").join(view);
        std::fs::create_dir_all(&folder)?;
        for (name, text) in *files {
            std::fs::write(folder.join(name), text)?;
        }
    }
    let stepthrough = stepthrough_sources();
    for (name, text) in [
        ("visual.json", stepthrough.visual_json),
        ("plant.js", stepthrough.plant_js),
        ("sim.js", stepthrough.sim_js),
    ] {
        std::fs::write(
            dir.join("stepthrough").join(name),
            text.unwrap_or_default(),
        )?;
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use codjiva_build::build;

    #[test]
    fn the_bundled_reference_pages_build() {
        let film = build(&film_sources()).expect("the reference film builds");
        assert!(film.html.contains("CJ.boot({\"film\":"));
        let visual =
            build(&visual_sources()).expect("the reference visual builds");
        assert!(visual.html.contains("CJ.boot({\"visual\":"));
    }

    #[test]
    fn the_four_bundled_reference_views_build_without_a_plant() {
        for (view, _) in VIEW_SOURCES {
            let built =
                build(&view_sources(view).unwrap()).unwrap_or_else(|failure| {
                    panic!("{view}: {:?}", failure.diagnostics)
                });
            assert!(
                built.html.contains(&format!("\"view\":\"{view}\"")),
                "{view}"
            );
            assert!(built.warnings.is_empty(), "{view}: {:?}", built.warnings);
            assert!(!built.html.contains("CJ.__file(\"plant.js\""));
        }
        assert!(view_sources("graph").is_none());
    }

    #[test]
    fn the_bundled_reference_step_through_builds_with_its_step_function() {
        let built = build(&stepthrough_sources())
            .unwrap_or_else(|failure| panic!("{:?}", failure.diagnostics));
        assert!(built.html.contains("\"stepper\":{"));
        assert!(built.html.contains("CJ.__file(\"sim.js\""));
        assert!(built.warnings.is_empty(), "{:?}", built.warnings);
    }
}
