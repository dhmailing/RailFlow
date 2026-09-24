// 로컬 RailFlow 화면.
//
// 왜 Agent가 화면까지 들고 있는가
// -------------------------------
// 공개 배포본(https://...)의 페이지가 http://127.0.0.1 로 요청을 보내는 구조는
// 실제 Chrome/Edge에서 막힌다(docs/V0.8-LOCAL-CONNECTION.md). Mixed Content,
// Private Network Access preflight, CORS가 각각 걸린다. 브라우저 보안 설정을
// 낮추라고 안내하는 것은 선택지가 아니다.
//
// 그래서 화면과 API를 같은 출처(http://127.0.0.1:<port>)에 둔다. 그러면
// 위 세 가지가 전부 적용되지 않는다. 사용자는 Agent를 실행하기만 하면
// 브라우저가 이 화면을 열어 준다.
//
// 이 화면은 공개 배포본의 대체물이 아니다. 실제 연동 전용 콘솔이다.

/**
 * @param {{ token: string, port: number }} options
 */
export function consolePage({ token, port }) {
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>RailFlow 실제 연동 (로컬)</title>
<style>
  :root { color-scheme: dark; --bg:#070707; --card:#111; --line:#2b2b2b; --fg:#f7f7f7; --muted:#929292; --accent:#FF8A1F; --danger:#ff5f57; --ok:#34d399; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:400 15px/1.6 -apple-system,"Segoe UI","Malgun Gothic",sans-serif; }
  main { max-width:860px; margin:0 auto; padding:20px 16px 60px; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:0 0 10px; }
  .sub { color:var(--muted); font-size:13px; margin:0 0 20px; }
  section { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:14px; }
  section.live { border-color:rgba(255,95,87,.45); background:#140d0d; }
  button { font:inherit; font-weight:700; min-height:44px; padding:0 16px; border-radius:12px; border:1px solid var(--line); background:#1d1d1d; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); color:#090909; border-color:var(--accent); }
  button:disabled { opacity:.4; cursor:not-allowed; }
  input, select { font:inherit; min-height:44px; width:100%; padding:0 12px; border-radius:12px; border:1px solid var(--line); background:#0c0c0c; color:var(--fg); }
  label { display:block; font-size:12px; color:var(--muted); margin:0 0 4px; }
  .row { display:flex; flex-wrap:wrap; gap:10px; }
  .row > div { flex:1 1 160px; min-width:0; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:12px; }
  .badge { display:inline-block; padding:3px 10px; border-radius:999px; font-size:12px; font-weight:700; background:#1d1d1d; color:var(--muted); }
  .badge.ok { background:rgba(52,211,153,.15); color:var(--ok); }
  .badge.warn { background:rgba(255,138,31,.15); color:var(--accent); }
  .badge.bad { background:rgba(255,95,87,.15); color:var(--danger); }
  .msg { margin:10px 0 0; font-size:14px; }
  .err { color:var(--danger); }
  ol.steps { margin:10px 0 0; padding-left:20px; font-size:13px; color:var(--muted); }
  ol.steps li.done { color:var(--ok); }
  ol.steps li.now { color:var(--accent); font-weight:700; }
  table { width:100%; border-collapse:collapse; font-size:13px; margin-top:10px; }
  th, td { text-align:left; padding:6px 8px; border-bottom:1px solid var(--line); vertical-align:top; word-break:break-all; }
  th { color:var(--muted); font-weight:400; }
  .chips { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .chip { padding:6px 10px; border-radius:999px; border:1px solid var(--line); background:#0c0c0c; cursor:pointer; font-size:13px; }
  .chip.sel { border-color:var(--accent); background:rgba(255,138,31,.15); color:var(--accent); font-weight:700; }
  pre { background:#0c0c0c; border:1px solid var(--line); border-radius:12px; padding:12px; font-size:12px; overflow:auto; white-space:pre-wrap; word-break:break-all; }
  .note { font-size:12px; color:var(--muted); margin-top:10px; }
  .hide { display:none; }
</style>
</head>
<body>
<main>
  <h1>RailFlow 실제 연동 <span class="badge warn">로컬 전용</span></h1>
  <p class="sub">이 화면은 이 PC에서만 열립니다(127.0.0.1:${port}). 공식 예매 화면 조회는 이 PC 안에서만 이루어지고, 아이디·비밀번호·결제정보는 입력받지 않습니다.</p>

  <section id="sec-profile">
    <h2>1. 공식 화면 연결</h2>
    <div id="profile-list"></div>
    <div class="row" style="margin-top:10px">
      <div style="flex:3 1 260px">
        <label for="site-url">공식 예매 화면 주소</label>
        <input id="site-url" placeholder="https://..." autocomplete="off">
      </div>
    </div>
    <div class="actions">
      <button class="primary" id="btn-capture-start">공식 화면 열기</button>
      <button id="btn-capture-cancel" class="hide">연결 중단</button>
    </div>

    <div id="capture-live" class="hide">
      <ol class="steps" id="capture-steps"></ol>
      <p class="msg" id="capture-msg"></p>
      <p class="msg err hide" id="capture-err"></p>
      <div class="actions" id="capture-actions"></div>

      <div id="detector-box" class="hide">
        <h2 style="margin-top:16px">화면에서 본 좌석 문구를 분류해 주세요</h2>
        <p class="note">클릭한 칸에 실제로 쓰여 있던 글자입니다. 각 문구가 어떤 뜻인지 골라 주세요.</p>
        <div id="detector-rows"></div>
      </div>
    </div>
  </section>

  <section class="live" id="sec-probe">
    <h2>2. 읽기 전용 좌석 조회 <span class="badge bad">실제 사이트</span></h2>
    <p class="note" style="margin-top:0">이 단계에서는 <strong>예약 버튼을 누르지 않습니다.</strong> 실제 좌석 상태를 읽어 이 화면에 그대로 표시하기만 합니다.</p>
    <div class="row">
      <div><label for="dep">출발역</label><input id="dep" value="동탄"></div>
      <div><label for="arr">도착역</label><input id="arr" value="울산(통도사)"></div>
      <div><label for="date">날짜</label><input id="date" type="date"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div><label for="train">열차번호</label><input id="train" placeholder="화면에 보이는 그대로"></div>
      <div><label for="depart-at">출발시각</label><input id="depart-at" placeholder="08:05"></div>
      <div><label for="arrive-at">도착시각</label><input id="arrive-at" placeholder="10:31"></div>
    </div>
    <div class="row" style="margin-top:10px">
      <div><label for="pax">인원</label><input id="pax" type="number" min="1" max="9" value="1"></div>
      <div><label for="seat">좌석등급</label><select id="seat">
        <option value="any">일반실 또는 특실</option>
        <option value="standard_only">일반실만</option>
        <option value="first_only">특실만</option>
      </select></div>
    </div>
    <div class="actions">
      <button class="primary" id="btn-probe-start">읽기 전용 조회 시작</button>
      <button id="btn-probe-login" class="hide">로그인 완료</button>
      <button id="btn-probe-stop" class="hide">중단</button>
    </div>
    <p class="msg" id="probe-msg"></p>
    <div id="probe-readings"></div>
  </section>

  <section>
    <h2>3. 진단 요약</h2>
    <p class="note" style="margin-top:0">문제가 생기면 아래 내용을 복사해 보내 주세요. 개인정보는 들어가지 않습니다.</p>
    <div class="actions"><button id="btn-diag">진단 요약 만들기</button><button id="btn-copy" class="hide">복사</button></div>
    <pre id="diag" class="hide"></pre>
  </section>
</main>

<script>
const TOKEN = ${JSON.stringify(token)};
const $ = (id) => document.getElementById(id);

async function api(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-railflow-agent-token": TOKEN },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message || data.error || ("요청 실패 (" + res.status + ")"));
  return data;
}

// --- 상태 갱신 -------------------------------------------------------------
let capturePolling = false;

function renderProfiles(profiles) {
  const box = $("profile-list");
  if (!profiles.length) {
    box.innerHTML = '<p class="note" style="margin:0">아직 연결된 공식 화면이 없습니다. 주소를 넣고 [공식 화면 열기] 를 눌러 주세요.</p>';
    return;
  }
  box.innerHTML = profiles.map((p) =>
    '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line)">' +
    '<div style="min-width:0"><strong>' + (p.operator || p.host) + '</strong>' +
    '<div class="note" style="margin:0">' + p.host + ' · ' + (p.capturedAt ? p.capturedAt.slice(0,16).replace("T"," ") : "-") + '</div></div>' +
    '<span class="badge ' + (p.usable ? "ok" : "bad") + '">' + (p.usable ? "사용 가능" : (p.problem || "사용 불가")) + '</span></div>'
  ).join("");
}

function renderCapture(capture) {
  const live = $("capture-live");
  if (!capture) { live.classList.add("hide"); $("btn-capture-cancel").classList.add("hide"); return; }
  live.classList.remove("hide");
  $("btn-capture-cancel").classList.remove("hide");

  const order = capture.steps.map((s) => s.id);
  const nowIndex = order.indexOf(capture.step);
  $("capture-steps").innerHTML = capture.steps.map((s, i) =>
    '<li class="' + (i < nowIndex ? "done" : i === nowIndex ? "now" : "") + '">' + s.title + '</li>'
  ).join("");
  $("capture-msg").textContent = capture.message || capture.hint || "";
  const err = $("capture-err");
  if (capture.error) { err.textContent = capture.error; err.classList.remove("hide"); }
  else err.classList.add("hide");

  const actions = $("capture-actions");
  actions.innerHTML = "";
  const addBtn = (label, handler, primary) => {
    const b = document.createElement("button");
    b.textContent = label;
    if (primary) b.className = "primary";
    b.onclick = () => handler().catch((e) => { $("capture-err").textContent = e.message; $("capture-err").classList.remove("hide"); });
    actions.appendChild(b);
  };

  if (capture.step === "LOGIN") addBtn("로그인 완료", async () => { await api("/api/capture/login", {}); refresh(); }, true);
  if (capture.step === "SEARCH") addBtn("조회 완료", async () => { await api("/api/capture/search", {}); refresh(); startPickLoop(); }, true);
  if (capture.step === "PICK_FIRST") addBtn("특실 없음 (건너뛰기)", async () => { await api("/api/capture/skip", {}); }, false);
  if (capture.step === "PICK_FORM") addBtn("이 항목 건너뛰기", async () => { await api("/api/capture/skip", {}); }, false);
  if (capture.step === "RESERVATION_LIST") addBtn("예약내역 확인", async () => { await api("/api/capture/reservation-list", {}); refresh(); loadObserved(); }, true);
  if (capture.step === "VERIFY") addBtn("자동 검증 시작", async () => {
    const result = await api("/api/capture/verify", { operator: ($("operator-input") || {}).value, detectors: collectDetectors() });
    if (!result.ok) { $("capture-err").textContent = result.snapshot.error || "검증 실패"; $("capture-err").classList.remove("hide"); }
    refresh();
  }, true);

  if (capture.step === "VERIFY" || capture.step === "RESERVATION_LIST") $("detector-box").classList.remove("hide");
  else $("detector-box").classList.add("hide");

  if (capture.finished) { capturePolling = false; }
}

// --- 상태 문구 분류 --------------------------------------------------------
const DETECTOR_CHOICES = [
  ["availableStandard", "일반실 예약 가능"],
  ["availableFirst", "특실 예약 가능"],
  ["soldOut", "매진"],
  ["waitlist", "예약대기"],
  ["standingRoom", "입석"],
  ["loginRequired", "로그인 필요"],
  ["additionalVerification", "추가 인증"],
  ["queueOrRestricted", "대기열·접근 제한"],
  ["", "해당 없음"],
];
let observedTexts = [];
const detectorChoice = {};

async function loadObserved() {
  const data = await api("/api/capture/observed");
  observedTexts = data.texts || [];
  const box = $("detector-rows");
  box.innerHTML =
    '<div style="margin:10px 0"><label for="operator-input">이 사이트의 사업자 이름 (화면에 보이는 그대로)</label>' +
    '<input id="operator-input" placeholder="예: 화면 상단에 표시된 이름"></div>' +
    observedTexts.map((text, i) =>
      '<div style="padding:8px 0;border-top:1px solid var(--line)"><strong>' + text + '</strong>' +
      '<div class="chips" data-i="' + i + '">' +
      DETECTOR_CHOICES.map(([key, label]) =>
        '<span class="chip" data-key="' + key + '">' + label + '</span>').join("") +
      '</div></div>'
    ).join("");
  box.querySelectorAll(".chips").forEach((row) => {
    row.addEventListener("click", (event) => {
      const chip = event.target.closest(".chip");
      if (!chip) return;
      row.querySelectorAll(".chip").forEach((c) => c.classList.remove("sel"));
      chip.classList.add("sel");
      detectorChoice[observedTexts[row.dataset.i]] = chip.dataset.key;
    });
  });
}

function collectDetectors() {
  const mapping = {};
  for (const [text, key] of Object.entries(detectorChoice)) {
    if (!key) continue;
    (mapping[key] = mapping[key] || []).push(text);
  }
  return mapping;
}

// --- 요소 클릭 대기 루프 ---------------------------------------------------
async function startPickLoop() {
  if (capturePolling) return;
  capturePolling = true;
  while (capturePolling) {
    try {
      const snap = await api("/api/capture/await-pick", {});
      renderCapture(snap);
      if (["RESERVATION_LIST", "VERIFY", "DONE"].includes(snap.step)) { capturePolling = false; loadObserved(); }
    } catch (error) {
      $("capture-err").textContent = error.message;
      $("capture-err").classList.remove("hide");
      capturePolling = false;
    }
  }
}

// --- 읽기 전용 조회 --------------------------------------------------------
function renderProbe(probe) {
  if (!probe) { $("probe-msg").textContent = ""; $("probe-readings").innerHTML = ""; return; }
  $("probe-msg").innerHTML = '<span class="badge ' + (probe.active ? "warn" : "ok") + '">' + probe.state + '</span> ' + (probe.message || "");
  $("btn-probe-login").classList.toggle("hide", probe.state !== "WAITING_MANUAL_LOGIN");
  $("btn-probe-stop").classList.toggle("hide", !probe.active);
  $("btn-probe-start").disabled = Boolean(probe.active);

  const rows = probe.readings || [];
  if (!rows.length) { $("probe-readings").innerHTML = ""; return; }
  $("probe-readings").innerHTML =
    '<table><thead><tr><th>회차</th><th>조회 시각</th><th>열차</th><th>구간·시각</th><th>일반실 원문</th><th>특실 원문</th><th>정규화</th></tr></thead><tbody>' +
    rows.map((r) =>
      '<tr><td>' + r.label + '</td><td>' + (r.readAt || "").slice(11,19) + '</td>' +
      '<td>' + (r.trainNumber || "-") + '</td>' +
      '<td>' + r.departure + '→' + r.arrival + '<br>' + (r.departAt||"-") + ' / ' + (r.arriveAt||"-") + '</td>' +
      '<td>' + (r.standardScreenText || "-") + '</td>' +
      '<td>' + (r.firstScreenText || "-") + '</td>' +
      '<td>' + r.status + '</td></tr>'
    ).join("") + '</tbody></table>' +
    '<p class="note">출처: ' + (rows[0].sourceHost || "-") + ' · 위 문구는 실제 화면에서 읽은 그대로입니다.</p>';
}

// --- 전체 갱신 -------------------------------------------------------------
async function refresh() {
  try {
    const state = await api("/api/state");
    renderProfiles(state.profiles || []);
    renderCapture(state.capture);
    renderProbe(state.probe);
  } catch (error) {
    $("probe-msg").textContent = error.message;
  }
}

$("btn-capture-start").onclick = async () => {
  const url = $("site-url").value.trim();
  if (!url) { alert("공식 예매 화면 주소를 넣어 주세요."); return; }
  try { await api("/api/capture/start", { url }); refresh(); }
  catch (error) { $("capture-err").textContent = error.message; $("capture-err").classList.remove("hide"); $("capture-live").classList.remove("hide"); }
};
$("btn-capture-cancel").onclick = async () => { capturePolling = false; await api("/api/capture/cancel", {}); refresh(); };

$("btn-probe-start").onclick = async () => {
  try {
    await api("/api/probe/start", {
      departure: $("dep").value.trim(),
      arrival: $("arr").value.trim(),
      date: $("date").value,
      passengers: Number($("pax").value),
      seatPreference: $("seat").value,
      candidate: {
        id: "probe-1",
        trainNumber: $("train").value.trim(),
        departAt: $("depart-at").value.trim(),
        arriveAt: $("arrive-at").value.trim(),
      },
    });
    refresh();
  } catch (error) { $("probe-msg").innerHTML = '<span class="err">' + error.message + '</span>'; }
};
$("btn-probe-login").onclick = async () => { await api("/api/probe/login", {}); refresh(); };
$("btn-probe-stop").onclick = async () => { await api("/api/probe/stop", {}); refresh(); };

$("btn-diag").onclick = async () => {
  const data = await api("/api/diagnostics");
  $("diag").textContent = JSON.stringify(data, null, 2);
  $("diag").classList.remove("hide");
  $("btn-copy").classList.remove("hide");
};
$("btn-copy").onclick = async () => {
  await navigator.clipboard.writeText($("diag").textContent);
  $("btn-copy").textContent = "복사했습니다";
  setTimeout(() => ($("btn-copy").textContent = "복사"), 1500);
};

$("date").valueAsDate = new Date(Date.now() + 7 * 86400000);
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
}
