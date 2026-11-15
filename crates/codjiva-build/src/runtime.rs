//! The files the builder embeds in every artifact: the runtime, the styles, the
//! fonts and the JSON schemas. They are compiled into this crate, so the
//! builder needs no files at run time.

use crate::scan;

/// The version of the runtime API. It is written into every artifact and every
/// manifest, so an artifact can be rebuilt later with a newer runtime that
/// still understands its sources.
pub const RUNTIME_VERSION: &str = "1.1.1";

macro_rules! runtime_file {
    ($name:literal) => {
        (
            $name,
            include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../runtime/src/",
                $name
            )),
        )
    };
}

/// The runtime's source files in the order they are joined. Later files use the
/// constants that earlier files declare.
const RUNTIME_PARTS: &[(&str, &str)] = &[
    runtime_file!("00-kit.js"),
    runtime_file!("10-geom.js"),
    runtime_file!("20-parts.js"),
    runtime_file!("30-warp.js"),
    runtime_file!("40-camera.js"),
    runtime_file!("50-audio.js"),
    runtime_file!("60-film.js"),
    runtime_file!("70-visual.js"),
    runtime_file!("80-selftest.js"),
    runtime_file!("90-player.js"),
];

const TOKENS_CSS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/theme/tokens.css"
));
const RUNTIME_CSS: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../runtime/css/runtime.css"
));

const FONT_400: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/fonts/jetbrains-mono-latin-400-normal.woff2"
));
const FONT_700: &[u8] = include_bytes!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/fonts/jetbrains-mono-latin-700-normal.woff2"
));

pub const FILM_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/schemas/film.schema.json"
));
pub const VISUAL_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/schemas/visual.schema.json"
));
pub const MODEL_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/schemas/model.schema.json"
));
pub const PIPELINE_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/schemas/pipeline.schema.json"
));
pub const OUTLINE_SCHEMA: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../resources/schemas/outline.schema.json"
));

/// The runtime as one script, ready to inline. All files are joined inside one
/// function so their shared constants stay private, and comments are removed to
/// keep artifacts small.
pub fn runtime_js() -> String {
    let mut joined = String::from("(function () {\n'use strict';\n");
    for (_, source) in RUNTIME_PARTS {
        joined.push_str(&scan::strip_comments(source));
        joined.push('\n');
    }
    joined.push_str("})();\n");
    // Collapse the blank lines that removing comments leaves behind.
    let mut out = String::with_capacity(joined.len());
    for line in joined.lines() {
        if !line.trim().is_empty() {
            out.push_str(line.trim_end());
            out.push('\n');
        }
    }
    out
}

/// The reference agents read to write plants and scenes. It is collected from
/// the `/*@api ... */` comment blocks in the runtime's sources, in file order.
pub fn runtime_api_doc() -> String {
    let mut doc = format!(
        "# Codjiva runtime API (version {RUNTIME_VERSION})\n\nEverything \
         below is on the global object `CJ`. It is the only API your code may \
         use.\n"
    );
    for (_, source) in RUNTIME_PARTS {
        let mut rest = *source;
        while let Some(start) = rest.find("/*@api") {
            let after = &rest[start + "/*@api".len()..];
            let Some(end) = after.find("*/") else { break };
            doc.push('\n');
            doc.push_str(after[..end].trim());
            doc.push('\n');
            rest = &after[end + 2..];
        }
    }
    doc
}

fn font_face(weight: u16, bytes: &[u8]) -> String {
    use base64::Engine;
    let data = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!(
        "@font-face {{ font-family:'JetBrains Mono'; font-style:normal; \
         font-weight:{weight}; font-display:block; \
         src:url(data:font/woff2;base64,{data}) format('woff2') }}\n"
    )
}

/// All CSS an artifact needs before the agent's optional extra.css: the
/// embedded fonts, the theme tokens and the runtime's own styles.
pub fn base_css() -> String {
    let mut css = font_face(400, FONT_400);
    css.push_str(&font_face(700, FONT_700));
    css.push_str(TOKENS_CSS);
    css.push_str(RUNTIME_CSS);
    css
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_declares_the_same_version_as_the_builder() {
        assert!(
            runtime_js().contains(&format!("CJ.version = '{RUNTIME_VERSION}'"))
        );
    }

    #[test]
    fn runtime_has_no_comments_and_api_doc_has_the_blocks() {
        let js = runtime_js();
        assert!(!js.contains("@api"));
        let doc = runtime_api_doc();
        assert!(doc.contains("## Time and easing"));
        assert!(doc.contains("CJ.definePlant"));
    }
}
