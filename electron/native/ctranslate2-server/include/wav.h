// Minimal PCM WAV loader for the ctranslate2-server input pipeline.
//
// ponytail: the wire contract (electron/stt/wav.ts::writeSamplesAsWav) emits
// exactly 16-bit LE mono 16 kHz PCM with a fixed 44-byte header. We validate
// those four fields at load time and refuse anything else — the upstream is
// fully internal, so we don't need to handle WAV's kitchen-sink of format
// tags.
//
// Reading ffmpeg-emitted files: ffmpeg sometimes inserts a LIST/INFO metadata
// chunk between the "fmt " and "data" chunks, so we walk the chunk header
// list rather than assuming a 44-byte header. The Node writer produces the
// canonical 44-byte layout; handling ffmpeg's metadata chunk keeps the test
// fixture loop working without a separate "clean WAV" step.

#pragma once

#include <cstdint>
#include <stdexcept>
#include <vector>

namespace openscreen::ct2 {

struct WavData {
  std::vector<float> samples; // mono, normalized to [-1, 1]
  int sample_rate = 0;
};

inline WavData read_pcm_wav(const void* data, size_t size) {
  if (size < 12) {
    throw std::runtime_error("WAV: input shorter than the RIFF + WAVE header");
  }
  const uint8_t* p = static_cast<const uint8_t*>(data);
  auto fourcc = [&](size_t off) -> uint32_t {
    if (off + 4 > size) return 0;
    return uint32_t{p[off]} | (uint32_t{p[off + 1]} << 8) |
           (uint32_t{p[off + 2]} << 16) | (uint32_t{p[off + 3]} << 24);
  };
  if (fourcc(0) != 0x46464952u /* "RIFF" */) {
    throw std::runtime_error("WAV: missing 'RIFF' magic");
  }
  if (fourcc(8) != 0x45564157u /* "WAVE" */) {
    throw std::runtime_error("WAV: missing 'WAVE' marker");
  }

  // Walk sub-chunks. Find "fmt " then "data".
  size_t cursor = 12;
  size_t fmt_off = size;
  size_t data_off = size;
  uint32_t data_size = 0;
  while (cursor + 8 <= size) {
    const uint32_t tag = fourcc(cursor);
    const uint32_t chunk_size =
        uint32_t{p[cursor + 4]} | (uint32_t{p[cursor + 5]} << 8) |
        (uint32_t{p[cursor + 6]} << 16) | (uint32_t{p[cursor + 7]} << 24);
    if (tag == 0x20746d66u /* "fmt " */) {
      fmt_off = cursor + 8;
    } else if (tag == 0x61746164u /* "data" */) {
      data_off = cursor + 8;
      data_size = chunk_size;
      break;
    }
    // Each RIFF chunk is word-aligned: 8-byte header + data, padded to even.
    const uint32_t advance = chunk_size + (chunk_size & 1u) + 8;
    if (cursor + advance > size) break;
    cursor += advance;
  }

  if (fmt_off == size || data_off == size) {
    throw std::runtime_error("WAV: missing 'fmt ' or 'data' chunk");
  }
  if (data_off + data_size > size) {
    throw std::runtime_error("WAV: payload truncated relative to data chunk");
  }
  if (data_size % 2 != 0) {
    throw std::runtime_error("WAV: 16-bit mono data must have an even byte length");
  }

  // Validate the "fmt " payload. The Node writer always emits fmt_size == 16,
  // format == 1 (PCM), channels == 1, sample_rate == 16000, bits_per_sample == 16.
  if (fmt_off + 16 > size) {
    throw std::runtime_error("WAV: 'fmt ' chunk shorter than 16 bytes");
  }
  const uint32_t fmt_size =
      uint32_t{p[fmt_off - 4]} | (uint32_t{p[fmt_off - 3]} << 8) |
      (uint32_t{p[fmt_off - 2]} << 16) | (uint32_t{p[fmt_off - 1]} << 24);
  if (fmt_size != 16) {
    throw std::runtime_error("WAV: extensible or non-PCM header not supported");
  }
  if (p[fmt_off + 0] != 1 || p[fmt_off + 1] != 0) {
    throw std::runtime_error("WAV: only uncompressed PCM is supported");
  }
  if (p[fmt_off + 2] != 1 || p[fmt_off + 3] != 0) {
    throw std::runtime_error("WAV: only mono files are supported");
  }
  const uint32_t sample_rate =
      uint32_t{p[fmt_off + 4]} | (uint32_t{p[fmt_off + 5]} << 8) |
      (uint32_t{p[fmt_off + 6]} << 16) | (uint32_t{p[fmt_off + 7]} << 24);
  if (sample_rate != 16000) {
    throw std::runtime_error("WAV: sample rate must be 16000 Hz");
  }
  if (p[fmt_off + 14] != 16 || p[fmt_off + 15] != 0) {
    throw std::runtime_error("WAV: only 16-bit samples are supported");
  }

  WavData out;
  out.sample_rate = static_cast<int>(sample_rate);
  out.samples.reserve(data_size / 2);
  for (uint32_t i = 0; i < data_size / 2; ++i) {
    int16_t s = int16_t{p[data_off + 2 * i]} |
                (int16_t{p[data_off + 2 * i + 1]} << 8);
    const float clamped = std::max(-1.0f, std::min(1.0f, s / 32768.0f));
    out.samples.push_back(clamped);
  }
  return out;
}

} // namespace openscreen::ct2
