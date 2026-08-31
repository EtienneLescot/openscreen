<p align="center">
  <img src="public/openscreen.png" alt="OpenScreen Logo" width="64" />
</p>

# <p align="center">OpenScreen</p>

<p align="center"><strong>A free, open-source desktop app for recording your screen and turning the result into polished product demos and walkthroughs.</strong></p>

<p align="center">
  <img src="public/demo.gif" alt="Editing a recording in OpenScreen: wallpaper and video effects, an AI-assisted cut driven from the chat, then export" width="100%" />
</p>

<p align="center">
  <a href="https://github.com/getopenscreen/openscreen/blob/main/LICENSE"><img src="https://img.shields.io/github/license/getopenscreen/openscreen?style=for-the-badge&label=License" alt="License" /></a>
  <a href="https://github.com/getopenscreen/openscreen/releases/latest"><img src="https://img.shields.io/github/v/release/getopenscreen/openscreen?style=for-the-badge&label=Release" alt="Latest Release" /></a>
  <a href="https://github.com/getopenscreen/openscreen/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/getopenscreen/openscreen/ci.yml?style=for-the-badge&label=CI" alt="CI Status" /></a>
  <a href="https://discord.gg/VvT6Vtnyh"><img src="https://img.shields.io/badge/Discord-Join%20us-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-lightgrey?style=for-the-badge" alt="Platform" />
</p>

> [!NOTE]
> **This is OpenScreen, continued.** [Siddharth Vaddem](https://github.com/siddharthvaddem) created the project and [archived the original repository](https://github.com/siddharthvaddem/openscreen) after v1.5.0. Development moved here with his approval, under the same name and the same MIT license.

A raw capture goes in and comes out ready to post — on X, Reddit, YouTube, a docs page, or a landing page. That is the category Screen Studio defined; OpenScreen is the open-source entry in it, and not a clone.

**100% free** for personal and commercial use, with nothing held behind a paywall.

**Project status.** OpenScreen is under active development — expect rough edges and occasional breaking changes, including to the `.openscreen` project format and the CLI. Bug reports are welcome: [open an issue](https://github.com/getopenscreen/openscreen/issues).

## Core Features
- Record a specific window, or your whole screen.
- Record microphone and system audio.
- Webcam overlay with picture-in-picture, drag-to-position, mirroring, and shape options.
- Auto or manual zooms with adjustable depth, duration, easing, and pixel-precise position; auto-zoom follows your cursor as you work.
- Custom cursor size, smoothing, and click effects, with cursor themes and post-recording path smoothing.
- Automatic captions for voiceovers, transcribed on-device with no upload (works offline), with an editable transcript you can cut from and optional subtitle translation.
- AI editing assistant: describe the edit you want in chat and it applies to the timeline — cuts, zooms, speed ramps, annotations, camera framing. Bring your own key (Claude, OpenAI, Gemini, Mistral, OpenRouter, MiniMax, or any OpenAI-compatible endpoint); nothing is enabled by default.
- Wallpapers, solid colors, gradients, or your own background image.
- Motion blur.
- Crop, trim, and per-segment speed control on the timeline.
- Text, arrow, and image annotations, with text animation presets.
- Timeline snapping guides and an audio waveform to make trimming easier.
- Customizable keyboard shortcuts.
- Export to MP4 or GIF in multiple aspect ratios and resolutions, rendered and encoded on the GPU (Metal on macOS, D3D11 on Windows, Vulkan on Linux) with an automatic CPU fallback.
- Languages supported: Arabic, English, Spanish, French, Italian, Japanese, Korean, Portuguese (Brazil), Russian, Turkish, Vietnamese, Simplified Chinese, and Traditional Chinese.

## Command-line interface (headless)

OpenScreen ships a CLI for scripts, CI, and AI coding agents: record the screen
headlessly, edit the `.openscreen` project JSON programmatically (zooms,
annotations, trims), and render MP4/GIF with the full export pipeline — no
visible windows, NDJSON output with `--json`.

```bash
openscreen record --duration 20 --project demo.openscreen --json
openscreen export demo.openscreen -o demo.mp4 --json
```

See [docs/cli.md](./docs/cli.md).

## Installation

Every platform has a recommended route below. On Windows that is the Microsoft Store; everywhere else it is the installer from the [GitHub Releases](https://github.com/getopenscreen/openscreen/releases) page.

### System requirements

- **Windows**: version 1903+ (build 18362) with Intel 8th Gen / AMD Ryzen 2000 series or newer minimum; Windows 11 with Intel 12th Gen / Ryzen 4000 series or newer recommended
- **macOS**: 13 (Ventura) or later — required by ScreenCaptureKit for capture
- **Linux**: `xdg-desktop-portal` and PipeWire for native capture and system audio; recording still works without them through the browser-capture fallback, with fewer capabilities (see [Platform differences](#platform-differences))
- **RAM**: 8 GB minimum, 16 GB recommended

Full table and notes on older integrated graphics: [system requirements](https://getopenscreen.com/docs/installation#system-requirements).

### macOS

Download the `.dmg` installer directly from the [Releases page](https://github.com/getopenscreen/openscreen/releases) and drag OpenScreen into your Applications folder. Builds from 1.9.0 onward are signed with a Developer ID certificate and notarized by Apple, so Gatekeeper does not block them and no terminal step is needed.

On first launch, open **System Settings > Privacy & Security** and grant the two permissions OpenScreen needs: **Screen Recording** and **Accessibility**. Recording cannot start until both are granted.

> [!NOTE]
> **macOS 15 and later re-ask for screen-recording permission periodically.** That prompt comes from macOS itself and applies to every third-party screen recorder — it is not a sign that anything is wrong with your install or that an update broke something. Grant it again when asked.

> [!NOTE]
> **Upgrading from a version older than 1.9.0?** Those builds were not signed with a Developer ID certificate, and macOS ties Screen Recording and Accessibility grants to an app's signature — so it cannot tell the new build is the same app, and the permissions you granted the old one do not carry over. If the new version won't record even after you grant them, remove OpenScreen's existing entries under **System Settings > Privacy & Security** (both Screen Recording and Accessibility), then launch it again and grant them when prompted.

### Windows

**Recommended — Microsoft Store**

[Get OpenScreen from the Microsoft Store](https://apps.microsoft.com/detail/9MXQ1HQJL5G5), or from a terminal:

```powershell
winget install --source msstore OpenScreen
```

Microsoft signs the Store package during certification, so it installs with no security warning and updates itself.

**Alternative — standalone installer**

Download the `.exe` from the [Releases page](https://github.com/getopenscreen/openscreen/releases). Use this if you can't reach the Store — Windows LTSC, a locked-down work machine, an offline install, or if you want a specific older version.

> [!NOTE]
> The `.exe` is not code-signed, so Windows SmartScreen shows **"Windows protected your PC"** and reports an unknown publisher. Choose **More info** → **Run anyway** to continue.
>
> This is not a sign that something is wrong with the download: an unsigned installer earns SmartScreen's trust per file, so a brand-new build always starts out untrusted no matter how many people installed the previous one. Verifying the signature isn't an option here — there is nothing to verify. If you want the checked path, use the Store build above. If you use the `.exe`, download it only from the Releases page linked here.

### Linux

Four packages are published to the [Releases page](https://github.com/getopenscreen/openscreen/releases) for each version. Pick the one that matches your distro:

**Debian / Ubuntu / Pop!_OS (`.deb`)**
```bash
sudo apt install ./Openscreen-Linux-*.deb
```

**Fedora / RHEL / CentOS (`.rpm`)**
```bash
sudo dnf install ./Openscreen-Linux-*.rpm
```

**Arch / Manjaro (`.pacman`)**
```bash
sudo pacman -U Openscreen-Linux-*.pacman
```

**Any distro (`.AppImage`)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

**NixOS / Nix (flake)**

Try without installing:
```bash
nix run github:getopenscreen/openscreen
```

Install into your user profile:
```bash
nix profile install github:getopenscreen/openscreen
```

For a NixOS system config (flake):
```nix
{
  inputs.openscreen.url = "github:getopenscreen/openscreen";

  outputs = { nixpkgs, openscreen, ... }: {
    nixosConfigurations.<host> = nixpkgs.lib.nixosSystem {
      modules = [
        openscreen.nixosModules.default
        { programs.openscreen.enable = true; }
      ];
    };
  };
}
```

For Home Manager, use `openscreen.homeManagerModules.default` with the same `programs.openscreen.enable = true;`.

You may need to grant screen recording permissions depending on your desktop environment.

**Sandbox error:** If the AppImage fails to launch with a "sandbox" error, run it with `--no-sandbox`:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

### Platform differences

Everything in the editor and export is the same on macOS, Windows, and Linux: zooms, backgrounds, motion blur, crop/trim/speed, blur regions, annotations, auto-captions, AI editing, projects, export, and all languages. All three now record through a native capture pipeline; the remaining differences are narrower than they used to be:

- **Native recording**: macOS (ScreenCaptureKit), Windows (Windows Graphics Capture), and Linux (PipeWire via the ScreenCast portal) all record through a native pipeline for higher quality and clean window-level capture. On Linux the browser pipeline stays as an automatic fallback if the helper isn't available.
- **Custom cursors**: on macOS and Windows the real cursor is captured with shape, type, and clicks. Linux captures position and cursor shape through the portal, so cursor themes and the editable cursor overlay work there too. Click effects work on Linux as well, but not through the portal — Wayland exposes no portal for mouse buttons, so the capture helper reads the left button from evdev, which needs your user in the `input` group. Without that, recording is unaffected and every cursor sample is simply a move.
- **Webcam**: Windows muxes the webcam natively into the recording; macOS and Linux record it alongside as a separate file. It works as a picture-in-picture overlay on all three.
- **System audio** support varies by OS:
  - **macOS**: works on every supported version. On macOS 14.2+ you'll be prompted to grant audio capture permission.
  - **Windows**: works out of the box.
  - **Linux**: needs PipeWire (default on Ubuntu 22.04+, Fedora 34+). Older PulseAudio-only setups may not capture system audio (mic should still work).

## Official links

This repository is the community-maintained continuation of OpenScreen.

Official / trusted links:

* Original archived repository: https://github.com/siddharthvaddem/openscreen
* Community continuation: https://github.com/getopenscreen/openscreen
* Official website: https://getopenscreen.com

For safety, download OpenScreen only from the official GitHub Releases linked from this repository. Third-party websites using the OpenScreen name are not affiliated with this continuation unless explicitly listed here.

## Community

OpenScreen is community-driven. If you need help, want to report a bug, or just want to chat with other users and contributors:

- 💬 **Discord** — [Join the OpenScreen Discord](https://discord.gg/VvT6Vtnyh) for real-time help, showcase, and discussion
- 🐞 **[GitHub Issues](https://github.com/getopenscreen/openscreen/issues)** — bug reports and feature requests
- 🗺️ **[Roadmap](./ROADMAP.md)** — see what we're building next

---

## License

This project is licensed under the [MIT License](./LICENSE). By using this software, you agree that the authors are not liable for any issues, damages, or claims arising from its use.
