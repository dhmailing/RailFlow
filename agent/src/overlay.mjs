// 공식 화면 위에 띄우는 요소 선택 오버레이.
//
// 사용자가 JSON을 편집하는 대신, 실제 화면에서 "이게 열차 행입니다",
// "여기가 일반실 상태입니다" 를 직접 가리키게 한다. Agent는 그 클릭에서
// 의미 구조만 뽑는다 -- CSS 클래스나 id 같은 사이트 내부 구현이 아니라,
// 행을 기준으로 한 상대 위치와 역할(role)·태그다.
//
// 이 파일의 함수들은 문자열로 브라우저에 주입된다. 저장소에는 어떤
// 사이트 선택자도 남지 않는다.
//
// 오버레이가 하지 않는 일: 폼 자동 입력, 로그인, 클릭 대행, DOM 저장.

/**
 * 페이지에 주입되는 본체. `window.__railflowPick(payload)` 는 Playwright의
 * exposeBinding 으로 Agent에 연결된다.
 *
 * @param {{ prompt: string, step: string, scopeToRow: boolean }} options
 */
export function overlayScript({ prompt, step, scopeToRow }) {
  return `(() => {
  const PROMPT = ${JSON.stringify(prompt)};
  const STEP = ${JSON.stringify(step)};
  const SCOPE_TO_ROW = ${JSON.stringify(Boolean(scopeToRow))};

  if (window.__railflowOverlayCleanup) window.__railflowOverlayCleanup();

  const clean = (s) => (s || "").replace(/\\s+/g, " ").trim();

  const box = document.createElement("div");
  box.style.cssText = [
    "position:fixed", "left:0", "right:0", "top:0", "z-index:2147483647",
    "background:#070707", "color:#fff", "font:700 15px/1.5 -apple-system,Segoe UI,sans-serif",
    "padding:12px 16px", "border-bottom:3px solid #FF8A1F", "box-shadow:0 6px 24px rgba(0,0,0,.5)",
  ].join(";");
  box.innerHTML =
    '<div style="color:#FF8A1F;font-size:12px;letter-spacing:.04em">RAILFLOW 화면 연결</div>' +
    '<div id="__rf_prompt" style="margin-top:4px"></div>' +
    '<div style="margin-top:4px;font-weight:400;font-size:12px;color:#aaa">' +
    '마우스를 올리면 테두리가 생깁니다. 맞는 곳을 한 번 클릭하세요. 잘못 눌렀으면 Esc 를 누르고 다시 고르면 됩니다.</div>';
  document.documentElement.appendChild(box);
  box.querySelector("#__rf_prompt").textContent = PROMPT;

  const marker = document.createElement("div");
  marker.style.cssText = [
    "position:fixed", "z-index:2147483646", "pointer-events:none",
    "border:3px solid #FF8A1F", "background:rgba(255,138,31,.16)", "border-radius:6px", "display:none",
  ].join(";");
  document.documentElement.appendChild(marker);

  let current = null;

  const withinOverlay = (el) => el === box || box.contains(el) || el === marker;

  const onMove = (event) => {
    const el = event.target;
    if (!(el instanceof Element) || withinOverlay(el)) return;
    current = el;
    const r = el.getBoundingClientRect();
    marker.style.display = "block";
    marker.style.left = r.left + "px";
    marker.style.top = r.top + "px";
    marker.style.width = r.width + "px";
    marker.style.height = r.height + "px";
  };

  // 행(row) 찾기: 표의 행이거나, 그에 준하는 반복 단위.
  const rowOf = (el) => el.closest('[role="row"], tr, li, [role="listitem"]');

  // 클릭한 요소의 "의미 위치"를 만든다.
  //  - 행 기준 자식 인덱스 경로 (구조)
  //  - 역할/태그/접근성 이름 (교차 확인용)
  // CSS 클래스와 id 는 일부러 담지 않는다.
  const describe = (el, root) => {
    const path = [];
    let node = el;
    while (node && node !== root && node.parentElement) {
      path.unshift(Array.prototype.indexOf.call(node.parentElement.children, node));
      node = node.parentElement;
    }
    const cell = el.closest('[role="cell"], [role="gridcell"], td, th');
    const cellIndex = cell && cell.parentElement
      ? Array.prototype.indexOf.call(cell.parentElement.children, cell)
      : -1;
    return {
      path,
      cellIndex,
      tag: el.tagName.toLowerCase(),
      role: el.getAttribute("role") || "",
      // 접근성 이름은 라벨 문구라 구조 정보다. 사람 이름 같은 값이 들어올 수
      // 있으므로 Agent 쪽에서 다시 마스킹한다.
      name: clean(el.getAttribute("aria-label") || el.textContent).slice(0, 40),
    };
  };

  const onClick = (event) => {
    const el = event.target;
    if (!(el instanceof Element) || withinOverlay(el)) return;
    event.preventDefault();
    event.stopPropagation();

    const row = SCOPE_TO_ROW ? rowOf(el) : null;
    if (SCOPE_TO_ROW && !row) {
      box.querySelector("#__rf_prompt").textContent =
        "이 위치에서는 열차 행을 찾지 못했습니다. 열차 한 편이 표시된 줄 안쪽을 눌러 주세요.";
      return;
    }

    const container = row || el;
    const cells = Array.prototype.slice.call(
      container.querySelectorAll('[role="cell"], [role="gridcell"], td, th'),
    );

    window.__railflowPick({
      step: STEP,
      url: location.href,
      host: location.hostname,
      picked: describe(el, container),
      row: SCOPE_TO_ROW
        ? {
            tag: container.tagName.toLowerCase(),
            role: container.getAttribute("role") || "",
            cellCount: cells.length,
            cellTexts: cells.map((c) => clean(c.textContent).slice(0, 40)),
            rowIndexHint: container.parentElement
              ? Array.prototype.indexOf.call(container.parentElement.children, container)
              : -1,
          }
        : null,
      text: clean(el.textContent).slice(0, 80),
    });
  };

  const onKey = (event) => {
    if (event.key === "Escape") window.__railflowPick({ step: STEP, cancelled: true });
  };

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);

  window.__railflowOverlayCleanup = () => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    box.remove();
    marker.remove();
    delete window.__railflowOverlayCleanup;
  };
})();`;
}

/** 오버레이만 걷어낸다. 페이지 자체는 건드리지 않는다. */
export const REMOVE_OVERLAY = `(() => { if (window.__railflowOverlayCleanup) window.__railflowOverlayCleanup(); })();`;

/**
 * 화면 구조 요약. fingerprint 계산과 자동 검증에 쓴다.
 * 개인정보가 들어가지 않도록 "구조"만 센다 -- 라벨 목록, 버튼 이름, 역할별
 * 개수. 셀의 값(이름·예약번호 등)은 포함하지 않는다.
 */
export const READ_STRUCTURE = () => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
  const labels = Array.from(document.querySelectorAll("input, select, textarea"))
    .map((el) => {
      const id = el.getAttribute("id");
      const labelled = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
      return clean(
        el.getAttribute("aria-label") ||
          labelled?.textContent ||
          el.closest("label")?.textContent ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          "",
      );
    })
    .filter((s) => s && s.length <= 30);

  const controls = Array.from(
    document.querySelectorAll('button, a, [role="button"], input[type="submit"]'),
  )
    .map((el) => clean(el.getAttribute("aria-label") || el.textContent || el.getAttribute("value")))
    .filter((s) => s && s.length <= 30);

  const landmarkCounts = {};
  for (const tag of ["table", "form", "nav", "main", "header", "footer"]) {
    landmarkCounts[tag] = document.querySelectorAll(tag).length;
  }
  for (const role of ["row", "grid", "table", "listitem"]) {
    landmarkCounts[`role:${role}`] = document.querySelectorAll(`[role="${role}"]`).length;
  }

  return {
    url: location.href,
    host: location.hostname,
    formLabels: [...new Set(labels)],
    controlNames: [...new Set(controls)],
    landmarkCounts,
  };
};

/**
 * 프로필의 의미 위치로 행을 읽는다. 경로가 안 맞으면 역할·태그로 한 번 더
 * 찾아보고, 그래도 안 되면 null 을 돌려준다(= 화면이 바뀌었다는 뜻).
 * 절대 "비슷한 것"을 골라서 진행하지 않는다.
 */
export const READ_ROWS_BY_PROFILE = (profileRow) => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const resolve = (row, descriptor) => {
    if (!descriptor) return null;
    // 1) 구조 경로로 먼저 찾는다.
    let node = row;
    for (const index of descriptor.path) {
      node = node?.children?.[index];
      if (!node) break;
    }
    if (node) {
      const tagOk = node.tagName.toLowerCase() === descriptor.tag;
      const roleOk = (node.getAttribute("role") || "") === descriptor.role;
      if (tagOk && roleOk) return node;
    }
    // 2) 경로가 어긋나면 칸 번호로 한 번 더.
    if (descriptor.cellIndex >= 0) {
      const cells = row.querySelectorAll('[role="cell"], [role="gridcell"], td, th');
      const cell = cells[descriptor.cellIndex];
      if (cell && cell.tagName.toLowerCase() === descriptor.tag) return cell;
      if (cell) return cell;
    }
    return null;
  };

  const containerSelector = profileRow.containerRole
    ? `[role="${profileRow.containerRole}"]`
    : profileRow.containerTag || "tr";
  const rows = Array.from(document.querySelectorAll(containerSelector));

  return rows.map((row, index) => {
    const cells = row.querySelectorAll('[role="cell"], [role="gridcell"], td, th');
    const fields = {};
    let resolvedAll = true;
    for (const [key, descriptor] of Object.entries(profileRow.fieldPaths || {})) {
      if (!descriptor) continue;
      const node = resolve(row, descriptor);
      if (!node) {
        fields[key] = null;
        if (key === "trainNumber" || key === "departAt" || key === "standardSeat") resolvedAll = false;
      } else {
        fields[key] = clean(node.textContent).slice(0, 80);
      }
    }
    return {
      index,
      cellCount: cells.length,
      fields,
      resolvedAll,
      rowText: clean(row.textContent).slice(0, 200),
      controls: Array.from(row.querySelectorAll('button, a, [role="button"], input[type="submit"]'))
        .map((el) => ({
          name: clean(el.getAttribute("aria-label") || el.textContent || el.getAttribute("value")).slice(0, 40),
          disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
        }))
        .filter((c) => c.name),
    };
  });
};
