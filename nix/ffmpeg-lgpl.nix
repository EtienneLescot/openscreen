# The ffmpeg both native components link against.
#
# nixpkgs' default has no H.264 encoder this project can use, which the app
# reports precisely:
#
#   aucun encodeur video utilisable : libopenh264: absent de ce build ffmpeg
#
# withOpenh264 defaults to withFullDeps, so only ffmpeg-full carries it, while
# withX264 is on by default and is GPL. Both halves of the override matter.
# scripts/fetch-ffmpeg.mjs vendors BtbN's *lgpl* build and asserts the licence
# before using it, so linking GPL x264 into an MIT application is the exact thing
# upstream takes care to avoid -- a nix package that quietly did it would be a
# licensing fault, not a packaging shortcut.
#
# Its own file because there are now three consumers with different needs, and a
# subtle override copied three times is one bump away from disagreeing with
# itself. compositor-view.nix links it into the napi addon (with every symbol
# renamed, since that one shares an address space with Chromium's libffmpeg);
# pipewire-helper.nix links it normally (a separate process, so no collision);
# package.nix wants only the *binary* and takes the headless variant instead,
# which is a deliberate difference and not drift -- the CLI only decodes to raw
# PCM, so X11 and SDL would be closure weight for nothing.
{ ffmpeg }:

ffmpeg.override {
  withOpenh264 = true;
  withGPL = false;
}
