//! Left mouse-button telemetry on Wayland, read from evdev.
//!
//! WHY THIS EXISTS. Wayland deliberately denies an unprivileged process any view
//! of global input: the ScreenCast portal reports cursor POSITION as frame
//! metadata but never button state, and the only portal that streams input
//! (`InputCapture`) *grabs* it, redirecting clicks away from the app being
//! recorded — useless while the user is demoing. The one remaining source is the
//! kernel's evdev interface (`/dev/input/event*`). Reading it needs membership in
//! the `input` group (the nodes are `root:input`), which is the user's own,
//! out-of-band act of consent — the Wayland equivalent of the button state the
//! macOS and Windows helpers already read from their native APIs.
//!
//! SCOPE AND PRIVACY. A pointer node can also deliver keystrokes on a combined
//! keyboard+mouse device. This reader inspects ONLY `EV_KEY` events whose code is
//! `BTN_LEFT`, and only their press edge; it never reads, stores, or forwards any
//! other key code. Enumerating the devices does briefly open each readable
//! `/dev/input/event*` node to inspect its capability bits, but any node that
//! does not advertise `BTN_LEFT` is dropped immediately, without a single event
//! ever being read from it — only `BTN_LEFT` devices get a reader. Set
//! `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` to turn it off entirely even where the
//! permission exists.

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use evdev::{Device, EventType, KeyCode};

use crate::events::timestamp_ms;
use crate::Message;

const DISABLE_ENV: &str = "OPENSCREEN_DISABLE_CLICK_CAPTURE";

/// How often the hotplug watcher re-scans `/dev/input` for pointer devices that
/// appeared after startup. A few seconds is imperceptible for a device the user
/// just plugged in and costs a cheap directory walk.
const RESCAN_INTERVAL: Duration = Duration::from_secs(3);

/// True when this evdev event is the press edge of the left mouse button.
///
/// Extracted as a pure function so the decision is unit-testable without a real
/// device: a release (`value == 0`), an autorepeat (`value == 2`), and every
/// non-`BTN_LEFT` code — including every keyboard key — must NOT count.
pub fn is_left_button_press(event_type: EventType, code: u16, value: i32) -> bool {
    event_type == EventType::KEY && code == KeyCode::BTN_LEFT.0 && value == 1
}

/// What [`spawn_readers`] settled on — the caller uses it to tell the log why
/// Linux clicks are or are not being captured.
///
/// The two ways of ending up without clicks are NOT the same event: no readable
/// node is a permission the operator may still want to grant, while `DISABLE_ENV`
/// is one they explicitly declined — recommending the `input` group there answers
/// a question nobody asked.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ClickCapture {
    /// Turned off by `OPENSCREEN_DISABLE_CLICK_CAPTURE`; nothing was opened.
    Disabled,
    /// No readable `/dev/input` node reports `BTN_LEFT` — the common case, when
    /// the user is not in the `input` group.
    NoDevice,
    /// At least one device is open, with a reader thread running on it.
    Active,
}

/// Opens every readable pointer device that reports `BTN_LEFT`, spawns a reader
/// thread per device, and leaves a daemon thread re-scanning for devices plugged
/// in later.
///
/// Never fails: an unreadable node (the common case, when the user is not in the
/// `input` group) is skipped by `evdev::enumerate`, and no readable node at all
/// simply means every sample stays `"move"`, exactly as before this existed. The
/// returned value reflects the INITIAL scan only — a device attached afterwards
/// is adopted by the watcher without changing it.
pub fn spawn_readers(sender: &Sender<Message>) -> ClickCapture {
    if std::env::var_os(DISABLE_ENV).is_some() {
        return ClickCapture::Disabled;
    }
    // Paths with a LIVE reader. Shared with the reader threads: each removes its
    // own path when it exits, so a device that unplugs and reconnects on the SAME
    // node path is adopted again by the next scan. A set that only grew skipped
    // such a replug for the rest of the recording.
    let opened: Arc<Mutex<HashSet<PathBuf>>> = Arc::new(Mutex::new(HashSet::new()));
    scan_once(sender, &opened);
    let result = if opened.lock().unwrap().is_empty() {
        ClickCapture::NoDevice
    } else {
        ClickCapture::Active
    };
    // Hotplug: the one-shot scan above cannot see a mouse attached mid-recording,
    // so a daemon thread re-scans and starts readers for nodes it has not seen.
    // Detached, like the reader threads — it ends when the process does.
    let watch_sender = sender.clone();
    let watch_opened = Arc::clone(&opened);
    thread::spawn(move || loop {
        thread::sleep(RESCAN_INTERVAL);
        scan_once(&watch_sender, &watch_opened);
    });
    result
}

/// Spawns a reader for every `BTN_LEFT` device not already being read, recording
/// each newly opened node's path. Shared by the initial scan and the watcher; the
/// check-and-insert is one locked step so two scans cannot both adopt one path.
fn scan_once(sender: &Sender<Message>, opened: &Arc<Mutex<HashSet<PathBuf>>>) {
    for (path, device) in evdev::enumerate() {
        if !device_reports_left_button(&device) {
            continue;
        }
        if !opened.lock().unwrap().insert(path.clone()) {
            continue; // already has a live reader
        }
        let forward = sender.clone();
        let owned = Arc::clone(opened);
        thread::spawn(move || read_device(device, path, forward, owned));
    }
}

/// A touchpad advertises `BTN_LEFT` for a physical clickpad press, so it passes
/// this check and its node is opened — but tap-to-click never arrives here.
/// libinput consumes the raw `BTN_TOUCH`/`ABS_MT_*` stream and synthesises the
/// button for its own clients without writing `BTN_LEFT` back to the kernel
/// device, so a tap is invisible at the evdev layer we read. The consequence is
/// documented for users under "Mouse clicks on Wayland" in the installation docs:
/// on a touchpad only hard presses are captured, taps are not.
fn device_reports_left_button(device: &Device) -> bool {
    device
        .supported_keys()
        .is_some_and(|keys| keys.contains(KeyCode::BTN_LEFT))
}

/// Blocks reading `device`, forwarding one `PointerButton` message per left-button
/// press, each stamped with the press time so a click is not backdated to the
/// next cursor sample. Returns when the device fails terminally (e.g. unplugged)
/// or the loop's channel has closed, so the thread cannot outlive the recording
/// it serves. A transient `EINTR` is retried, not mistaken for an unplug.
///
/// On EVERY exit it drops `path` from `opened`, so a device reconnecting on the
/// same node path is re-adopted by the next scan.
fn read_device(
    mut device: Device,
    path: PathBuf,
    sender: Sender<Message>,
    opened: Arc<Mutex<HashSet<PathBuf>>>,
) {
    let release = || {
        opened.lock().unwrap().remove(&path);
    };
    loop {
        let events = match device.fetch_events() {
            Ok(events) => events,
            // A signal interrupted the blocking read — not a device failure.
            Err(err) if err.kind() == ErrorKind::Interrupted => continue,
            // A real error, typically the device unplugging. Report it rather
            // than ending silently, so click capture going quiet mid-recording
            // is answerable from the log; the watcher re-adopts it on a replug.
            Err(err) => {
                release();
                let _ = sender.send(Message::PointerDeviceLost(err.to_string()));
                return;
            }
        };
        for event in events {
            if is_left_button_press(event.event_type(), event.code(), event.value())
                && sender.send(Message::PointerButton(timestamp_ms())).is_err()
            {
                release();
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const BTN_LEFT: u16 = KeyCode::BTN_LEFT.0;
    const BTN_RIGHT: u16 = KeyCode::BTN_RIGHT.0;

    #[test]
    fn a_left_button_press_is_a_click() {
        assert!(is_left_button_press(EventType::KEY, BTN_LEFT, 1));
    }

    #[test]
    fn a_left_button_release_is_not() {
        assert!(!is_left_button_press(EventType::KEY, BTN_LEFT, 0));
    }

    #[test]
    fn a_left_button_autorepeat_is_not() {
        // A held button emits value 2; only the 0->1 edge is a click.
        assert!(!is_left_button_press(EventType::KEY, BTN_LEFT, 2));
    }

    #[test]
    fn a_right_button_press_is_not_a_left_click() {
        assert!(!is_left_button_press(EventType::KEY, BTN_RIGHT, 1));
    }

    #[test]
    fn a_key_matching_btn_lefts_code_on_another_axis_is_not_a_click() {
        // Same numeric code but a relative-motion event, not a key — must miss.
        assert!(!is_left_button_press(EventType::RELATIVE, BTN_LEFT, 1));
    }
}
