# Code signing policy

Windows release binaries of OpenScreen are signed. This page documents who can
change the code that gets signed, who can authorise a signature, and what the
signature does and does not tell you.

Free code signing is provided by [SignPath.io](https://signpath.io/), with a
certificate issued by the [SignPath Foundation](https://signpath.org/).

## What is signed

The Windows installer (`Openscreen.Setup.<version>.exe`) published on the
[GitHub releases page](https://github.com/getopenscreen/openscreen/releases).

The Microsoft Store package is **not** signed with this certificate — Microsoft
re-signs Store submissions during certification, so Store installs carry
Microsoft's signature instead.

macOS builds are signed and notarised separately with an Apple Developer ID.

## Roles

| Role | Who | What they may do |
|---|---|---|
| Committer | Etienne Lescot ([@EtienneLescot](https://github.com/EtienneLescot)) | Push to the repository and merge pull requests. |
| Reviewer | Etienne Lescot | Review pull requests before merge. |
| Approver | Etienne Lescot | Approve a signing request in SignPath. |

OpenScreen currently has a single maintainer, so these roles are held by one
person. This page is updated if that changes.

All accounts with commit or signing access use multi-factor authentication, on
both GitHub and SignPath.

## How signing works

Signing is not performed on a developer machine and no maintainer ever holds the
private key — it stays on SignPath's HSM and is never issued to us.

1. A tagged release triggers the `Build Electron App` workflow on GitHub Actions.
2. The workflow builds the installer from the tagged source and uploads it as a
   workflow artifact.
3. SignPath retrieves that artifact directly from the workflow run, verifying it
   came from this repository's CI rather than from an uploaded file.
4. The maintainer approves the signing request in the SignPath dashboard.
5. The signed installer is returned to the workflow, its signature is verified,
   and it is published as the release artifact.

Because the artifact is pulled from the workflow run rather than submitted by
hand, a signature attests that the binary was built by this repository's CI from
tagged source.

## What the signature means

It confirms that the installer was produced by this project and has not been
modified since it was signed. Windows shows a verified publisher instead of
"Unknown publisher".

It is **not** a security audit, a warranty, or a guarantee that the software is
free of defects. OpenScreen is MIT-licensed and provided as is, without warranty
of any kind; see [LICENSE](LICENSE). The SignPath Foundation accepts no liability
for signed software.

Note that this is an OV certificate, not EV. Microsoft SmartScreen builds
reputation for a signing identity over time, so recent releases may still show a
warning until enough downloads have accumulated. Choosing "More info" then "Run
anyway" is expected in that window; the publisher name shown should read as
documented above.

## Privacy

OpenScreen requires no account and performs no telemetry. Recordings, edits and
automatic captions are processed entirely on the user's device. The one network
request the application makes is downloading the speech-to-text model on first
use of automatic captions.

<!-- TODO(maintainer): link the published privacy policy URL here — the SignPath
     Foundation conditions require this page to reference it, and the same URL is
     already declared in the Microsoft Store submission. -->

## Reporting a problem

If you believe a signed OpenScreen binary is malicious or has been tampered
with, open an issue at
[getopenscreen/openscreen/issues](https://github.com/getopenscreen/openscreen/issues).
