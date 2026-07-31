//! xdg-desktop-portal ScreenCast negotiation.
//!
//! The five-call dance is CreateSession → SelectSources → Start →
//! OpenPipeWireRemote, each async call answering on a Request object's Response
//! signal. ashpd subscribes to that signal before issuing the call, which is
//! the part that is easy to get wrong by hand (subscribe after, and the reply
//! can land before the match rule exists).
//!
//! Two properties of the protocol shape this module:
//!
//!   * SelectSources may be called ONCE per session. A second call fails with
//!     `Sources already selected`. Everything — cursor mode, source types,
//!     persistence — has to be decided before the first call.
//!   * Start is what raises the compositor's source picker. It does not return
//!     until a human has clicked, so nothing downstream may hold a timeout.
//!
//! ashpd is used rather than raw zbus because it is pure Rust (no libdbus-1-dev)
//! and because its `pipewire` feature — which would drag in pipewire-rs and
//! therefore libpipewire-0.3-dev — is deliberately left off; the PipeWire half
//! lives in csrc/pw_shim.c instead.

use std::os::fd::OwnedFd;

use ashpd::desktop::screencast::{CursorMode as PortalCursorMode, Screencast, SourceType};
use ashpd::desktop::PersistMode;
use ashpd::enumflags2::BitFlags;
use ashpd::WindowIdentifier;

/// Which of the portal's three cursor modes to ask for.
///
/// This is the HUD's cursor-mode toggle, one layer down. `Metadata` is what
/// makes the editable cursor possible at all — the compositor keeps the pointer
/// out of the pixels and describes it separately — and `Embedded` is the
/// "system cursor" setting, where the compositor paints it in and the editor
/// leaves it alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CursorMode {
    Metadata,
    Embedded,
    Hidden,
}

impl CursorMode {
    fn to_portal(self) -> PortalCursorMode {
        match self {
            Self::Metadata => PortalCursorMode::Metadata,
            Self::Embedded => PortalCursorMode::Embedded,
            Self::Hidden => PortalCursorMode::Hidden,
        }
    }

    /// Only METADATA yields cursor samples; in the other modes the pointer is
    /// either painted into the frames or absent, and there is no metadata to
    /// read either way.
    pub fn reports_cursor(self) -> bool {
        matches!(self, Self::Metadata)
    }
}

/// Everything the PipeWire half needs, plus what the helper reports upward.
pub struct PortalStream {
    pub fd: OwnedFd,
    pub node_id: u32,
    pub position: Option<(i32, i32)>,
    pub size: Option<(i32, i32)>,
    pub restore_token: Option<String>,
}

#[derive(Debug)]
pub enum PortalError {
    /// The compositor's portal does not offer METADATA cursor mode. Nothing
    /// this helper does can work without it, and falling back to EMBEDDED would
    /// bake the cursor into the pixels, which is the opposite of what the
    /// editor needs.
    CursorMetadataUnsupported,
    /// The user dismissed the picker, or the portal refused.
    Cancelled,
    Failed(String),
}

impl PortalError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::CursorMetadataUnsupported => "cursor-metadata-unsupported",
            Self::Cancelled => "portal-cancelled",
            Self::Failed(_) => "portal-failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            Self::CursorMetadataUnsupported => {
                "The ScreenCast portal does not advertise METADATA cursor mode, so real cursor \
                 positions cannot be obtained on this session."
                    .to_owned()
            }
            Self::Cancelled => "The screen capture request was cancelled.".to_owned(),
            Self::Failed(message) => message.clone(),
        }
    }
}

fn failed(context: &str, error: impl std::fmt::Display) -> PortalError {
    PortalError::Failed(format!("{context}: {error}"))
}

/// Cheap, non-interactive probe: does this portal offer METADATA cursor mode?
///
/// Split out from [`negotiate`] so the helper can answer that question — and
/// emit `ready` — before anything raises a dialog.
pub async fn cursor_metadata_supported() -> Result<bool, PortalError> {
    let proxy = Screencast::new()
        .await
        .map_err(|error| failed("cannot reach org.freedesktop.portal.ScreenCast", error))?;
    let cursor_modes = proxy
        .available_cursor_modes()
        .await
        .map_err(|error| failed("AvailableCursorModes", error))?;
    Ok(cursor_modes.contains(PortalCursorMode::Metadata))
}

/// Runs the negotiation to completion. Blocks on the user for as long as the
/// picker is up: `Start()` is what raises it.
///
/// The returned `PortalStream` outlives the ashpd `Session` object on purpose.
/// ashpd has no `Drop` impl for sessions and holds its D-Bus connection in a
/// process-global `OnceLock`, so the portal session stays open until this
/// process exits — which is exactly the lifetime we want.
pub async fn negotiate(
    restore_token: Option<&str>,
    cursor_mode: CursorMode,
) -> Result<PortalStream, PortalError> {
    let proxy = Screencast::new()
        .await
        .map_err(|error| failed("cannot reach org.freedesktop.portal.ScreenCast", error))?;

    let cursor_modes = proxy
        .available_cursor_modes()
        .await
        .map_err(|error| failed("AvailableCursorModes", error))?;
    // Only METADATA is treated as mandatory, and only when it was asked for.
    // EMBEDDED is in the portal spec's baseline and every compositor implements
    // it; refusing to start because a mode we are not using is missing would be
    // the Stage 1 check applied where it no longer belongs.
    if !cursor_modes.contains(cursor_mode.to_portal()) {
        return Err(match cursor_mode {
            CursorMode::Metadata => PortalError::CursorMetadataUnsupported,
            other => PortalError::Failed(format!(
                "the ScreenCast portal does not offer the {other:?} cursor mode"
            )),
        });
    }

    let session = proxy
        .create_session()
        .await
        .map_err(|error| failed("CreateSession", error))?;

    // Monitors and windows both; the picker decides which. Virtual sources are
    // excluded — a virtual monitor has no cursor to report.
    let types: BitFlags<SourceType> = SourceType::Monitor | SourceType::Window;
    proxy
        .select_sources(
            &session,
            cursor_mode.to_portal(),
            types,
            false,
            restore_token,
            // The picker is a per-recording interruption otherwise. Persisting
            // until the user revokes it means the restore token from a previous
            // run can skip it entirely.
            PersistMode::ExplicitlyRevoked,
        )
        .await
        .map_err(|error| failed("SelectSources", error))?
        .response()
        .map_err(|error| failed("SelectSources response", error))?;

    let streams = proxy
        .start(&session, &WindowIdentifier::default())
        .await
        .map_err(|error| failed("Start", error))?
        .response()
        .map_err(|error| match error {
            ashpd::Error::Response(ashpd::desktop::ResponseError::Cancelled) => {
                PortalError::Cancelled
            }
            other => failed("Start response", other),
        })?;

    let stream = streams
        .streams()
        .first()
        .ok_or_else(|| PortalError::Failed("the portal returned no stream".to_owned()))?;

    let fd = proxy
        .open_pipe_wire_remote(&session)
        .await
        .map_err(|error| failed("OpenPipeWireRemote", error))?;

    Ok(PortalStream {
        fd,
        node_id: stream.pipe_wire_node_id(),
        position: stream.position(),
        size: stream.size(),
        restore_token: streams.restore_token().map(str::to_owned),
    })
}
