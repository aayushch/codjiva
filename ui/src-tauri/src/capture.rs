//! Captures part of the app window as a PNG image, using the system webview's own snapshot call.
//!
//! The capture shows exactly what the user sees, including the content of the sandboxed artifact
//! frame, which the page itself cannot read. It is used to give an agent a picture of the frame
//! a user is commenting on, and by the app's self-check.
//!
//! This is implemented for macOS. On other systems `capture` reports that it is unavailable, and
//! callers fall back to describing the frame in words and numbers.

use serde::Deserialize;

/// The area to capture, in the page's own CSS pixels, relative to the top-left of the window's
/// content.
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Captures `rect` of the window's page, or the whole page when `rect` is `None`, and calls
/// `done` with the PNG bytes. `done` may be called on the main thread. `width` is the width of
/// the resulting image in pixels; `None` keeps the screen's own resolution.
#[cfg(target_os = "macos")]
pub fn capture(window: &tauri::WebviewWindow, rect: Option<Rect>, width: Option<f64>, done: impl FnOnce(Result<Vec<u8>, String>) + Send + 'static) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSImage};
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
    use std::sync::Mutex;

    // The completion block may only be called once, but the block type allows several calls,
    // so the callback is taken out of this slot on the first one.
    let slot = std::sync::Arc::new(Mutex::new(Some(done)));
    let for_error = std::sync::Arc::clone(&slot);
    let finish = move |result: Result<Vec<u8>, String>| {
        if let Some(done) = slot.lock().ok().and_then(|mut guard| guard.take()) {
            done(result);
        }
    };

    let started = window.with_webview(move |webview| {
        let Some(mtm) = MainThreadMarker::new() else {
            finish(Err("the capture was not started on the main thread".into()));
            return;
        };
        // SAFETY: on macOS Tauri's platform webview is a WKWebView, and this closure runs on the
        // main thread while the window, which owns the view, is alive.
        let view: &WKWebView = unsafe { &*(webview.inner() as *const WKWebView) };
        let config = unsafe { WKSnapshotConfiguration::new(mtm) };
        if let Some(r) = rect {
            unsafe { config.setRect(CGRect { origin: CGPoint { x: r.x, y: r.y }, size: CGSize { width: r.width, height: r.height } }) };
        }
        if let Some(w) = width {
            unsafe { config.setSnapshotWidth(Some(&NSNumber::new_f64(w))) };
        }
        let block = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
            // SAFETY: WebKit passes either a valid image or a valid error, for the length of this call.
            let result = unsafe {
                match image.as_ref() {
                    None => Err(error.as_ref().map(|e| e.localizedDescription().to_string()).unwrap_or_else(|| "the webview returned no image".into())),
                    Some(image) => image.TIFFRepresentation()
                        .and_then(|tiff| NSBitmapImageRep::imageRepWithData(&tiff))
                        .and_then(|bitmap| bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new()))
                        .map(|png| png.to_vec())
                        .ok_or_else(|| "the captured image could not be converted to PNG".to_string()),
                }
            };
            finish(result);
        });
        unsafe { view.takeSnapshotWithConfiguration_completionHandler(Some(&config), &block) };
    });
    if let Err(e) = started {
        if let Some(done) = for_error.lock().ok().and_then(|mut guard| guard.take()) {
            done(Err(format!("the webview could not be reached: {e}")));
        }
    }
}

#[cfg(not(target_os = "macos"))]
pub fn capture(_window: &tauri::WebviewWindow, _rect: Option<Rect>, _width: Option<f64>, done: impl FnOnce(Result<Vec<u8>, String>) + Send + 'static) {
    done(Err("capturing the window is not available on this system yet".into()));
}

/// Captures `rect` of the main window's page and returns the PNG bytes. See [`capture`] for the
/// arguments. Fails with the code `capture_failed` when the picture cannot be taken, which is
/// always the case on systems other than macOS.
pub async fn capture_png(app: &tauri::AppHandle, rect: Option<Rect>, width: Option<f64>) -> codjiva_core::error::Result<Vec<u8>> {
    use codjiva_core::error::AppError;
    use tauri::Manager;
    let window = app.get_webview_window("main").ok_or_else(|| AppError::new("no_window", "The main window is gone."))?;
    let (tx, rx) = std::sync::mpsc::channel();
    capture(&window, rect, width, move |result| { let _ = tx.send(result); });
    tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(std::time::Duration::from_secs(15)))
        .await
        .map_err(|e| AppError::new("capture_failed", "The screenshot could not be taken.").with_detail(e))?
        .map_err(|_| AppError::new("capture_failed", "The screenshot was not delivered in time."))?
        .map_err(|e| AppError::new("capture_failed", "The screenshot could not be taken.").with_detail(e))
}
