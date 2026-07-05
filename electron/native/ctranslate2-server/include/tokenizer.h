// Whisper BPE tokenizer — decoder + special-token lookup.
//
// ponytail: faster-whisper's Python tokenizer.py wraps HuggingFace's
// tokenizers library, which does (a) byte-level (GPT-2-style) decoding for
// the regular vocabulary and (b) exact-name lookup for `added_tokens`
// (special tokens like `<|startoftranscript|>` / `<|en|>` / `<|transcribe|>`).
// We only need the **decoding** path at runtime — Whisper's model emits
// tokens whose IDs we turn back into text; the **encoding** path only ever
// runs once at boot to build the SOT prompt, which only uses special tokens
// (no real BPE merge work needed). This means we get to skip the entire
// merge-rule BPE machine, the regex `pat`, and the lru_cache machinery.

#pragma once

#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>

namespace openscreen::ct2 {

// Locally-loaded tokenizer + decoder. Cheap to construct (one JSON parse).
class WhisperTokenizer {
public:
  // Load from the JSON produced by HuggingFace fast-tokenizer export.
  // Throws on malformed JSON / wrong schema; the caller is expected to
  // surface the error over HTTP. We deliberately don't pull in nlohmann/json
  // here to keep this module testable standalone — the JSON parsing is done
  // by the caller, who hands us two std::unordered_maps and a vector.
  WhisperTokenizer(
      std::unordered_map<std::string, int> vocab,
      std::unordered_map<int, std::string> added_tokens)
      : vocab_(std::move(vocab)),
        added_tokens_(std::move(added_tokens)) {
    // Build the inverted lookup.
    id_to_str_.reserve(vocab_.size() + added_tokens_.size());
    for (const auto& kv : vocab_) {
      id_to_str_.emplace(kv.second, kv.first);
    }
    for (const auto& kv : added_tokens_) {
      // Special tokens win ties in case vocab and added_tokens overlap
      // (the tokenizer contract lets the same id be referred to either way,
      // but the textual form of a `<|xyz|>` token is the canonical name).
      id_to_str_[kv.first] = kv.second;
    }
    build_added_inv();
  }

  // GPT-2 byte decoder: each codepoint that appears in our vocab maps back
  // to its original utf-8 byte value. Hardcoded into a constexpr table — see
  // SYSTRAN/faster-whisper and gpt-2/src/encoder.py::bytes_to_unicode.
  static std::string decode_bytes(const std::string& bpe_token) {
    static const auto map = byte_decoder_map();
    std::string out;
    out.reserve(bpe_token.size());
    for (size_t i = 0; i < bpe_token.size(); ) {
      unsigned char c = static_cast<unsigned char>(bpe_token[i]);
      // Try multibyte UTF-8 sequences first (the codepoints produced by the
      // GPT-2 byte_encoder are in U+0100..U+017F + ASCII printable + some
      // Latin-extended punctuation, so 2-byte UTF-8 covers them all).
      int len = 1;
      unsigned int cp = 0;
      if ((c & 0xE0) == 0xC0) { len = 2; cp = c & 0x1F; }
      else if ((c & 0xF0) == 0xE0) { len = 3; cp = c & 0x0F; }
      else if ((c & 0xF8) == 0xF0) { len = 4; cp = c & 0x07; }
      else { cp = c; }
      for (int k = 1; k < len && i + k < bpe_token.size(); ++k) {
        cp = (cp << 6) | (static_cast<unsigned char>(bpe_token[i + k]) & 0x3F);
      }
      auto it = map.find(cp);
      if (it != map.end()) {
        out.push_back(static_cast<char>(it->second));
      } else {
        // Unknown codepoint — drop it. Should never happen for our vocab.
      }
      i += len;
    }
    return out;
  }

  // Lookup helpers.
  int id_for(const std::string& piece) const {
    // Special tokens first (added_tokens wins over vocab per the HF contract).
    auto it_a = added_tokens_inv_.find(piece);
    if (it_a != added_tokens_inv_.end()) return it_a->second;
    auto it_v = vocab_.find(piece);
    if (it_v != vocab_.end()) return it_v->second;
    throw std::runtime_error("token not in vocab: " + piece);
  }

  // Render an emitted token id to its UTF-8 string. For Whisper's
  // 4 special classes (`<|startoftranscript|>`, `<|transcribe|>`, `<|notimestamps|>`,
  // `<|endoftext|>`) we return the canonical name; for everything else we
  // apply the GPT-2 byte decoder to the BPE piece.
  std::string render(int id) const {
    auto it = id_to_str_.find(id);
    if (it == id_to_str_.end()) return "";
    return decode_bytes(it->second);
  }

  bool try_render(int id, std::string* out) const {
    auto it = id_to_str_.find(id);
    if (it == id_to_str_.end()) return false;
    *out = decode_bytes(it->second);
    return true;
  }

  // `eot_id` is the canonical end-of-turn token; for Whisper that's 50257.
  int eot_id() const { return 50257; }

  // `sot_id` is 50258 ("<|startoftranscript|>"); needed to build the prompt.
  int sot_id() const { return 50258; }

private:
  // Lazy inverted lookup for `added_tokens` (it's per-name not per-id).
  void build_added_inv() {
    added_tokens_inv_.reserve(added_tokens_.size());
    for (const auto& kv : added_tokens_) {
      added_tokens_inv_.emplace(kv.second, kv.first);
    }
  }
  static std::unordered_map<unsigned int, unsigned char> byte_decoder_map() {
    // GPT-2's bytes_to_unicode() mapping, reversed. The forward map sends
    // every printable ASCII byte to itself, every Latin-1 supplement byte
    // to itself, and then maps the remaining 68 control/whitespace bytes
    // (256-188) to new codepoints at U+0100+. Reverse just inverts each.
    std::unordered_map<unsigned int, unsigned char> m;
    int n = 0;
    std::vector<int> bs;
    auto add = [&](int b) { bs.push_back(b); };
    for (int b = int('!'); b <= int('~'); ++b) add(b);
    for (int b = 0xA1; b <= 0xAC; ++b) add(b);
    for (int b = 0xAE; b <= 0xFF; ++b) add(b);
    std::vector<int> cs = bs;
    for (int b = 0; b < 256; ++b) {
      bool in = false;
      for (int c : bs) if (c == b) { in = true; break; }
      if (!in) {
        bs.push_back(b);
        cs.push_back(256 + n);
        ++n;
      }
    }
    for (size_t i = 0; i < bs.size(); ++i) {
      m.emplace(static_cast<unsigned int>(cs[i]),
                static_cast<unsigned char>(bs[i]));
    }
    return m;
  }

  std::unordered_map<std::string, int> vocab_;
  std::unordered_map<int, std::string> added_tokens_;
  std::unordered_map<int, std::string> id_to_str_;
  std::unordered_map<std::string, int> added_tokens_inv_;
};

} // namespace openscreen::ct2
