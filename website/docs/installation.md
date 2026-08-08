---
id: installation
title: Installation
sidebar_position: 2
description: "Install OpenScreen on macOS, Windows, or Linux — .dmg, .exe, .deb, .rpm, .pacman, AppImage, and a Nix flake, including the macOS Gatekeeper step."
keywords:
  - install screen recorder
  - download OpenScreen
  - macOS dmg
  - Windows installer
  - Linux deb
  - Fedora rpm
  - AppImage
  - Nix flake
---

# Installation

Download the latest installer for your platform from the [download page](/download), or straight from [GitHub Releases](https://github.com/getopenscreen/openscreen/releases).

## macOS

Download the `.dmg` installer from [Releases](https://github.com/getopenscreen/openscreen/releases). If Gatekeeper blocks the app, remove the quarantine flag:

```bash
xattr -rd com.apple.quarantine /Applications/Openscreen.app
```

:::note
Give your terminal **Full Disk Access** in System Settings → Privacy & Security first, then run the command above.
:::

After that, go to **System Settings → Privacy & Security** and grant **Screen Recording** and **Accessibility** to OpenScreen. Launch the app once permissions are granted.

:::tip Upgrading and recording won't start?
If OpenScreen was already installed and a new version won't record (Screen Recording or Accessibility keep failing even after granting them), uninstall the old version, remove OpenScreen's entries under both permissions in System Settings, then reinstall and grant them fresh.
:::

## Windows

Download and run the `.exe` installer from [Releases](https://github.com/getopenscreen/openscreen/releases).

## Linux

Four packages are published per release — pick the one matching your distro.

**Debian / Ubuntu / Pop!_OS**
```bash
sudo apt install ./Openscreen-Linux-*.deb
```

**Fedora / RHEL / CentOS**
```bash
sudo dnf install ./Openscreen-Linux-*.rpm
```

**Arch / Manjaro**
```bash
sudo pacman -U Openscreen-Linux-*.pacman
```

**Any distro (AppImage)**
```bash
chmod +x Openscreen-Linux-*.AppImage
./Openscreen-Linux-*.AppImage
```

If the AppImage fails to launch with a sandbox error:
```bash
./Openscreen-Linux-*.AppImage --no-sandbox
```

**NixOS / Nix (flake)**

Try it without installing:
```bash
nix run github:getopenscreen/openscreen
```

Install into your user profile:
```bash
nix profile install github:getopenscreen/openscreen
```

As a NixOS system module:
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

Home Manager users can use `openscreen.homeManagerModules.default` with the same `programs.openscreen.enable = true;`.

You may need to grant screen-recording permission depending on your desktop environment.

## Platform differences

The editing tools are the same everywhere — zooms, backgrounds, crop/trim/speed, annotations, transcription, captions, and projects. **Capture** and **MP4 export** differ:

| | macOS | Windows | Linux |
|---|---|---|---|
| Capture pipeline | Native (ScreenCaptureKit) | Native (Windows Graphics Capture) | Browser pipeline |
| Custom cursor themes / click effects | ✅ | ✅ | ❌ (position-only, used for auto-zoom) |
| Webcam | Native capture | Native capture | Browser capture (still works as PiP) |
| System audio | macOS 13+; permission prompt on 14.2+; not available on macOS 12 and below | Works out of the box | Needs PipeWire (default on Ubuntu 22.04+, Fedora 34+) |
| MP4 export | ❌ not yet | ✅ | ❌ not yet |
| GIF export | ✅ | ✅ | ✅ |
| On-device transcription | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::warning MP4 export is Windows-only for now
The GPU compositor behind the live preview and MP4 export is built on Direct3D 11 and currently ships only in the Windows build. Recording, editing, and GIF export work on all three platforms; MP4 export does not yet. Track it on the [roadmap](https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md).
:::

Next: [Quick start](./quick-start.md) walks through your first recording.
