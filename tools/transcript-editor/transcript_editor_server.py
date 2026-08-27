# -*- coding: utf-8 -*-
"""OpenScreen 转写改字器 — 本地单文件工具

一个零依赖的本地网页小工具，用来编辑 OpenScreen 项目（.openscreen）里的
自动转写（Whisper 转写的字幕文字）。它把一段段转写显示成干净的输入框，
改完保存会自动备份原文件并写回，重开 OpenScreen 即可看到修正后的字幕。

特点：
- 每个词一个可编辑输入框，长句子自动加宽，不用右滑就能看全。
- 无效词（如 Whisper 的 "(听不懂)" 占位）可一键清空，字幕里会跳过它。
- 保存前自动备份（.bak-<时间戳>），改坏了随时可回滚。
- "撤销修改"按钮回到磁盘版本，放弃未保存的修改。
- 零依赖：只用 Python 标准库，双击就能跑。

用法：python transcript_editor_server.py，浏览器打开 http://127.0.0.1:8765。
也可以设置环境变量 OPENSCREEN_PROJECTS_DIR 覆盖 OpenScreen 项目目录，
用于非默认安装。默认按平台定位：Windows 是 ~/AppData/Roaming/openscreen/projects，
macOS 是 ~/Library/Application Support/openscreen/projects，
Linux 是 $XDG_CONFIG_HOME/openscreen/projects（未设置时为 ~/.config/openscreen/projects）。
"""
import json
import os
import shutil
import sys
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse

# OpenScreen 的项目文件目录，即 Electron 的 app.getPath("userData") + "/projects"。
# 应用名取 package.json 的 name（没有 productName），所以三个平台分别是：
_WINDOWS_PROJECTS = os.path.expanduser("~/AppData/Roaming/openscreen/projects")
_MACOS_PROJECTS = os.path.expanduser("~/Library/Application Support/openscreen/projects")
# Linux 上 userData 是 $XDG_CONFIG_HOME/openscreen，环境变量没设置时退回 ~/.config/openscreen。
_LINUX_PROJECTS = os.path.join(
    os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"),
    "openscreen",
    "projects",
)
# 本平台的位置必须排第一：三个都探测不到时会回退到 DEFAULT_PROJECTS_TRIES[0]，
# main() 又照着它建目录——顺序错了就会在 Linux 家目录里造出 ~/AppData 这种
# 别的平台形状的空目录，而项目下拉框还是空的。
if sys.platform == "win32":
    DEFAULT_PROJECTS_TRIES = [_WINDOWS_PROJECTS, _MACOS_PROJECTS, _LINUX_PROJECTS]
elif sys.platform == "darwin":
    DEFAULT_PROJECTS_TRIES = [_MACOS_PROJECTS, _WINDOWS_PROJECTS, _LINUX_PROJECTS]
else:
    DEFAULT_PROJECTS_TRIES = [_LINUX_PROJECTS, _WINDOWS_PROJECTS, _MACOS_PROJECTS]
# 可用环境变量覆盖，这样非默认安装位置也能用。
PROJECTS_DIR = os.environ.get("OPENSCREEN_PROJECTS_DIR") or next(
    (p for p in DEFAULT_PROJECTS_TRIES if os.path.isdir(p)), DEFAULT_PROJECTS_TRIES[0]
)
PORT = 8765

PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>OpenScreen 转写改字器</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { font-family: "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0;
         background: #f4f5f7; color: #1a1d23; }
  header { background: #0e1116; color: #fff; padding: 14px 24px;
           display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .sub { color: #9aa3b2; font-size: 12px; }
  .warn { background: #fff7e6; border: 1px solid #ffd591; color: #874d00;
          padding: 10px 16px; font-size: 13px; margin: 12px 16px 0; border-radius: 8px; }
  .main { max-width: 860px; margin: 16px auto 60px; padding: 0 16px; }
  .bar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap;
         background: #fff; border: 1px solid #e2e5ea; border-radius: 10px;
         padding: 12px; margin-bottom: 16px; }
  select, button { font-size: 13px; padding: 7px 12px; border-radius: 7px;
                   border: 1px solid #c9ced6; background: #fff; cursor: pointer; }
  button.primary { background: #4f6ef7; color: #fff; border-color: #4f6ef7; font-weight: 600; }
  button.primary:hover { background: #3d5ce0; }
  button.ghost { background: #f4f5f7; }
  button.danger { background: #fff; color: #c0392b; border-color: #e5b8b2; }
  #meta { font-size: 12px; color: #6b7280; margin: 4px 2px 12px; }
  .seg { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px;
         padding: 10px 12px; margin-bottom: 10px; }
  .seg .segt { font-size: 11px; color: #8a93a3; margin-bottom: 6px;
               font-family: Consolas, monospace; }
  .words { display: flex; flex-wrap: wrap; gap: 6px; }
  .word { display: flex; align-items: center; background: #f8fafc;
          border: 1px solid #dde2ea; border-radius: 8px; padding: 2px 4px 2px 2px; }
  .word input { border: none; background: transparent; font-size: 14px;
                padding: 5px 6px; width: 118px; outline: none; border-radius: 6px; }
  .word input:focus { background: #eef2ff; }
  .word .ts { font-size: 10px; color: #a7b0bd; font-family: Consolas, monospace;
              padding: 0 2px; }
  .word .del { border: none; background: transparent; color: #c9ced6;
               cursor: pointer; font-size: 13px; padding: 2px 4px; border-radius: 5px; }
  .word .del:hover { color: #e74c3c; background: #fdecea; }
  .word.empty input { color: #b9c0cc; }
  #status { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%);
            background: #1a1d23; color: #e8eaf0; padding: 10px 18px; border-radius: 10px;
            font-size: 13px; box-shadow: 0 4px 24px rgba(0,0,0,.25);
            opacity: 0; transition: opacity .2s; pointer-events: none; z-index: 9; }
  #status.show { opacity: 1; }
  .empty-hint { text-align: center; color: #8a93a3; padding: 60px 0; }
</style>
</head>
<body>
<header>
  <h1>📝 OpenScreen 转写改字器</h1>
  <span class="sub">改字 → 保存 → 重开 OpenScreen 即生效</span>
</header>

<div class="warn">⚠️ 编辑前请<strong>完全退出 OpenScreen</strong>（托盘图标也退出），否则它的旧数据会在下次保存时覆盖你的修改。保存会自动备份原文件。</div>

<div class="main">
  <div class="bar">
    <select id="project"></select>
    <select id="transcript" title="选择转写（项目含多个音视频转写时可用）" style="display:none"></select>
    <button id="load" class="ghost">加载转写</button>
    <button id="save" class="primary">💾 保存修改</button>
    <button id="reload" class="ghost" title="放弃未保存的修改，重新读取文件">撤销修改</button>
    <span style="flex:1"></span>
    <button id="download" class="ghost" title="把当前项目另存为标准 JSON（含转写）">导出副本</button>
  </div>
  <div id="meta"></div>
  <div id="list"><div class="empty-hint">加载项目后在这里显示转写，每个词一个输入框，直接改字即可。</div></div>
</div>

<div id="status"></div>

<script>
const $ = (id) => document.getElementById(id);
let currentPath = null;
let currentTranscriptId = null;

function fillTranscriptSelect(transcripts, activeId) {
  const sel = $('transcript');
  const visible = transcripts && transcripts.length > 1;
  sel.style.display = visible ? '' : 'none';
  sel.innerHTML = '';
  (transcripts || []).forEach((t) => {
    const o = document.createElement('option');
    o.value = t.id;
    o.textContent = `转写 ${t.index + 1} · ${t.language} · ${t.wordCount}词/${t.segmentCount}段`;
    sel.appendChild(o);
  });
  if (visible) sel.value = activeId || (transcripts && transcripts[0].id);
}

// 一个隐藏的测量元素，用来让每个输入框自动加宽到能容纳完整内容，
// 这样长句子（一个字词是一整句）不用右滑就能看全。
const measure = (() => {
  const m = document.createElement('span');
  m.style.visibility = 'hidden';
  m.style.position = 'absolute';
  m.style.whiteSpace = 'pre';
  m.style.font = '14px "Microsoft YaHei", sans-serif';
  document.body.appendChild(m);
  return m;
})();

function autoSize(input) {
  measure.textContent = input.value || ' ';
  input.style.width = Math.max(118, measure.offsetWidth + 26) + 'px';
}

function status(msg, ms = 2200) {
  const s = $('status');
  s.textContent = msg; s.classList.add('show');
  clearTimeout(s._t); s._t = setTimeout(() => s.classList.remove('show'), ms);
}

async function api(action, payload) {
  const r = await fetch('/api/' + action, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || '请求失败');
  return j;
}

async function refreshProjects() {
  const sel = $('project');
  sel.innerHTML = '<option value="">— 选择项目 —</option>';
  const j = await api('projects');
  for (const p of j.projects) {
    const o = document.createElement('option');
    o.value = p.path;
    o.textContent = p.title + '  ·  ' + p.modified;
    sel.appendChild(o);
  }
}

$('load').onclick = async () => {
  const path = $('project').value;
  if (!path) { status('请先选择一个项目'); return; }
  try {
    const j = await api('load', { path });
    currentPath = path;
    currentTranscriptId = j.activeId || null;
    fillTranscriptSelect(j.transcripts, j.activeId);
    $('meta').textContent = '项目：' + j.title + '  ·  转写语言 ' + (j.language || '?') +
      '  ·  共 ' + Object.keys(j.words).length + ' 词 / ' + j.segments.length + ' 段';
    render(j.segments, j.words);
    status('已加载');
  } catch (e) { status('加载失败：' + e.message, 3500); }
};

// 切换转写（多转写项目）
$('transcript').onchange = async () => {
  if (!currentPath) return;
  const tid = $('transcript').value;
  try {
    const j = await api('load', { path: currentPath, transcriptId: tid });
    currentTranscriptId = j.activeId || tid;
    $('meta').textContent = '项目：' + j.title + '  ·  转写语言 ' + (j.language || '?') +
      '  ·  共 ' + Object.keys(j.words).length + ' 词 / ' + j.segments.length + ' 段';
    render(j.segments, j.words);
    status('已切换转写');
  } catch (e) { status('切换失败：' + e.message, 3500); }
};

function render(segments, wordMap) {
  const list = $('list');
  list.innerHTML = '';
  if (!segments.length) { list.innerHTML = '<div class="empty-hint">该项目没有转写。</div>'; return; }
  segments.forEach((seg, si) => {
    const box = document.createElement('div');
    box.className = 'seg';
    const head = document.createElement('div');
    head.className = 'segt';
    head.textContent = '段 ' + (si + 1) + '  ·  ' + seg.startSec.toFixed(2) + 's – ' + seg.endSec.toFixed(2) + 's';
    box.appendChild(head);
    const words = document.createElement('div');
    words.className = 'words';
    (seg.wordIds || []).forEach((wid) => {
      const w = wordMap[wid];
      if (!w) return;
      const cell = document.createElement('div');
      cell.className = 'word' + (w.text.trim() ? '' : ' empty');
      const input = document.createElement('input');
      input.value = w.text;
      input.dataset.wid = wid;
      input.dataset.empty = w.text.trim() ? '0' : '1';
      input.oninput = () => {
        cell.classList.toggle('empty', !input.value.trim());
        input.dataset.empty = input.value.trim() ? '0' : '1';
        autoSize(input);
      };
      autoSize(input);
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.textContent = w.startSec.toFixed(1) + 's';
      const del = document.createElement('button');
      del.className = 'del';
      del.title = '清空这个词（字幕里将跳过它）';
      del.textContent = '✕';
      del.onclick = () => { input.value = ''; cell.classList.add('empty'); input.dataset.empty = '1'; };
      cell.appendChild(input); cell.appendChild(ts); cell.appendChild(del);
      words.appendChild(cell);
    });
    box.appendChild(words);
    list.appendChild(box);
  });
}

$('save').onclick = async () => {
  if (!currentPath) { status('请先加载项目'); return; }
  const inputs = Array.from(document.querySelectorAll('.word input'));
  const words = inputs.map((i) => ({ id: i.dataset.wid, text: i.value }));
  try {
    const payload = { path: currentPath, words };
    if (currentTranscriptId) payload.transcriptId = currentTranscriptId;
    const j = await api('save', payload);
    status('✅ 已保存（备份：' + j.backup + '）', 4200);
  } catch (e) { status('保存失败：' + e.message, 4000); }
};

$('reload').onclick = async () => {
  if (!currentPath) return;
  try {
    const payload = { path: currentPath };
    if (currentTranscriptId) payload.transcriptId = currentTranscriptId;
    const j = await api('load', payload);
    currentTranscriptId = j.activeId || currentTranscriptId;
    fillTranscriptSelect(j.transcripts, j.activeId);
    render(j.segments, j.words);
    status('已恢复为磁盘上的版本');
  } catch (e) { status('读取失败：' + e.message, 3500); }
};

$('download').onclick = async () => {
  if (!currentPath) { status('请先加载项目'); return; }
  try {
    const j = await api('export', { path: currentPath });
    const a = document.createElement('a');
    a.href = 'data:application/octet-stream;base64,' + j.b64;
    a.download = j.name;
    a.click();
    status('副本已导出');
  } catch (e) { status('导出失败：' + e.message, 3500); }
};

refreshProjects().catch((e) => status('项目列表加载失败：' + e.message, 4000));
</script>
</body>
</html>
"""


# 统一的 transcript key：有持久化 id 用 id，否则用 "transcript[<index>]"。
# 让 metadata 构建、get 选择、load 校验和 save 选择都走这一套，避免 key 不一致。
def _transcript_key(tr, idx):
    return tr.get("id") or ("transcript[%d]" % idx)


def load_project(path, active_id=None):
    """返回 (doc, segments_view, word_map, title, language, transcripts_meta, active_id)

    transcripts_meta 列出项目里所有 transcript 的概览（用于前端下拉）；
    segments/word_map 对应 active_id 指定的那条 transcript（默认第一条）。
    """
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    transcripts = doc.get("transcripts") or []
    # 兼容旧字段 transcript（无 transcripts 数组时用顶层 transcript 包装）
    if not transcripts and isinstance(doc.get("transcript"), dict):
        transcripts = [doc["transcript"]]
    title = (doc.get("project") or {}).get("title", os.path.basename(path))

    transcripts_meta = []
    for idx, tr in enumerate(transcripts):
        transcripts_meta.append({
            "index": idx,
            "id": _transcript_key(tr, idx),
            "assetId": tr.get("assetId") or "",
            "language": tr.get("language") or "?",
            "wordCount": len(tr.get("words") or []),
            "segmentCount": len(tr.get("segments") or []),
        })

    # 按 active_id 选出目标；active_id 非空但找不到要报错，不静默回退第一个。
    active = None
    active_idx = 0
    if active_id:
        for idx, tr in enumerate(transcripts):
            if _transcript_key(tr, idx) == active_id:
                active = tr
                active_idx = idx
                break
        if active is None:
            raise ValueError("指定的转写不存在")
    else:
        active = transcripts[0] if transcripts else {}
        active_id = _transcript_key(active, 0) if transcripts else ""

    language = active.get("language") or ""
    word_map = {}
    segments = []
    for w in active.get("words") or []:
        word_map[w["id"]] = w
    for s in active.get("segments") or []:
        segments.append({
            "id": s["id"],
            "startSec": s.get("startSec", 0),
            "endSec": s.get("endSec", 0),
            "wordIds": s.get("wordIds", []),
        })
    return doc, segments, word_map, title, language, transcripts_meta, active_id


# 取语言的主 sub-tag（如 zh-CN -> zh），用于决定 join 策略。
def _language_primary(language):
    return (language or "").split("-")[0].strip().lower()


# 中文/日文的词之间不插空格（"你好世界" 不能被 join 成 "你好 世界"）；
# 其它语言保留空格。按主 sub-tag 判断，因此 zh-CN / zh-TW / ja-JP 也走无空格。
def _join_segment_text(pieces, language):
    kept = [p for p in pieces if p and p.strip()]
    if not kept:
        return ""
    base = _language_primary(language)
    return "".join(kept) if base in ("zh", "ja") else " ".join(kept)


def _select_transcript(transcripts, transcript_id):
    """按统一 key 选出目标 transcript。

    transcript_id 为空时回退到第一个；(非空) 找不到则抛错，绝不静默改到别的 transcript。
    返回 (transcript, index)。
    """
    if transcript_id:
        for idx, tr in enumerate(transcripts):
            if _transcript_key(tr, idx) == transcript_id:
                return tr, idx
        raise ValueError("指定的转写不存在")
    return (transcripts[0], 0) if transcripts else (None, -1)


def _same_transcript(a, b):
    """判断两份 transcript 对象是否指向同一条。

    仅在两者是同一对象，或两者都有非空 persisted id 且匹配时才返回 True。
    不依赖 assetId / 首个单词 id 等不稳定字段，避免把不同 transcript 误判为同一份。
    """
    if a is b:
        return True
    aid = a.get("id") or ""
    bid = b.get("id") or ""
    if aid and bid:
        return aid == bid
    return False


def save_words(path, words_by_id, transcript_id=None):
    """把用户编辑的 words 写回；逐 segment 重建 text；备份原文件。

    只更新选定 transcript_id 对应的那条 transcript；transcript_id 为空时回退到第一个。
    """
    with open(path, "r", encoding="utf-8") as f:
        doc = json.load(f)
    transcripts = doc.get("transcripts") or []
    if not transcripts and isinstance(doc.get("transcript"), dict):
        transcripts = [doc["transcript"]]
    # 兼容旧字段：顶层 transcript 与 transcripts[] 可能是同一份（旧项目只有顶层）
    legacy = doc.get("transcript") if isinstance(doc.get("transcript"), dict) else None

    tr, idx = _select_transcript(transcripts, transcript_id)
    if tr is None:
        raise ValueError("该项目没有 transcripts 数组")
    language = tr.get("language") or (legacy or {}).get("language") or ""
    new_words = {}
    for item in words_by_id:
        new_words[item["id"]] = item["text"]
    touched = 0
    for w in tr.get("words") or []:
        if w["id"] in new_words and new_words[w["id"]] != w.get("text", ""):
            w["text"] = new_words[w["id"]]
            touched += 1
    # 从更新后的 tr["words"] 重建 text map（保留未提交词的原始值，避免 partial payload 清空 segment）
    text_by_id = {w["id"]: w.get("text", "") for w in tr.get("words") or []}
    # 重建每个 segment 的 text（与 words 保持一致）
    for s in tr.get("segments") or []:
        parts = [text_by_id.get(wid, "") for wid in s.get("wordIds", [])]
        s["text"] = _join_segment_text(parts, language)
    # 仅当 legacy 字段确实就是 transcripts 里的那条时同步，避免误改不同内容。
    if legacy and _same_transcript(legacy, tr):
        if legacy.get("words"):
            for w in legacy["words"]:
                if w["id"] in new_words and new_words[w["id"]] != w.get("text", ""):
                    w["text"] = new_words[w["id"]]
        # legacy 也从更新后的 legacy["words"] 重建，保持与 words 一致
        legacy_text = {w["id"]: w.get("text", "") for w in legacy.get("words") or []}
        for s in legacy.get("segments") or []:
            parts = [legacy_text.get(wid, "") for wid in s.get("wordIds", [])]
            s["text"] = _join_segment_text(parts, language)
    # 备份：加纳秒时间戳防同一秒两次保存互相覆盖；先写临时文件再原子替换，
    # 避免 json.dump 写到一半中断导致项目文件损坏。
    backup = path + ".bak-" + time.strftime("%Y%m%d-%H%M%S-") + str(time.time_ns())
    shutil.copy2(path, backup)
    temp_path = path + ".tmp-" + str(os.getpid()) + "-" + str(time.time_ns())
    try:
        # 先读原文件权限，保存后再还原，避免 os.replace 把 restrictive mode 覆盖掉
        original_mode = 0o600
        try:
            original_mode = 0o777 & os.stat(path).st_mode
        except OSError:
            pass
        # 临时文件先用 restrictive mode 创建
        fd = os.open(temp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        # 把原文件 mode 应用到临时文件，确保 os.replace 后 live project 保持原权限
        try:
            os.chmod(temp_path, original_mode)
        except OSError:
            pass
        os.replace(temp_path, path)
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                pass
    return os.path.basename(backup), touched


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def _send(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def _check_request(self):
        # 只接受来自本工具页面的同源 JSON 请求，防止外部网页跨站调用。
        content_type = (self.headers.get("Content-Type") or "").split(";", 1)[0].strip()
        origin = self.headers.get("Origin")
        if content_type != "application/json":
            raise ValueError("请使用 application/json 提交")
        if origin and origin != "http://127.0.0.1:%d" % PORT:
            raise ValueError("拒绝跨站请求")

    @staticmethod
    def _resolve_project_path(raw_path):
        # 归一化并限制在 PROJECTS_DIR 内，防止路径穿越。
        root = os.path.realpath(PROJECTS_DIR)
        path = os.path.realpath(raw_path)
        try:
            inside = os.path.commonpath([root, path]) == root
        except ValueError:
            inside = False
        if not inside or not path.endswith(".openscreen"):
            raise ValueError("无效的项目路径")
        return path

    def do_GET(self):
        if urlparse(self.path).path in ("/", "/index.html"):
            body = PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self._send({"ok": False, "error": "not found"}, 404)

    def do_POST(self):
        try:
            self._check_request()
            data = self._read_json()
            action = urlparse(self.path).path.rsplit("/", 1)[-1]
            if action == "projects":
                out = []
                if os.path.isdir(PROJECTS_DIR):
                    for fn in sorted(os.listdir(PROJECTS_DIR)):
                        if not fn.endswith(".openscreen"):
                            continue
                        p = os.path.join(PROJECTS_DIR, fn)
                        try:
                            with open(p, "r", encoding="utf-8") as f:
                                title = (json.load(f).get("project") or {}).get(
                                    "title", fn
                                )
                        except (OSError, ValueError):
                            title = fn
                        out.append({
                            "path": p,
                            "name": fn,
                            "title": title,
                            "modified": time.strftime(
                                "%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p))
                            ),
                        })
                self._send({"ok": True, "projects": out})
            elif action == "load":
                path = self._resolve_project_path(data.get("path", ""))
                if not os.path.isfile(path):
                    raise ValueError("文件不存在")
                # 支持选定某条 transcript（默认第一条）
                active_id = data.get("transcriptId") or ""
                if active_id:
                    with open(path, "r", encoding="utf-8") as f:
                        raw_doc = json.load(f)
                    all_tr = raw_doc.get("transcripts") or []
                    # 与 load_project 保持一致：legacy-only 项目把顶层 transcript 包装进去
                    if not all_tr and isinstance(raw_doc.get("transcript"), dict):
                        all_tr = [raw_doc["transcript"]]
                    keys = [_transcript_key(t, i) for i, t in enumerate(all_tr)]
                    if active_id not in keys:
                        raise ValueError("指定的转写不存在")
                _doc, segments, word_map, title, language, transcripts_meta, active_id = load_project(path, active_id)
                self._send({
                    "ok": True,
                    "title": title,
                    "language": language,
                    "segments": segments,
                    "words": word_map,
                    "transcripts": transcripts_meta,
                    "activeId": active_id,
                })
            elif action == "save":
                path = self._resolve_project_path(data.get("path", ""))
                words = data.get("words", [])
                if not words:
                    raise ValueError("没有收到修改内容")
                transcript_id = data.get("transcriptId") or ""
                backup, touched = save_words(path, words, transcript_id)
                self._send({"ok": True, "backup": backup, "touched": touched})
            elif action == "export":
                path = self._resolve_project_path(data.get("path", ""))
                with open(path, "r", encoding="utf-8") as f:
                    raw = f.read()
                import base64
                b64 = base64.b64encode(raw.encode("utf-8")).decode("ascii")
                self._send({"ok": True, "name": os.path.basename(path), "b64": b64})
            else:
                self._send({"ok": False, "error": "unknown action"}, 404)
        except Exception as e:
            self._send({"ok": False, "error": str(e)}, 500)


def main():
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    server = HTTPServer(("127.0.0.1", PORT), Handler)
    webbrowser.open("http://127.0.0.1:%d" % PORT)
    print("OpenScreen 转写改字器运行中: http://127.0.0.1:%d  (Ctrl+C 退出)" % PORT)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()