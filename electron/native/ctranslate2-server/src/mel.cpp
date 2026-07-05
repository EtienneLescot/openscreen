#include "mel.h"

#include <algorithm>
#include <cmath>
#include <stdexcept>
#include <vector>

namespace openscreen::ct2 {

// Hankel-style Hann window of length n_fft+1 minus the last sample, per
// faster-whisper::feature_extractor.py:146 (`np.hanning(n_fft + 1)[:-1]`).
std::vector<float> hann_window(int n_fft) {
  // ponytail: brace-init here avoids the C++ "most vexing parse" —
  // `std::vector<float> w(size_t(n_fft));` would parse as a function
  // declaration named `w`. MSVC's /W4 is happy to take that route.
  std::vector<float> w{std::vector<float>(size_t(n_fft))};
  const int M = n_fft + 1;
  for (int i = 0; i < n_fft; ++i) {
    w[size_t(i)] = 0.5f * (1.0f - std::cos(2.0f * float(M_PI) * float(i) /
                                            float(M - 1)));
  }
  return w;
}

// ponytail: see `include/mel.h` for the full doc block; this is a literal
// port of faster-whisper's filterbank matrix construction.
MelFilterbank build_mel_filterbank(const FeatureConfig& cfg) {
  MelFilterbank fb;
  fb.n_mels = cfg.n_mels;
  fb.n_bins = cfg.n_fft / 2 + 1;
  fb.weights.assign(size_t(fb.n_mels) * size_t(fb.n_bins), 0.0f);

  std::vector<float> fftfreqs{std::vector<float>(size_t(fb.n_bins))};
  for (int i = 0; i < fb.n_bins; ++i) {
    fftfreqs[size_t(i)] =
        float(i) * float(cfg.sample_rate) / float(cfg.n_fft);
  }

  const float min_mel = 0.0f;
  const float max_mel = 45.245640471924965f;
  std::vector<float> mels{std::vector<float>(size_t(cfg.n_mels + 2))};
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    mels[size_t(i)] =
        min_mel + (max_mel - min_mel) * float(i) / float(cfg.n_mels + 1);
  }

  const float f_min = 0.0f;
  const float f_sp = 200.0f / 3.0f;
  std::vector<float> freqs{std::vector<float>(size_t(cfg.n_mels + 2))};
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    freqs[size_t(i)] = f_min + f_sp * mels[size_t(i)];
  }
  const float min_log_hz = 1000.0f;
  const float min_log_mel = (min_log_hz - f_min) / f_sp;
  const float logstep = std::log(6.4f) / 27.0f;
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    if (mels[size_t(i)] >= min_log_mel) {
      freqs[size_t(i)] =
          min_log_hz * std::exp(logstep * (mels[size_t(i)] - min_log_mel));
    }
  }

  std::vector<float> fdiff{std::vector<float>(size_t(cfg.n_mels + 1))};
  for (int i = 0; i < cfg.n_mels + 1; ++i) {
    fdiff[size_t(i)] = freqs[size_t(i + 1)] - freqs[size_t(i)];
  }

  for (int m = 0; m < cfg.n_mels; ++m) {
    const float enorm = 2.0f / (freqs[size_t(m + 2)] - freqs[size_t(m)]);
    for (int k = 0; k < fb.n_bins; ++k) {
      const float lower =
          (freqs[size_t(m)] - fftfreqs[size_t(k)]) / fdiff[size_t(m)];
      const float upper =
          (fftfreqs[size_t(k)] - freqs[size_t(m + 2)]) / fdiff[size_t(m + 1)];
      float w = std::max(0.0f, std::min(-lower, upper));
      w *= enorm;
      fb.weights[size_t(m) * size_t(fb.n_bins) + size_t(k)] = w;
    }
  }
  return fb;
}

std::vector<float> reflect_pad(const std::vector<float>& x, int pad) {
  if (pad <= 0) return x;
  std::vector<float> out;
  out.reserve(x.size() + size_t(2 * pad));
  for (int i = pad; i > 0; --i) {
    out.push_back(x[size_t(i)]);
  }
  out.insert(out.end(), x.begin(), x.end());
  for (size_t i = 1; i <= size_t(pad); ++i) {
    size_t idx = (i > x.size()) ? x.size() : (x.size() - i);
    out.push_back(x[idx]);
  }
  return out;
}

MelFeatures compute_log_mel(const std::vector<float>& mono_16k,
                            const FeatureConfig& cfg,
                            const MelFilterbank& fb,
                            const std::vector<float>& window) {
  // Fast path: the STFT machinery is identical to what faster-whisper does;
  // see include/mel.h for the rationale + the per-line Python trace.
  const int pad_each = cfg.n_fft / 2;
  std::vector<float> padded = reflect_pad(mono_16k, pad_each);
  padded.push_back(0.0f);
  const int n_padded = int(padded.size());
  const int nb_max_frames =
      cfg.chunk_length * cfg.sample_rate / cfg.hop_length;

  MelFeatures out;
  out.n_mels = cfg.n_mels;
  out.data.reserve(size_t(nb_max_frames) * size_t(cfg.n_mels));

  const int kept_bins = cfg.n_fft / 2;
  std::vector<float> magnitudes{std::vector<float>(size_t(kept_bins))};

  kiss_fft_cfg fft_cfg = kiss_fft_alloc(cfg.n_fft, 0, nullptr, nullptr);
  if (!fft_cfg) {
    throw std::runtime_error("kiss_fft_alloc failed");
  }

  std::vector<float> windowed_frame{std::vector<float>(size_t(cfg.n_fft))};
  std::vector<float> re_fft;
  std::vector<float> im_fft;
  std::vector<kiss_fft_cpx> buf{std::vector<kiss_fft_cpx>(size_t(cfg.n_fft))};
  std::vector<kiss_fft_cpx> out_fft{std::vector<kiss_fft_cpx>(size_t(cfg.n_fft))};

  for (int frame = 0;; ++frame) {
    const int offset = frame * cfg.hop_length;
    if (offset + cfg.n_fft > n_padded) break;

    for (int i = 0; i < cfg.n_fft; ++i) {
      windowed_frame[size_t(i)] =
          padded[size_t(offset + i)] * window[size_t(i)];
    }
    for (int i = 0; i < cfg.n_fft; ++i) {
      buf[size_t(i)].r = windowed_frame[size_t(i)];
      buf[size_t(i)].i = 0.0f;
    }
    kiss_fft(fft_cfg, buf.data(), out_fft.data());
    re_fft.resize(size_t(cfg.n_fft));
    im_fft.resize(size_t(cfg.n_fft));
    for (int i = 0; i < cfg.n_fft; ++i) {
      re_fft[size_t(i)] = out_fft[size_t(i)].r;
      im_fft[size_t(i)] = out_fft[size_t(i)].i;
    }

    for (int k = 0; k < kept_bins; ++k) {
      magnitudes[size_t(k)] = re_fft[size_t(k)] * re_fft[size_t(k)] +
                              im_fft[size_t(k)] * im_fft[size_t(k)];
    }

    std::vector<float> mel_out{std::vector<float>(size_t(cfg.n_mels), 0.0f)};
    for (int m = 0; m < cfg.n_mels; ++m) {
      float acc = 0.0f;
      const float* row =
          fb.weights.data() + size_t(m) * size_t(fb.n_bins);
      for (int k = 0; k < kept_bins; ++k) {
        acc += row[size_t(k)] * magnitudes[size_t(k)];
      }
      mel_out[size_t(m)] = acc;
    }

    float max_val = -1e30f;
    for (int m = 0; m < cfg.n_mels; ++m) {
      const float clipped = std::max(1e-10f, mel_out[size_t(m)]);
      const float log_val = std::log10(clipped);
      mel_out[size_t(m)] = log_val;
      if (log_val > max_val) max_val = log_val;
    }
    const float floor_at = max_val - 8.0f;
    for (int m = 0; m < cfg.n_mels; ++m) {
      const float x = std::max(mel_out[size_t(m)], floor_at);
      mel_out[size_t(m)] = (x + 4.0f) / 4.0f;
    }

    for (int m = 0; m < cfg.n_mels; ++m) {
      out.data.push_back(mel_out[size_t(m)]);
    }
    out.n_frames += 1;
    if (out.n_frames >= nb_max_frames) break;
  }

  kiss_fft_free(fft_cfg);
  return out;
}

} // namespace openscreen::ct2
