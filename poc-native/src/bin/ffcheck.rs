// Minimal: can ffmpeg-next link against the 8.1.2 dev libs and open a decoder?
fn main() {
    ffmpeg_next::init().expect("ffmpeg init");
    let ictx = ffmpeg_next::format::input(&"../poc/media/screen.mp4").expect("open");
    let stream = ictx.streams().best(ffmpeg_next::media::Type::Video).expect("video stream");
    let dec = ffmpeg_next::codec::context::Context::from_parameters(stream.parameters()).unwrap();
    let v = dec.decoder().video().unwrap();
    println!("in-process decode OK: {}x{} {:?}", v.width(), v.height(), v.format());
}
