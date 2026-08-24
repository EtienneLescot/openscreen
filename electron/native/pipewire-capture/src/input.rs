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
//! other key code, and it only ever opens devices that advertise `BTN_LEFT` in
//! the first place. Set `OPENSCREEN_DISABLE_CLICK_CAPTURE=1` to turn it off
//! entirely even where the permission exists.

use std::sync::mpsc::Sender;
use std::thread;

use evdev::{Device, EventType, KeyCode};

use crate::Message;

const DISABLE_ENV: &str = "OPENSCREEN_DISABLE_CLICK_CAPTURE";

/// True when this evdev event is the press edge of the left mouse button.
///
/// Extracted as a pure function so the decision is unit-testable without a real
/// device: a release (`value == 0`), an autorepeat (`value == 2`), and every
/// non-`BTN_LEFT` code — including every keyboard key — must NOT count.
pub fn is_left_button_press(event_type: EventType, code: u16, value: i32) -> bool {
    event_type == EventType::KEY && code == KeyCode::BTN_LEFT.0 && value == 1
}

/// Opens every readable pointer device that reports `BTN_LEFT` and spawns a
/// reader thread per device. Returns whether at least one was opened — the caller
/// uses that to tell the log why Linux clicks are or are not being captured.
///
/// Never fails: an unreadable node (the common case, when the user is not in the
/// `input` group) is skipped by `evdev::enumerate`, and no readable node at all
/// simply means every sample stays `"move"`, exactly as before this existed.
pub fn spawn_readers(sender: &Sender<Message>) -> bool {
    if std::env::var_os(DISABLE_ENV).is_some() {
        return false;
    }
    let mut opened = 0usize;
    for (_path, device) in evdev::enumerate() {
        if !device_reports_left_button(&device) {
            continue;
        }
        opened += 1;
        let forward = sender.clone();
        thread::spawn(move || read_device(device, forward));
    }
    opened > 0
}

fn device_reports_left_button(device: &Device) -> bool {
    device
        .supported_keys()
        .is_some_and(|keys| keys.contains(KeyCode::BTN_LEFT))
}

/// Blocks reading `device`, forwarding one `PointerButton` message per left-button
/// press. Returns when the device errors (e.g. unplugged) or the loop's channel
/// has closed, so the thread cannot outlive the recording it serves.
fn read_device(mut device: Device, sender: Sender<Message>) {
    loop {
        let events = match device.fetch_events() {
            Ok(events) => events,
            Err(_) => return,
        };
        for event in events {
            if is_left_button_press(event.event_type(), event.code(), event.value())
                && sender.send(Message::PointerButton).is_err()
            {
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
