// wcpp_dtw_bench.cpp — whisper.cpp DTW word-timestamp benchmark.
//
// Usage:
//   wcpp_dtw_bench <model.bin> <audio-16k-mono.wav> [--lang en]
//
// Emits ONE JSON object on stdout matching OpenScreen's transcription contract
// shape so harness/{wer,analyze,extract_text}.mjs work unchanged:
//   { "text": "...",
//     "segments": [ { "id": <>, "start": S, "end": E, "text": "...",
//                     "words": [ {"word":"...","start":s,"end":e,"probability":p}, ... ] } ],
//     "detected_language": "en",
//     "backend": "whispercpp-<cpu|vulkan|cuda>",
//     "timing": { "elapsed_s": <>, "audio_s": <>, "rtf": <elapsed/audio> } }
//
// KEY DTW SETTINGS (the fix vs the 2024 failure):
//   dtw_token_timestamps = true
//   dtw_aheads_preset    = WHISPER_AHEADS_SMALL    (multilingual small)
//   token_timestamps     = true
// And we read whisper_token_data.t_dtw directly. Units are centiseconds
// (1 unit = 10 ms) → seconds = t_dtw / 100.0.
//
// The §4.1 guardrail runs first: if t_dtw == -1 for any non-special token,
// or the absolute-delta sum Σ|t_dtw − t0| over non-special tokens is zero
// (DTW identical to heuristic), or t_dtw is not monotonic non-decreasing,
// we exit non-zero before producing the JSON. The harness stays self-trustworthy.
//
// The backend name ("cpu"|"vulkan"|"cuda") is taken from the WCPP_BACKEND
// preprocessor define (set by the CMakeLists for each build variant).

#include "whisper.h"

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstring>
#include <chrono>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#ifndef WCPP_BACKEND
#define WCPP_BACKEND "cpu"
#endif

namespace {

std::string json_escape(const std::string& s) {
	std::string out;
	out.reserve(s.size() + 8);
	for (unsigned char c : s) {
		switch (c) {
			case '"':  out += "\\\""; break;
			case '\\': out += "\\\\"; break;
			case '\n': out += "\\n";  break;
			case '\r': out += "\\r";  break;
			case '\t': out += "\\t";  break;
			default:
				if (c < 0x20) {
					char buf[8];
					std::snprintf(buf, sizeof(buf), "\\u%04x", c);
					out += buf;
				} else {
					out += static_cast<char>(c);
				}
		}
	}
	return out;
}

// Minimal WAV reader: PCM16, any channel count, any sample rate we record.
// Fixtures are guaranteed PCM16 mono 16 kHz per the harness contract.
bool read_wav_pcm16(const std::string& path, std::vector<float>& pcm, int& sample_rate_out,
                    int& channels_out) {
	std::ifstream f(path, std::ios::binary);
	if (!f) { std::cerr << "cannot open " << path << "\n"; return false; }

	auto read_u32 = [&]()-> uint32_t {
		uint32_t v = 0; f.read(reinterpret_cast<char*>(&v), 4); return v;
	};
	auto read_u16 = [&]()-> uint16_t {
		uint16_t v = 0; f.read(reinterpret_cast<char*>(&v), 2); return v;
	};
	auto read_i16 = [&]()-> int16_t {
		int16_t v = 0; f.read(reinterpret_cast<char*>(&v), 2); return v;
	};

	char tag[4];
	f.read(tag, 4);
	if (f.gcount() != 4 || std::memcmp(tag, "RIFF", 4) != 0) { std::cerr << "not RIFF\n"; return false; }
	(void)read_u32();
	f.read(tag, 4);
	if (std::memcmp(tag, "WAVE", 4) != 0) { std::cerr << "not WAVE\n"; return false; }

	uint16_t fmt_format = 0, fmt_channels = 0, fmt_bits = 0;
	uint32_t fmt_sample_rate = 0;
	bool got_fmt = false;

	while (f) {
		char chunk_tag[4];
		f.read(chunk_tag, 4);
		if (f.gcount() != 4) break;
		const uint32_t chunk_size = read_u32();
		if (std::memcmp(chunk_tag, "fmt ", 4) == 0) {
			fmt_format      = read_u16();
			fmt_channels    = read_u16();
			fmt_sample_rate = read_u32();
			(void)read_u32();      // byte rate
			(void)read_u16();      // block align
			fmt_bits        = read_u16();
			const uint32_t fmt_extra = chunk_size - 16;
			if (fmt_extra) f.seekg(fmt_extra, std::ios::cur);
			got_fmt = true;
		} else if (std::memcmp(chunk_tag, "data", 4) == 0) {
			if (!got_fmt || fmt_format != 1 || fmt_bits != 16) {
				std::cerr << "expected PCM16, got format=" << fmt_format
				          << " bits=" << fmt_bits << "\n";
				return false;
			}
			sample_rate_out = static_cast<int>(fmt_sample_rate);
			channels_out    = fmt_channels;
			const size_t frames = chunk_size / 2 / fmt_channels;
			pcm.resize(frames);
			if (fmt_channels == 1) {
				for (size_t i = 0; i < frames; ++i) pcm[i] = static_cast<float>(read_i16()) / 32768.0f;
			} else {
				std::vector<int> count(frames, 0);
				for (size_t ch = 0; ch < fmt_channels; ++ch) {
					for (size_t i = 0; i < frames; ++i) {
						pcm[i] += static_cast<float>(read_i16()) / 32768.0f;
						++count[i];
					}
				}
				for (size_t i = 0; i < frames; ++i) pcm[i] /= count[i];
			}
			return true;
		} else {
			f.seekg(chunk_size + (chunk_size & 1), std::ios::cur);
		}
	}
	std::cerr << "data chunk not found\n";
	return false;
}

struct Word {
	double start;
	double end;
	double prob;
	std::string text;
};

} // namespace

int main(int argc, char** argv) {
	if (argc < 3) {
		std::cerr << "Usage: wcpp_dtw_bench <model.bin> <audio-16k-mono.wav> [--lang en]\n";
		return 2;
	}
	const std::string model_path = argv[1];
	const std::string wav_path   = argv[2];
	std::string lang = "en";
	for (int i = 3; i + 1 < argc; ++i) {
		if (std::string(argv[i]) == "--lang") lang = argv[i + 1];
	}

	std::vector<float> pcm;
	int sample_rate = 0;
	int channels    = 0;
	if (!read_wav_pcm16(wav_path, pcm, sample_rate, channels)) return 3;
	if (sample_rate != 16000 || channels != 1) {
		std::cerr << "fixture must be 16 kHz mono, got " << sample_rate << "Hz " << channels << "ch\n";
		return 3;
	}

	// ---------- §4.1: init context with DTW + alignment heads preset ----------
	whisper_context_params cparams = whisper_context_default_params();
	cparams.use_gpu    = true;   // GPU offload via whatever backend this build links against
	cparams.flash_attn = false;  // CRITICAL: DTW is incompatible with flash attention in v1.9.1 — the model logger literally disables dtw_token_timestamps itself if flash_attn=1, breaking the §4.1 guardrail.
	cparams.dtw_token_timestamps = true;
	cparams.dtw_aheads_preset    = WHISPER_AHEADS_SMALL;

	whisper_context* ctx = whisper_init_from_file_with_params(model_path.c_str(), cparams);
	if (!ctx) {
		std::cerr << "whisper_init_from_file_with_params failed for " << model_path << "\n";
		return 4;
	}

	whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
	wparams.token_timestamps = true;
	wparams.language         = lang.c_str();
	wparams.print_progress   = false;
	wparams.print_realtime   = false;
	wparams.print_timestamps = false;
	wparams.n_threads        = static_cast<int>(std::thread::hardware_concurrency());

	const auto t0 = std::chrono::steady_clock::now();
	const int rc  = whisper_full(ctx, wparams, pcm.data(), static_cast<int>(pcm.size()));
	const auto t1 = std::chrono::steady_clock::now();
	if (rc != 0) {
		std::cerr << "whisper_full returned " << rc << "\n";
		whisper_free(ctx);
		return 5;
	}
	const double elapsed_s = std::chrono::duration<double>(t1 - t0).count();
	const double audio_s   = pcm.size() / 16000.0;
	const double rtf       = audio_s > 0 ? elapsed_s / audio_s : 0.0;

	const int n_vocab = whisper_n_vocab(ctx);
	const whisper_token eot = whisper_token_eot(ctx);
	std::vector<std::string> vocab_strs(n_vocab);
	for (int i = 0; i < n_vocab; ++i) vocab_strs[i] = whisper_token_to_str(ctx, i);

	// ---------- Single walk: build segments + word groups + §4.1 guardrail ----------
	bool   dtw_guard_pass      = true;
	std::string guardrail_msg;
	int64_t dtw_abs_delta_sum  = 0;
	int64_t prev_t_dtw         = 0;
	int    non_special_tokens  = 0;

	struct Segment {
		double start, end;
		std::string text;
		std::vector<Word> words;
	};
	std::vector<Segment> segments;

	const int n_segments = whisper_full_n_segments(ctx);
	for (int si = 0; si < n_segments; ++si) {
		Segment seg;
		seg.start = whisper_full_get_segment_t0(ctx, si) / 100.0;
		seg.end   = whisper_full_get_segment_t1(ctx, si) / 100.0;
		// Use whisper.cpp's segment text — that string already strips
		// _BEG_ / [_TT_NNN] markers (whisper_full handles them).
		const char* seg_text_c = whisper_full_get_segment_text(ctx, si);
		if (seg_text_c) seg.text = seg_text_c;

		// First pass: collect (t_dtw of first token, raw text, prob mean) per
		// word group, walking the token stream.
		struct W { double t_dtw_first; double p_sum; int p_n; std::string text; bool real; };
		std::vector<W> word_buf;
		std::string cur_text;
		bool in_word = false;
		double w_first_t_dtw = 0;
		double w_p_sum = 0; int w_p_n = 0;

		const int n_tokens = whisper_full_n_tokens(ctx, si);
		for (int ti = 0; ti < n_tokens; ++ti) {
			const whisper_token_data td = whisper_full_get_token_data(ctx, si, ti);
			std::string raw = (td.id >= 0 && td.id < n_vocab) ? vocab_strs[td.id] : std::string();

			if (td.id >= eot) continue; // special token: skip text AND words

			// §4.1 guardrail — track t_dtw vs t0 + monotonicity.
			if (td.t_dtw == -1) {
				dtw_guard_pass = false;
				if (guardrail_msg.empty()) guardrail_msg = "token t_dtw == -1 (DTW not computed)";
			}
			const int64_t delta = std::abs(td.t_dtw - td.t0);
			dtw_abs_delta_sum += delta;
			if (non_special_tokens > 0 && td.t_dtw < prev_t_dtw) {
				dtw_guard_pass = false;
				if (guardrail_msg.empty()) guardrail_msg = "non-monotonic t_dtw";
			}
			prev_t_dtw = td.t_dtw;
			++non_special_tokens;

			const bool starts_word = (!in_word) || (!raw.empty() && raw[0] == ' ');
			const double td_dtw = (td.t_dtw >= 0 ? td.t_dtw : 0) / 100.0;

			if (starts_word && in_word) {
				word_buf.push_back({ w_first_t_dtw, w_p_sum, w_p_n, cur_text, true });
				w_p_sum = 0; w_p_n = 0; cur_text.clear();
			}
			if (starts_word) {
				in_word = true;
				w_first_t_dtw = td_dtw;
				cur_text = (!raw.empty() && raw[0] == ' ') ? raw.substr(1) : raw;
			} else {
				cur_text += raw;
			}
			w_p_sum += td.p;
			w_p_n   += 1;
		}
		if (in_word) {
			word_buf.push_back({ w_first_t_dtw, w_p_sum, w_p_n, cur_text, true });
		}

		// Second pass: assign per-word start/end.
		//   word.start = its own t_dtw (the moment the model started emitting it)
		//   word.end   = the next word's t_dtw (the moment this word finished)
		//                or, for the last word in the segment, the segment's t1
		// — so single-token words get a real audio range, not a zero-width point.
		for (size_t wi = 0; wi < word_buf.size(); ++wi) {
			Word w;
			w.start = word_buf[wi].t_dtw_first;
			w.end   = (wi + 1 < word_buf.size())
			            ? word_buf[wi + 1].t_dtw_first
			            : seg.end;
			w.prob  = word_buf[wi].p_sum / std::max(1, word_buf[wi].p_n);
			w.text  = word_buf[wi].text;
			seg.words.push_back(w);
		}

		segments.push_back(std::move(seg));
	}

	// §4.1 final check: zero abs-delta sum means DTW identical to heuristic.
	if (non_special_tokens > 0 && dtw_abs_delta_sum == 0) {
		dtw_guard_pass = false;
		if (guardrail_msg.empty()) guardrail_msg = "Σ|t_dtw − t0| == 0 (DTW identical to heuristic)";
	}

	std::fprintf(stderr,
		"wcpp_dtw_bench[§4.1 guardrail]: %s (non_special_tokens=%d, Σ|t_dtw-t0|=%lld) => %s\n",
		dtw_guard_pass ? "PASS" : "FAIL",
		non_special_tokens,
		static_cast<long long>(dtw_abs_delta_sum),
		guardrail_msg.empty() ? "ok" : guardrail_msg.c_str());
	if (!dtw_guard_pass) {
		whisper_free(ctx);
		return 6;
	}

	// ---------- Emit JSON ----------
	std::string whole_text;
	for (const auto& s : segments) whole_text += s.text;

	std::cout.setf(std::ios::fixed);
	std::cout.precision(6);
	std::cout << "{\n";
	std::cout << "  \"backend\": \"" << WCPP_BACKEND << "\",\n";
	std::cout << "  \"detected_language\": \"" << json_escape(lang) << "\",\n";
	std::cout << "  \"language\": \"" << json_escape(lang) << "\",\n";
	std::cout << "  \"timing\": { \"elapsed_s\": " << elapsed_s
	          << ", \"audio_s\": " << audio_s
	          << ", \"rtf\": " << rtf << " },\n";
	std::cout << "  \"text\": \"" << json_escape(whole_text) << "\",\n";
	std::cout << "  \"segments\": [";
	for (size_t si = 0; si < segments.size(); ++si) {
		const auto& s = segments[si];
		std::cout << (si ? ",\n    {" : "\n    {");
		std::cout << "\"id\":" << si
		          << ",\"start\":" << s.start
		          << ",\"end\":"   << s.end
		          << ",\"text\":\"" << json_escape(s.text) << "\",\"words\":[";
		for (size_t wi = 0; wi < s.words.size(); ++wi) {
			const auto& w = s.words[wi];
			std::cout << (wi ? "," : "");
			std::cout << "{\"word\":\"" << json_escape(w.text)
			          << "\",\"start\":" << w.start
			          << ",\"end\":"     << w.end
			          << ",\"probability\":" << w.prob << "}";
		}
		std::cout << "]}";
	}
	std::cout << "\n  ]\n}\n";

	whisper_free(ctx);
	return 0;
}
