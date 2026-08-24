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

## System requirements

| | Minimum | Recommended |
|---|---|---|
| **Windows** | Windows 10 version 1903 (build 18362) or later, Intel 8th Gen / AMD Ryzen 2000 series or newer | Windows 11, Intel 12th Gen / AMD Ryzen 4000 series or newer |
| **macOS** | macOS 12.3 (Monterey) — required by ScreenCaptureKit for native capture | macOS 14 or later |
| **Linux** | `xdg-desktop-portal` and PipeWire for native capture and system audio (default on Ubuntu 22.04+, Fedora 34+) — recording still works without them through the [browser-capture fallback](#platform-differences), with fewer capabilities | Same, kept up to date |
| **RAM** | 8 GB | 16 GB |

:::note Older integrated graphics on Windows
Machines with integrated graphics older than roughly 8th-generation Intel (or the equivalent AMD Ryzen 2000 series) are not blocked from installing, but some have known driver stability issues that can make a recording fail to stop and save — see [#460](https://github.com/getopenscreen/openscreen/issues/460). If you hit this, open the tray icon or **Help → Save Diagnostics** right after the failure (before starting another recording) and attach the file to a bug report.
:::

## macOS

Download the `.dmg` installer from [Releases](https://github.com/getopenscreen/openscreen/releases) and drag OpenScreen into your Applications folder. Builds from 1.9.0 onward are signed with a Developer ID certificate and notarized by Apple, so Gatekeeper does not block them and no terminal step is needed.

Then go to **System Settings → Privacy & Security** and grant **Screen Recording** and **Accessibility** to OpenScreen. Recording cannot start until both are granted.

:::note macOS 15 and later re-ask periodically
macOS re-requests screen-recording permission from time to time for every third-party screen recorder. That prompt comes from the operating system — it does not mean your install is broken or that an update went wrong. Grant it again when asked.
:::

:::tip Upgrading from a version older than 1.9.0?
Those builds were not signed with a Developer ID certificate, and macOS ties Screen Recording and Accessibility grants to an app's signature — so it cannot tell the new build is the same app, and the permissions you granted the old one do not carry over. If a new version won't record even after granting them, remove OpenScreen's entries under both permissions in System Settings, then launch it again and grant them fresh.
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

The editing tools are the same everywhere — zooms, backgrounds, crop/trim/speed, annotations, transcription, captions, and projects. Every export format works on every platform; what differs is **capture**, and how fast MP4 encodes on Linux:

| | macOS | Windows | Linux |
|---|---|---|---|
| Capture pipeline | Native (ScreenCaptureKit) | Native (Windows Graphics Capture) | Browser pipeline |
| Custom cursor themes / click effects | ✅ | ✅ | ❌ (position-only, used for auto-zoom) |
| Webcam | Native capture | Native capture | Browser capture (still works as PiP) |
| System audio | macOS 13+; permission prompt on 14.2+; not available on macOS 12 and below | Works out of the box | Needs PipeWire (default on Ubuntu 22.04+, Fedora 34+) |
| MP4 export | ✅ | ✅ | ✅ (software encode) |
| GIF export | ✅ | ✅ | ✅ |
| On-device transcription | Metal (Apple Silicon) / CPU | Vulkan / CPU | Vulkan / CPU |

:::note MP4 export on Linux
The GPU compositor behind the live preview and MP4 export has three backends — Direct3D 11 on Windows, Metal on macOS, wgpu/WGSL on Linux — and ships in all three builds. The Linux one encodes in software rather than on the GPU, so an export there takes longer than the same one on Windows or macOS; hardware encode is tracked on the [roadmap](https://github.com/getopenscreen/openscreen/blob/main/ROADMAP.md).
:::

Next: [Quick start](./quick-start.md) walks through your first recording.
