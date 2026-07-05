// ctranslate2-server: real implementation with word-level timestamps via
// CTranslate2's WhisperReplica::align() (DTW over cross-attention weights).
//
// The HTTP contract is documented at the top of
// `electron/native/ctranslate2-server/README.md` and on the Node side in
// `electron/stt/ctranslate2Server.ts::runMultipartInfer`. The Node wrapper
// expects a verbose_json response with segments[].words[] for word-level
// timestamps, matching the SttWordSegment shape the renderer expects.

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include <ctranslate2/models/whisper.h>
#include <ctranslate2/storage_view.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "mel.h"
#include "tokenizer.h"
#include "wav.h"

using json = nlohmann::json;

namespace {

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
constexpr int EOT_ID = 50257;           // Whisper <|endoftext|>
constexpr int VOCAB_TEXT_MAX = 50256;   // Last "real" text token ID (inclusive)
constexpr int MEDIAN_FILTER_WIDTH = 7;  // DTW median filter (faster-whisper default)
constexpr float TIME_PRECISION = 0.02f; // Seconds per reduced mel frame

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
struct ServerConfig {
  std::string model_dir;
  std::string host = "127.0.0.1";
  int port = 0;
  int threads = std::max(1u, std::thread::hardware_concurrency());
  bool use_cuda = false;
  // ponytail: prefer INT8 when the on-disk model is the SYSTRAN int8
  // quantized release (see electron/stt/modelManager.ts). Falls back to
  // FLOAT32 for the fp16/fp32 models — INT8 weights give ~5–10× RTF over
  // Ruy/fp32 with oneDNN or OpenBLAS, while FLOAT32 would still work on
  // pure SGEMM backends. Triggered via `--int8` flag from the Node
  // wrapper (electron/stt/ctranslate2Server.ts) which sets it on for the
  // bundled SYSTRAN/faster-whisper-{small,medium,…}.int8 family.
  bool use_int8 = false;
  int sample_rate = 16000;
  int n_fft = 400;
  int hop_length = 160;
  int n_mels = 80;
  int chunk_length = 30;

  static ServerConfig from_env(int arg_port) {
    ServerConfig c;
    if (const char *p = std::getenv("OPENSCREEN_CT2_MODEL_DIR")) c.model_dir = p;
    if (const char *p = std::getenv("OPENSCREEN_CT2_HOST")) c.host = p;
    if (const char *p = std::getenv("OPENSCREEN_CT2_PORT")) c.port = std::atoi(p);
    if (const char *p = std::getenv("OPENSCREEN_CT2_THREADS")) c.threads = std::atoi(p);
    if (const char *p = std::getenv("OPENSCREEN_CT2_CUDA")) c.use_cuda = std::atoi(p) != 0;
    if (const char *p = std::getenv("OPENSCREEN_CT2_INT8")) c.use_int8 = std::atoi(p) != 0;
    if (arg_port > 0) c.port = arg_port;
    return c;
  }
};

void log(const std::string& msg) {
  std::cerr << "[ct2-server] " << msg << std::endl;
  std::cerr.flush();
}

// ---------------------------------------------------------------------------
// Tokenizer loading
// ---------------------------------------------------------------------------
openscreen::ct2::WhisperTokenizer load_tokenizer(const std::string& model_dir) {
  std::string tokenizer_path = model_dir + "/tokenizer.json";
  std::ifstream in(tokenizer_path);
  if (!in) {
    throw std::runtime_error("cannot open tokenizer.json at " + tokenizer_path);
  }
  json tok;
  in >> tok;

  std::unordered_map<std::string, int> vocab;
  std::unordered_map<int, std::string> added;

  for (const auto& entry : tok["added_tokens"]) {
    int id = entry["id"].get<int>();
    std::string content = entry["content"].get<std::string>();
    added.emplace(id, content);
  }
  for (auto it = tok["model"]["vocab"].begin(); it != tok["model"]["vocab"].end();
       ++it) {
    const std::string& piece = it.key();
    int id = it.value().get<int>();
    vocab.emplace(piece, id);
  }
  return openscreen::ct2::WhisperTokenizer(std::move(vocab), std::move(added));
}

// ---------------------------------------------------------------------------
// Language detection
// ---------------------------------------------------------------------------
struct LanguageDetection {
  std::string language;
  float probability = 0;
};

LanguageDetection detect_language(
    ctranslate2::models::Whisper& model,
    const openscreen::ct2::WhisperTokenizer& tok,
    const ctranslate2::StorageView& features) {
  LanguageDetection out;
  auto futures = model.detect_language(features);
  if (futures.empty()) return out;
  auto top = futures[0].get();
  if (top.empty()) return out;
  const std::string& lang_token = top[0].first;
  out.probability = top[0].second;
  if (lang_token.size() >= 6 && lang_token.compare(0, 2, "<|") == 0 &&
      lang_token.back() == '>') {
    out.language = lang_token;
  } else {
    out.language = "<|" + lang_token + "|>";
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------
std::vector<int> build_prompt(
    const openscreen::ct2::WhisperTokenizer& tok,
    const std::string& language) {
  std::vector<int> p;
  p.push_back(tok.sot_id());
  std::string lang_token = language;
  if (lang_token.size() < 6 || lang_token.compare(0, 2, "<|") != 0 ||
      lang_token.back() != '>') {
    lang_token = "<|" + language + "|>";
  }
  p.push_back(tok.id_for(lang_token));
  p.push_back(tok.id_for("<|transcribe|>"));
  // NOTE: we do NOT push <|notimestamps|> here because we want the model to
  // emit timestamp tokens in its output so split_segments can separate phrases.
  // The align() function internally appends <|notimestamps|> + <|eot|> to the
  // start_sequence when constructing its decoder input, so alignment still
  // works correctly.
  return p;
}

// ---------------------------------------------------------------------------
// Token decoding
// ---------------------------------------------------------------------------
std::string decode_tokens(
    const std::vector<int>& ids,
    const openscreen::ct2::WhisperTokenizer& tok) {
  std::string out;
  for (int id : ids) {
    if (id == EOT_ID) break;
    if (id > VOCAB_TEXT_MAX) continue;
    std::string piece;
    if (!tok.try_render(id, &piece)) continue;
    out += piece;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Segment splitting
// ---------------------------------------------------------------------------
struct DecodedSegment {
  float start = 0;
  float end = 0;
  std::string text;
  std::vector<int> token_ids;
};

inline bool is_timestamp_token(int id, int ts_begin) {
  return id >= ts_begin;
}

std::vector<DecodedSegment> split_segments(
    const std::vector<int>& ids,
    int timestamp_begin,
    float time_precision) {
  std::vector<DecodedSegment> segs;
  std::optional<DecodedSegment> cur;
  float prev_ts = 0.0f;
  for (int id : ids) {
    if (is_timestamp_token(id, timestamp_begin)) {
      const float t = (id - timestamp_begin) * time_precision;
      if (cur) {
        cur->end = t;
        prev_ts = t;
        segs.push_back(std::move(*cur));
        cur.reset();
      } else {
        prev_ts = t;
      }
      continue;
    }
    if (!cur) {
      cur = DecodedSegment{};
      cur->start = prev_ts;
    }
    cur->token_ids.push_back(id);
  }
  if (cur) {
    cur->end = prev_ts + 0.05f;
    segs.push_back(std::move(*cur));
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Word-level timestamp construction from alignment results
// ---------------------------------------------------------------------------

// A single word with timing derived from CTranslate2's DTW alignment.
struct AlignedWord {
  std::string word;
  float start_sec = 0;
  float end_sec = 0;
  float probability = 0;
};

// Build word-level timestamps from a WhisperAlignmentResult for one segment.
// The alignment result gives a DTW path mapping each BPE text-token position
// to a reduced mel-frame index. We group consecutive BPE tokens into words
// (a rendered token starting with ' ' marks a word boundary), then convert
// the token-level frames to word-level start/end seconds.
std::vector<AlignedWord> build_word_timestamps(
    const std::vector<size_t>& text_token_ids,
    const openscreen::ct2::WhisperTokenizer& tok,
    const ctranslate2::models::WhisperAlignmentResult& align_result,
    float time_precision,
    float segment_start_offset) {

  if (text_token_ids.empty() || align_result.alignments.empty())
    return {};

  // Step 1: render each token and detect word boundaries.
  // A token whose rendered text starts with ' ' marks the start of a new word
  // (except for the very first token, which has no leading space).
  struct TokenInfo {
    std::string text;
    int token_id;
  };
  std::vector<TokenInfo> tokens;
  tokens.reserve(text_token_ids.size());

  for (size_t id : text_token_ids) {
      std::string rendered;
      if (!tok.try_render(static_cast<int>(id), &rendered)) rendered = "";
    tokens.push_back({std::move(rendered), static_cast<int>(id)});
  }

  // Step 2: map each text-token position to a DTW frame index.
  // The alignment result contains pairs of (token_index_in_position, reduced_frame).
  // We need, for each text token position, the FIRST frame it maps to (start_frame)
  // and the LAST frame (end_frame). The DTW path may have multiple steps that
  // stay on the same token while advancing frames.
  std::vector<size_t> token_start_frame(text_token_ids.size(), 0);
  std::vector<size_t> token_end_frame(text_token_ids.size(), 0);
  std::vector<bool> token_seen(text_token_ids.size(), false);

  for (const auto& pair : align_result.alignments) {
    size_t token_pos = static_cast<size_t>(pair.first);
    size_t frame = static_cast<size_t>(pair.second);
    if (token_pos < text_token_ids.size()) {
      if (!token_seen[token_pos]) {
        token_start_frame[token_pos] = frame;
        token_seen[token_pos] = true;
      }
      token_end_frame[token_pos] = frame;
    }
  }

  // Step 3: group tokens into words.
  struct WordBuilder {
    std::string text;
    int first_token_idx = -1;
    int last_token_idx = -1;
    size_t first_frame = 0;
    size_t last_frame = 0;
    float prob_sum = 0;
    int prob_count = 0;
  };

  std::vector<WordBuilder> words;
  WordBuilder current;
  bool first_token = true;

  for (size_t i = 0; i < tokens.size(); ++i) {
    bool is_word_start = false;
    if (first_token) {
      is_word_start = true;
      first_token = false;
    } else if (!tokens[i].text.empty() && tokens[i].text[0] == ' ') {
      is_word_start = true;
    }

    if (is_word_start && current.first_token_idx >= 0) {
      // Flush current word
      current.last_token_idx = static_cast<int>(i) - 1;
      current.last_frame = token_end_frame[current.last_token_idx];
      words.push_back(std::move(current));
      current = WordBuilder{};
      current.first_token_idx = static_cast<int>(i);
    }

    if (current.first_token_idx < 0) {
      current.first_token_idx = static_cast<int>(i);
      current.first_frame = token_start_frame[i];
    }
    current.text += tokens[i].text;
    current.last_token_idx = static_cast<int>(i);
    current.last_frame = token_end_frame[i];

    if (i < align_result.text_token_probs.size()) {
      current.prob_sum += align_result.text_token_probs[i];
      current.prob_count++;
    }
  }

  if (current.first_token_idx >= 0) {
    words.push_back(std::move(current));
  }

  // Step 4: convert frames to seconds and build output.
  std::vector<AlignedWord> result;
  result.reserve(words.size());

  for (auto& wb : words) {
    AlignedWord aw;
    // Trim leading/trailing whitespace from word text
    size_t start = wb.text.find_first_not_of(' ');
    size_t end = wb.text.find_last_not_of(' ');
    if (start == std::string::npos) continue; // whitespace-only word, skip
    aw.word = wb.text.substr(start, end - start + 1);
    // Convert reduced frames to seconds: time = frame * stride(2) * hop / sr
    aw.start_sec = segment_start_offset +
        static_cast<float>(wb.first_frame) * 2.0f *
        static_cast<float>(160) / 16000.0f;
    // End frame: use the next frame after the last mapped frame
    aw.end_sec = segment_start_offset +
        static_cast<float>(wb.last_frame + 1) * 2.0f *
        static_cast<float>(160) / 16000.0f;
    // Clamp: end must be >= start
    if (aw.end_sec < aw.start_sec + 0.02f)
      aw.end_sec = aw.start_sec + 0.02f;
    aw.probability = wb.prob_count > 0
        ? wb.prob_sum / static_cast<float>(wb.prob_count)
        : 0.0f;
    result.push_back(std::move(aw));
  }

  return result;
}

// ---------------------------------------------------------------------------
// JSON response construction with word timestamps
// ---------------------------------------------------------------------------
json to_response_json(
    const std::vector<DecodedSegment>& segments,
    const openscreen::ct2::WhisperTokenizer& tok,
    const std::string& language,
    const std::vector<std::vector<AlignedWord>>& word_alignment) {

  json out;
  out["language"] = language;
  out["detected_language"] = language;
  json segs = json::array();

  for (size_t i = 0; i < segments.size(); ++i) {
    const auto& s = segments[i];
    json seg;
    seg["id"] = int(i);
    seg["text"] = decode_tokens(s.token_ids, tok);
    seg["start"] = s.start;
    seg["end"] = s.end;

    // Attach word-level timestamps if available for this segment
    if (i < word_alignment.size() && !word_alignment[i].empty()) {
      json words = json::array();
      for (const auto& w : word_alignment[i]) {
        json wj;
        wj["word"] = w.word;
        wj["start"] = w.start_sec;
        wj["end"] = w.end_sec;
        wj["probability"] = w.probability;
        words.push_back(std::move(wj));
      }
      seg["words"] = std::move(words);
    }

    segs.push_back(std::move(seg));
  }

  out["segments"] = std::move(segs);
  return out;
}

// ---------------------------------------------------------------------------
// Helper: build a StorageView from mel feature data on CPU
// ---------------------------------------------------------------------------
std::shared_ptr<ctranslate2::StorageView> make_feature_view(
    const std::vector<float>& data,
    int64_t n_mels,
    int64_t n_frames) {
  ctranslate2::Shape shape{1, n_mels, n_frames};
  auto copy = data; // StorageView takes ownership via move
  return std::make_shared<ctranslate2::StorageView>(
      shape, std::move(copy), ctranslate2::Device::CPU);
}

// Filter text token IDs to only include real text tokens (< EOT).
std::vector<size_t> filter_text_tokens(const std::vector<int>& token_ids) {
  std::vector<size_t> out;
  out.reserve(token_ids.size());
  for (int id : token_ids) {
    if (id >= 0 && id < EOT_ID) {
      out.push_back(static_cast<size_t>(id));
    }
  }
  return out;
}

} // namespace

// ===========================================================================
// Main
// ===========================================================================
int main(int argc, char** argv) {
  ServerConfig cfg = ServerConfig::from_env(0);
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--model" && i + 1 < argc) cfg.model_dir = argv[++i];
    else if (a == "--host" && i + 1 < argc) cfg.host = argv[++i];
    else if (a == "--port" && i + 1 < argc) cfg.port = std::atoi(argv[++i]);
    else if (a == "--threads" && i + 1 < argc) cfg.threads = std::atoi(argv[++i]);
    else if (a == "--cuda") cfg.use_cuda = true;
    else if (a == "--int8") cfg.use_int8 = true;
  }
  if (cfg.model_dir.empty()) {
    std::cerr << "FATAL: --model / OPENSCREEN_CT2_MODEL_DIR is required"
              << std::endl;
    return 2;
  }

  log("boot: model_dir=" + cfg.model_dir +
      " host=" + cfg.host +
      " port=" + std::to_string(cfg.port) +
      " threads=" + std::to_string(cfg.threads) +
      " cuda=" + (cfg.use_cuda ? "on" : "off"));

  // Load the model
  std::unique_ptr<ctranslate2::models::Whisper> model;
  try {
    ctranslate2::ReplicaPoolConfig pool_config;
    pool_config.num_threads_per_replica = cfg.threads;
    // ponytail: pick the compute type per target:
    //   CUDA     → FLOAT16  (GPU tensor cores)
    //   CPU+int8 → INT8     (oneDNN/OpenBLAS INT8 GEMM, ~5–10× Ruy/fp32)
    //   CPU      → FLOAT32  (fallback for fp16/fp32 models without int8 weights)
    ctranslate2::ComputeType compute_type;
    if (cfg.use_cuda) {
      compute_type = ctranslate2::ComputeType::FLOAT16;
    } else if (cfg.use_int8) {
      compute_type = ctranslate2::ComputeType::INT8;
    } else {
      compute_type = ctranslate2::ComputeType::FLOAT32;
    }
    model = std::make_unique<ctranslate2::models::Whisper>(
        cfg.model_dir,
        cfg.use_cuda ? ctranslate2::Device::CUDA : ctranslate2::Device::CPU,
        compute_type,
        std::vector<int>{0},
        /*tensor_parallel=*/false,
        pool_config);
  } catch (const std::exception& e) {
    std::cerr << "FATAL: model load failed: " << e.what() << std::endl;
    return 3;
  }
  log("model loaded: " +
      std::string(model->is_multilingual() ? "multilingual" : "english-only") +
      " n_mels=" + std::to_string(model->n_mels()));

  // Load the tokenizer
  openscreen::ct2::WhisperTokenizer tok = load_tokenizer(cfg.model_dir);
  log("tokenizer sanity: id(<|en|>)=" + std::to_string(tok.id_for("<|en|>")));

  // Derive timestamp_begin from the tokenizer
  int ts_begin = -1;
  try {
    int no_ts_id = tok.id_for("<|notimestamps|>");
    ts_begin = no_ts_id + 1;
  } catch (const std::exception& e) {
    std::cerr << "FATAL: tokenizer missing <|notimestamps|>: " << e.what()
              << std::endl;
    return 3;
  }

  // -----------------------------------------------------------------------
  // HTTP server
  // -----------------------------------------------------------------------
  httplib::Server svr;
  svr.set_payload_max_length(2 * 1024 * 1024 * 1024);
  svr.set_read_timeout(60, 0);
  svr.set_write_timeout(60, 0);

  // Readiness probe
  svr.Get("/", [](const httplib::Request&, httplib::Response& res) {
    res.set_content("ok\n", "text/plain");
  });

  std::mutex model_mu;

  svr.Post("/inference", [&model, &tok, ts_begin, &model_mu, &cfg](
                                const httplib::Request& req,
                                httplib::Response& res) {
    // --------------------------------------------------------------------
    // 1. Parse WAV from multipart payload
    // --------------------------------------------------------------------
    auto it = req.files.find("file");
    if (it == req.files.end()) {
      res.status = 400;
      res.set_content("{\"error\":\"missing 'file' form field\"}",
                      "application/json");
      return;
    }
    const auto& file_entry = it->second;
    openscreen::ct2::WavData wav;
    try {
      wav = openscreen::ct2::read_pcm_wav(
          file_entry.content.data(), file_entry.content.size());
    } catch (const std::exception& e) {
      res.status = 400;
      res.set_content(std::string("{\"error\":\"") + e.what() + "\"}",
                       "application/json");
      return;
    }

    // --------------------------------------------------------------------
    // 2. Parse language parameter
    // --------------------------------------------------------------------
    std::string language = "en";
    if (auto p = req.get_file_value("language"); !p.content.empty()) {
      language = p.content;
    } else {
      const auto& kv = req.params.find("language");
      if (kv != req.params.end()) language = kv->second;
    }
    if (language == "auto") language = "";

    // --------------------------------------------------------------------
    // 3. Compute log-mel features from the raw audio
    // --------------------------------------------------------------------
    openscreen::ct2::FeatureConfig fcfg;
    fcfg.sample_rate = cfg.sample_rate;
    fcfg.n_fft = cfg.n_fft;
    fcfg.hop_length = cfg.hop_length;
    fcfg.n_mels = cfg.n_mels;
    fcfg.chunk_length = cfg.chunk_length;

    auto window = openscreen::ct2::hann_window(fcfg.n_fft);
    auto fb = openscreen::ct2::build_mel_filterbank(fcfg);

    // Compute features for the FULL audio (no padding/trimming yet).
    auto full_features = openscreen::ct2::compute_log_mel(wav.samples, fcfg, fb, window);
    const int total_feature_frames = full_features.n_frames;
    const int max_frames_per_chunk = fcfg.chunk_length * fcfg.sample_rate / fcfg.hop_length;

    // --------------------------------------------------------------------
    // 4. Generate transcription + alignment, with chunking for long recordings
    // --------------------------------------------------------------------
    struct ChunkResult {
      std::vector<DecodedSegment> segments;
      std::vector<std::vector<AlignedWord>> words;
      std::string language;
    };

    std::vector<ChunkResult> chunk_results;
    std::string chosen_language = language;

    // Determine number of chunks
    const int n_chunks =
        (total_feature_frames + max_frames_per_chunk - 1) / max_frames_per_chunk;

    try {
      std::lock_guard<std::mutex> lk(model_mu);

      for (int chunk_idx = 0; chunk_idx < n_chunks; ++chunk_idx) {
        // ------------------------------------------------------------------
        // 4a. Extract sub-features for this chunk
        // ------------------------------------------------------------------
        const int chunk_start_frame = chunk_idx * max_frames_per_chunk;
        const int chunk_frames =
            std::min(max_frames_per_chunk, total_feature_frames - chunk_start_frame);
        const size_t feat_offset =
            static_cast<size_t>(chunk_start_frame) *
            static_cast<size_t>(fcfg.n_mels);
        const size_t feat_count =
            static_cast<size_t>(chunk_frames) *
            static_cast<size_t>(fcfg.n_mels);

        // Pad sub-features to max_frames_per_chunk (Whisper expects fixed-size input)
        std::vector<float> padded(
            static_cast<size_t>(max_frames_per_chunk) *
                static_cast<size_t>(fcfg.n_mels),
            0.0f);
        std::copy(full_features.data.begin() +
                      static_cast<ptrdiff_t>(feat_offset),
                  full_features.data.begin() +
                      static_cast<ptrdiff_t>(feat_offset + feat_count),
                  padded.begin());

        auto sv_chunk = make_feature_view(
            padded, fcfg.n_mels, max_frames_per_chunk);

        // ------------------------------------------------------------------
        // 4b. Language detection (first chunk only)
        // ------------------------------------------------------------------
        if (chosen_language.empty() && chunk_idx == 0) {
          LanguageDetection det = detect_language(*model, tok, *sv_chunk);
          if (!det.language.empty()) {
            chosen_language = det.language;
          } else {
            chosen_language = "en";
          }
        }

        // ------------------------------------------------------------------
        // 4c. Build prompt (SOT + lang + transcribe)
        // ------------------------------------------------------------------
        auto int_prompt = build_prompt(tok, chosen_language);
        std::vector<std::vector<size_t>> prompts;
        std::vector<size_t> prompt_sz;
        prompt_sz.reserve(int_prompt.size());
        for (int t : int_prompt)
          prompt_sz.push_back(static_cast<size_t>(t));
        prompts.push_back(std::move(prompt_sz));

        // ------------------------------------------------------------------
        // 4d. Generate
        // ------------------------------------------------------------------
        ctranslate2::models::WhisperOptions opts;
        opts.beam_size = 5;
        opts.patience = 1.0f;
        opts.length_penalty = 1.0f;
        opts.sampling_temperature = 0.0f;
        opts.max_initial_timestamp_index = 0;
        opts.max_length = 448;

        auto gen_futures =
            model->generate(*sv_chunk, std::move(prompts), opts);
        if (gen_futures.empty())
          continue;

        auto gen_result = gen_futures[0].get();
        if (gen_result.sequences_ids.empty())
          continue;

        std::vector<int> emitted_ids(
            gen_result.sequences_ids[0].begin(),
            gen_result.sequences_ids[0].end());

        // ------------------------------------------------------------------
        // 4e. Split into phrase segments
        // ------------------------------------------------------------------
        auto chunk_segments =
            split_segments(emitted_ids, ts_begin, TIME_PRECISION);

        if (chunk_segments.empty())
          continue;

        // ------------------------------------------------------------------
        // 4f. Word-level alignment via CTranslate2 WhisperReplica::align()
        // ------------------------------------------------------------------
        std::vector<std::vector<AlignedWord>> chunk_words(chunk_segments.size());

        // Build clean text_tokens for each segment
        std::vector<std::vector<size_t>> text_tokens;
        std::vector<size_t> segment_indices;
        for (size_t si = 0; si < chunk_segments.size(); ++si) {
          auto clean = filter_text_tokens(chunk_segments[si].token_ids);
          if (!clean.empty()) {
            text_tokens.push_back(std::move(clean));
            segment_indices.push_back(si);
          }
        }

        if (!text_tokens.empty()) {
          auto start_vec = build_prompt(tok, chosen_language);
          std::vector<size_t> start_sequence;
          start_sequence.reserve(start_vec.size());
          for (int t : start_vec)
            start_sequence.push_back(static_cast<size_t>(t));

          std::vector<size_t> num_frames_vec(
              text_tokens.size(),
              static_cast<size_t>(chunk_frames));

          try {
            auto align_futures = model->align(
                *sv_chunk,
                start_sequence,
                text_tokens,
                num_frames_vec,
                MEDIAN_FILTER_WIDTH);

            for (size_t ai = 0;
                 ai < align_futures.size() && ai < segment_indices.size();
                 ++ai) {
              auto align_result = align_futures[ai].get();
              size_t seg_idx = segment_indices[ai];
              chunk_words[seg_idx] = build_word_timestamps(
                  text_tokens[ai],
                  tok,
                  align_result,
                  TIME_PRECISION,
                  chunk_segments[seg_idx].start);
            }
          } catch (const std::exception& e) {
            log("align warning (chunk " + std::to_string(chunk_idx) +
                "): " + e.what() + " — phrase-only fallback");
          }
        }

        chunk_results.push_back(ChunkResult{
            std::move(chunk_segments),
            std::move(chunk_words),
            chosen_language,
        });
      }
    } catch (const std::exception& e) {
      res.status = 500;
      res.set_content(std::string("{\"error\":\"") + e.what() + "\"}",
                       "application/json");
      return;
    }

    // --------------------------------------------------------------------
    // 5. Merge chunk results: shift timestamps by chunk offset, concatenate
    // --------------------------------------------------------------------
    std::vector<DecodedSegment> merged_segments;
    std::vector<std::vector<AlignedWord>> merged_words;
    float running_offset_sec = 0.0f;

    for (int ci = 0; ci < static_cast<int>(chunk_results.size()); ++ci) {
      auto& cr = chunk_results[ci];
      for (size_t si = 0; si < cr.segments.size(); ++si) {
        auto& seg = cr.segments[si];
        DecodedSegment shifted;
        shifted.start = seg.start + running_offset_sec;
        shifted.end = seg.end + running_offset_sec;
        shifted.text = std::move(seg.text);
        shifted.token_ids = std::move(seg.token_ids);
        merged_segments.push_back(std::move(shifted));

        if (si < cr.words.size()) {
          std::vector<AlignedWord> shifted_words;
          shifted_words.reserve(cr.words[si].size());
          for (auto& w : cr.words[si]) {
            AlignedWord sw;
            sw.word = std::move(w.word);
            sw.start_sec = w.start_sec + running_offset_sec;
            sw.end_sec = w.end_sec + running_offset_sec;
            sw.probability = w.probability;
            shifted_words.push_back(std::move(sw));
          }
          merged_words.push_back(std::move(shifted_words));
        } else {
          merged_words.emplace_back();
        }
      }
      // Each chunk is `chunk_length` seconds long. The running offset advances
      // by the chunk length (not the actual audio length, since Whisper consumes
      // fixed-size input windows).
      running_offset_sec += static_cast<float>(cfg.chunk_length);
    }

    // --------------------------------------------------------------------
    // 6. Build and send JSON response
    // --------------------------------------------------------------------
    if (merged_segments.empty()) {
      // No segments produced — return an empty result rather than error
      json empty;
      empty["language"] = chosen_language;
      empty["detected_language"] = chosen_language;
      empty["segments"] = json::array();
      res.set_content(empty.dump(), "application/json");
      return;
    }

    // Deduplicate segment IDs (they're sequential within each chunk)
    for (size_t i = 0; i < merged_segments.size(); ++i) {
      // IDs are cosmetic — leave them sequential from 0
    }

    json reply = to_response_json(
        merged_segments, tok, chosen_language, merged_words);
    res.set_content(reply.dump(), "application/json");
  });

  // -----------------------------------------------------------------------
  // Bind + listen
  // -----------------------------------------------------------------------
  if (cfg.port == 0) {
    cfg.port = svr.bind_to_any_port(cfg.host);
  } else {
    if (!svr.bind_to_port(cfg.host, cfg.port)) {
      std::cerr << "FATAL: bind_to_port(" << cfg.host << ":" << cfg.port
                << ") failed" << std::endl;
      return 4;
    }
  }
  log("listening on " + cfg.host + ":" + std::to_string(cfg.port));
  if (!svr.listen_after_bind()) {
    std::cerr << "FATAL: listen_after_bind failed" << std::endl;
    return 5;
  }
  return 0;
}
