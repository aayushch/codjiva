//! Small helpers shared across the crate.

use crate::error::{AppError, Result};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// The current time as an RFC 3339 timestamp in UTC, such as `2026-11-14T12:00:00Z`.
pub fn now_rfc3339() -> String {
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    rfc3339_from_unix(secs)
}

/// Formats seconds since 1970-01-01 UTC as an RFC 3339 timestamp.
pub fn rfc3339_from_unix(secs: u64) -> String {
    let days = (secs / 86_400) as i64;
    let rest = secs % 86_400;
    // Converts a day count to a calendar date. This is the standard "civil from days" method,
    // which works in 400-year eras that begin on 1 March so the leap day is the last day.
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era = (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 { month_index + 3 } else { month_index - 9 };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z", rest / 3600, (rest % 3600) / 60, rest % 60)
}

/// Writes a file so that a reader never sees it half-written: the text goes to a temporary file
/// in the same folder, which is then renamed over the target.
pub fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let doing = "save a file";
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| AppError::io(doing, e))?;
    }
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    fs::write(&tmp, text).map_err(|e| AppError::io(doing, e))?;
    fs::rename(&tmp, path).map_err(|e| AppError::io(doing, e))
}

/// Reads and parses a JSON file. Returns `Ok(None)` when the file does not exist.
pub fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<Option<T>> {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).map(Some).map_err(|e| {
            AppError::new("bad_json", format!("{} is not valid.", path.display())).with_detail(e)
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(AppError::io("read a settings file", e)),
    }
}

/// Serialises a value as indented JSON and writes it atomically.
pub fn write_json<T: serde::Serialize>(path: &Path, value: &T) -> Result<()> {
    let text = serde_json::to_string_pretty(value).map_err(|e| AppError::new("bad_json", "Could not save a file.").with_detail(e))?;
    write_atomic(path, &(text + "\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_known_instants() {
        assert_eq!(rfc3339_from_unix(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339_from_unix(951_782_400), "2000-02-29T00:00:00Z");
        assert_eq!(rfc3339_from_unix(1_794_657_600), "2026-11-14T12:00:00Z");
    }
}
