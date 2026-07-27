fn main() {
    // Configure le linker Windows pour un module chargeable par Node (symboles napi_*
    // résolus au chargement par le process Node/Electron).
    napi_build::setup();
}
