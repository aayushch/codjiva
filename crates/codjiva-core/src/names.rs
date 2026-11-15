//! The product's names, in one place. Everything that shows or stores a name
//! reads it from here.

/// The name shown to users.
pub const APP_NAME: &str = "Codjiva";

/// The hidden folder at the root of a workspace that holds everything Codjiva
/// generates.
pub const DOT_DIR: &str = ".codjiva";

/// The URL scheme the app serves artifacts under, as in
/// `codjiva://artifact/...`.
pub const SCHEME: &str = "codjiva";

/// The three parts of the app's reverse-domain identifier, which the operating
/// system uses to pick the folders for settings and logs. The identifier in
/// tauri.conf.json must match.
pub const QUALIFIER: &str = "sh";
pub const ORGANISATION: &str = "aay";
pub const APPLICATION: &str = "codjiva";
