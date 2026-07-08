// whisper-stt-server: long-lived HTTP helper for OpenScreen's STT pipeline.
//
// Wires the POC's transcription core (tools/stt-eval/whispercpp-dtw-poc/harness/wcpp_dtw_bench.cpp)
// into an httplib-shaped loop, so the Electron main process can keep the same
// spawn → poll / → POST /inference → verbose_json shape that the previous
// native STT helper provided. whisper.cpp's `whisper_full`
// already does mel featurization, tokenization, decoding, AND long-form (>30 s)
// chunking internally — the helper is ~400 lines because none of that is our
// problem any more.
//
// Wire contract (Node side: electron/stt/whisperServer.ts):
//   POST /inference    multipart/form-data, fields:
//                       - file           (WAV: 16 kHz mono PCM16)
//                       - language       ("en" | "fr" | ... | "auto")
//                       - response_format ("verbose_json" — accepted for compat
//                                          with the previous CT2 client)
//   GET  /             200 "ok" once the model is loaded — readiness probe.
//
// Response shape (verbose_json, preserved from the previous helper contract):
//   {
//     "language":          "en",
//     "detected_language": "en",
//     "backend":           "whispercpp-vulkan" | "whispercpp-cpu" | ...,
//     "timing":            { "elapsed_s": <>, "audio_s": <>, "rtf": <> },
//     "segments": [
//       { "id": 0, "text": "...",
//         "start": 0.0, "end": 11.0,
//         "words": [ { "word": "...", "start": 0.5, "end": 0.9, "probability": 0.9 }, ... ]
//       }, ...
//     ]
//   }
//
// Concurrency: whisper contexts are not thread-safe. /inference is serialized
// behind a single mutex (the Node side already has a single-flight queue, so
// this is a belt-and-braces guarantee against a future bug or parallel invoker).

#include "whisper.h"

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <tuple>
#include <vector>

#include <httplib.h>
#include <nlohmann/json.hpp>
#include <ggml.h>

namespace {

void log(const std::string& msg) {
	std::cerr << "[whisper-stt] " << msg << std::endl;
	std::cerr.flush();
}

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

// Minimal WAV reader: PCM16, any channel count, any sample rate. Fixtures
// (and the renderer's writeSamplesAsWav) are guaranteed PCM16 mono 16 kHz.
// ponytail: v1.9.1 of whisper.cpp dropped `examples/dr_wav.h` in favour of
// miniaudio, but pulling in the full miniaudio.h (4 MB header) just to read
// a 16 kHz mono PCM16 stream would be silly. The format is dead simple; this
// parser is the same one the POC harness shipped.
bool read_wav_pcm16(const std::string& path, std::vector<float>& pcm,
                    int& sample_rate_out, int& channels_out) {
	std::ifstream f(path, std::ios::binary);
	if (!f) { log("cannot open " + path); return false; }

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
	if (f.gcount() != 4 || std::memcmp(tag, "RIFF", 4) != 0) { log("not RIFF"); return false; }
	(void)read_u32();
	f.read(tag, 4);
	if (std::memcmp(tag, "WAVE", 4) != 0) { log("not WAVE"); return false; }

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
			(void)read_u32();
			(void)read_u16();
			fmt_bits        = read_u16();
			const uint32_t fmt_extra = chunk_size - 16;
			if (fmt_extra) f.seekg(fmt_extra, std::ios::cur);
			got_fmt = true;
		} else if (std::memcmp(chunk_tag, "data", 4) == 0) {
			if (!got_fmt || fmt_format != 1 || fmt_bits != 16) {
				log("expected PCM16, got format=" + std::to_string(fmt_format) +
				    " bits=" + std::to_string(fmt_bits));
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
	log("data chunk not found in " + path);
	return false;
}

// Write the runtime-detected ggml device name to a stable string the JSON
// response can use. Order: enumerate registered devices and pick the first
// non-CPU one if any exists (CPU is always last in ggml's priority order).
// Falls back to "cpu" when nothing else is registered, which is also what
// ggml does on its own.
std::string detect_active_backend() {
	const size_t n = ggml_backend_dev_count();
	for (size_t i = 0; i < n; ++i) {
		ggml_backend_dev_t dev = ggml_backend_dev_get(i);
		if (!dev) continue;
		const char* name = ggml_backend_dev_name(dev);
		if (!name) continue;
		std::string s = name;
		// ggml-cpu shows up as "CPU" — skip it on the first pass, only return
		// it as a last resort.
		if (s == "CPU" || s == "cpu") continue;
		if (s.find("Vulkan")  != std::string::npos) return "whispercpp-vulkan";
		if (s.find("CUDA")    != std::string::npos) return "whispercpp-cuda";
		if (s.find("Metal")   != std::string::npos) return "whispercpp-metal";
	}
	// Last resort: the CPU device, or a hard "cpu" if ggml has nothing
	// registered (shouldn't happen — whisper.cpp's loader registers at
	// least ggml-cpu on every platform).
	if (n > 0 && ggml_backend_dev_get(0)) {
		const char* name = ggml_backend_dev_name(ggml_backend_dev_get(0));
		if (name && *name) return "whispercpp-cpu";
	}
	return "whispercpp-cpu";
}

struct Word {
	double start = 0.0;
	double end   = 0.0;
	double prob  = 0.0;
	std::string text;
};

} // namespace

int main(int argc, char** argv) {
	std::string model_path;
	std::string host = "127.0.0.1";
	int port = 0;
	int threads = std::max(1u, std::thread::hardware_concurrency());

	for (int i = 1; i < argc; ++i) {
		const std::string a = argv[i];
		if (a == "--model"   && i + 1 < argc) model_path = argv[++i];
		else if (a == "--host" && i + 1 < argc) host = argv[++i];
		else if (a == "--port" && i + 1 < argc) port = std::atoi(argv[++i]);
		else if (a == "--threads" && i + 1 < argc) threads = std::atoi(argv[++i]);
	}
	// ponytail: prefer env var (matches the prior native STT model env var
	// shape; the Node wrapper passes both ways).
	if (model_path.empty()) {
		if (const char* p = std::getenv("OPENSCREEN_WHISPER_MODEL")) model_path = p;
	}
	if (port == 0) {
		if (const char* p = std::getenv("OPENSCREEN_WHISPER_PORT")) port = std::atoi(p);
	}
	if (const char* p = std::getenv("OPENSCREEN_WHISPER_THREADS")) threads = std::atoi(p);
	if (const char* p = std::getenv("OPENSCREEN_WHISPER_HOST")) host = p;

	if (model_path.empty()) {
		std::cerr << "FATAL: --model <path-to-ggml.bin> or "
		             "OPENSCREEN_WHISPER_MODEL is required" << std::endl;
		return 2;
	}
	log("boot: model=" + model_path + " host=" + host +
	    " port=" + (port > 0 ? std::to_string(port) : "(any)") +
	    " threads=" + std::to_string(threads));

	// ---- Init whisper context with DTW alignment (POC §4.1) ----
	whisper_context_params cparams = whisper_context_default_params();
	cparams.use_gpu    = true;   // GPU offload via whatever backend was linked
	cparams.flash_attn = false;  // CRITICAL: DTW is silently disabled by v1.9.1
	                             // if flash_attn is true; the guardrail in the
	                             // /inference handler still runs, but skipping
	                             // the request is wasted work.
	cparams.dtw_token_timestamps = true;
	cparams.dtw_aheads_preset    = WHISPER_AHEADS_SMALL;
	whisper_context* ctx = whisper_init_from_file_with_params(model_path.c_str(), cparams);
	if (!ctx) {
		log("whisper_init_from_file_with_params failed for " + model_path);
		return 3;
	}
	const std::string active_backend = detect_active_backend();
	log("model loaded: multilingual small; backend=" + active_backend);

	// ---- HTTP server ----
	httplib::Server svr;
	std::mutex infer_mu;  // whisper contexts are not thread-safe

	// GET / — readiness probe. The Node wrapper polls this until 200 to know
	// the model is loaded and the GPU is bound (a Vulkan/D3D driver bug can
	// make whisper_init succeed but the first /inference still segfault).
	svr.Get("/", [](const httplib::Request&, httplib::Response& res) {
		res.set_content("ok", "text/plain");
	});

	// POST /inference — multipart form with `file` (WAV) + `language` + `response_format`.
	svr.Post("/inference", [&](const httplib::Request& req, httplib::Response& res) {
		auto it = req.files.find("file");
		if (it == req.files.end()) {
			res.status = 400;
			res.set_content(R"({"error":"missing 'file' form field"})", "application/json");
			return;
		}
		const auto& file_entry = it->second;

		// Write the upload to a temp file because read_wav_pcm16 takes a path.
		// whisper.cpp needs float PCM in memory; parsing the multipart bytes
		// directly would just duplicate the WAV reader. tmpfile() is fine —
		// /inference is single-flight, so concurrent temp files aren't a risk.
		// Portable unique-ish name: no PID API (GetCurrentProcessId is
		// Windows-only) — a monotonic counter plus a high-res clock reading
		// is enough to avoid collisions on one host.
		static std::atomic<uint64_t> tmp_wav_counter{0};
		const auto tmp_wav_id = tmp_wav_counter.fetch_add(1, std::memory_order_relaxed);
		const auto tmp_wav_ts = std::chrono::high_resolution_clock::now().time_since_epoch().count();
		const std::string tmp_wav = (std::filesystem::temp_directory_path() /
		                             ("openscreen-stt-" + std::to_string(tmp_wav_ts) +
		                              "-" + std::to_string(tmp_wav_id) + ".wav")).string();
		{
			std::ofstream out(tmp_wav, std::ios::binary);
			out.write(file_entry.content.data(),
			          static_cast<std::streamsize>(file_entry.content.size()));
		}
		std::vector<float> pcm;
		int sample_rate = 0, channels = 0;
		const bool ok = read_wav_pcm16(tmp_wav, pcm, sample_rate, channels);
		std::error_code ec;
		std::filesystem::remove(tmp_wav, ec);
		if (!ok) {
			res.status = 400;
			res.set_content(R"({"error":"failed to parse WAV"})", "application/json");
			return;
		}
		if (sample_rate != 16000 || channels != 1) {
			res.status = 400;
			res.set_content(
				R"({"error":"expected 16 kHz mono PCM16 WAV"})",
				"application/json");
			return;
		}

		// language param
		std::string language = "auto";
		if (auto p = req.get_file_value("language"); !p.content.empty()) language = p.content;
		else if (auto kv = req.params.find("language"); kv != req.params.end()) language = kv->second;
		// "auto" → empty string tells whisper.cpp to detect; matches the
		// Node contract (electron/stt/whisperServer.ts) and OpenAI convention.

		const std::lock_guard<std::mutex> lk(infer_mu);

		whisper_full_params wparams = whisper_full_default_params(WHISPER_SAMPLING_GREEDY);
		wparams.token_timestamps = true;
		wparams.language         = language.empty() ? "auto" : language.c_str();
		wparams.print_progress   = false;
		wparams.print_realtime   = false;
		wparams.print_timestamps = false;
		wparams.n_threads        = threads;

		const auto t0 = std::chrono::steady_clock::now();
		const int rc  = whisper_full(ctx, wparams, pcm.data(), static_cast<int>(pcm.size()));
		const auto t1 = std::chrono::steady_clock::now();
		if (rc != 0) {
			log("whisper_full returned " + std::to_string(rc));
			res.status = 500;
			res.set_content(
				std::string(R"({"error":"whisper_full failed: rc=)") + std::to_string(rc) + R"("})",
				"application/json");
			return;
		}
		const double elapsed_s = std::chrono::duration<double>(t1 - t0).count();
		const double audio_s   = pcm.size() / 16000.0;
		const double rtf       = audio_s > 0 ? elapsed_s / audio_s : 0.0;

		const int n_vocab = whisper_n_vocab(ctx);
		const whisper_token eot = whisper_token_eot(ctx);
		std::vector<std::string> vocab_strs(n_vocab);
		for (int i = 0; i < n_vocab; ++i) vocab_strs[i] = whisper_token_to_str(ctx, i);

		// ---- §4.1 guardrail (POC-validated): DTW must be active ----
		// Mirrors the POC's harness check; if any non-special token has
		// t_dtw == -1, or the abs-delta sum is zero (= DTW identical to the
		// heuristic, the 2024 failure mode), reject with 500.
		bool   dtw_guard_pass      = true;
		std::string guardrail_msg;
		int64_t dtw_abs_delta_sum  = 0;
		int64_t prev_t_dtw         = 0;
		int    non_special_tokens  = 0;

		// ---- Walk segments → tokens → words (POC §1.4 mapping) ----
		struct Segment {
			double start = 0.0, end = 0.0;
			std::string text;
			std::vector<Word> words;
		};
		std::vector<Segment> segments;

		const int n_segments = whisper_full_n_segments(ctx);
		for (int si = 0; si < n_segments; ++si) {
			Segment seg;
			seg.start = whisper_full_get_segment_t0(ctx, si) / 100.0;
			seg.end   = whisper_full_get_segment_t1(ctx, si) / 100.0;
			if (const char* t = whisper_full_get_segment_text(ctx, si)) seg.text = t;

			struct W { double t_dtw_first; double p_sum; int p_n; std::string text; };
			std::vector<W> word_buf;
			std::string cur_text;
			bool in_word = false;
			double w_first_t_dtw = 0;
			double w_p_sum = 0; int w_p_n = 0;

			const int n_tokens = whisper_full_n_tokens(ctx, si);
			for (int ti = 0; ti < n_tokens; ++ti) {
				const whisper_token_data td = whisper_full_get_token_data(ctx, si, ti);
				std::string raw = (td.id >= 0 && td.id < n_vocab) ? vocab_strs[td.id] : std::string();

				if (td.id >= eot) continue;  // special token: skip text and words

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
					word_buf.push_back({ w_first_t_dtw, w_p_sum, w_p_n, cur_text });
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
				word_buf.push_back({ w_first_t_dtw, w_p_sum, w_p_n, cur_text });
			}
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

		// Final §4.1 check: zero abs-delta sum → DTW identical to heuristic.
		if (non_special_tokens > 0 && dtw_abs_delta_sum == 0) {
			dtw_guard_pass = false;
			if (guardrail_msg.empty()) guardrail_msg = "Σ|t_dtw − t0| == 0 (DTW identical to heuristic)";
		}
		log("§4.1 guardrail: " + std::string(dtw_guard_pass ? "PASS" : "FAIL") +
		    " (non_special_tokens=" + std::to_string(non_special_tokens) +
		    ", Σ|t_dtw-t0|=" + std::to_string(dtw_abs_delta_sum) +
		    (guardrail_msg.empty() ? ")" : (", " + guardrail_msg + ")")));
		if (!dtw_guard_pass) {
			res.status = 500;
			res.set_content(
				std::string(R"({"error":"DTW guardrail failed: )") + json_escape(guardrail_msg) + R"("})",
				"application/json");
			return;
		}

		// ---- Emit verbose_json (CT2-compatible shape + backend + timing) ----
		nlohmann::json reply;
		reply["language"]          = language;
		reply["detected_language"] = language;
		reply["backend"]           = active_backend;
		reply["timing"] = {
			{"elapsed_s", elapsed_s},
			{"audio_s",   audio_s},
			{"rtf",       rtf},
		};
		nlohmann::json segs = nlohmann::json::array();
		for (size_t i = 0; i < segments.size(); ++i) {
			const auto& s = segments[i];
			nlohmann::json seg;
			seg["id"]    = static_cast<int>(i);
			seg["text"]  = s.text;
			seg["start"] = s.start;
			seg["end"]   = s.end;
			nlohmann::json words = nlohmann::json::array();
			for (const auto& w : s.words) {
				words.push_back({
					{"word",        w.text},
					{"start",       w.start},
					{"end",         w.end},
					{"probability", w.prob},
				});
			}
			seg["words"] = std::move(words);
			segs.push_back(std::move(seg));
		}
		reply["segments"] = std::move(segs);
		res.set_content(reply.dump(), "application/json");
	});

	// ---- bind + listen ----
	int bound_port = port;
	if (bound_port == 0) {
		bound_port = svr.bind_to_any_port(host);
	} else if (!svr.bind_to_port(host, bound_port)) {
		std::cerr << "FATAL: bind_to_port(" << host << ":" << bound_port << ") failed" << std::endl;
		whisper_free(ctx);
		return 4;
	}
	log("listening on " + host + ":" + std::to_string(bound_port));
	const int rc = svr.listen_after_bind() ? 0 : 5;
	if (rc != 0) {
		std::cerr << "FATAL: listen_after_bind failed" << std::endl;
	}
	whisper_free(ctx);
	return rc;
}
