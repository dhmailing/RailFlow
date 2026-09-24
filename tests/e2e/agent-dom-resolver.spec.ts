import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

// Agent의 DOM 해석기(overlay.mjs 의 READ_ROWS_BY_PROFILE)를 실제 브라우저에서
// 검사한다.
//
// 여기 쓰는 HTML은 **예매 사이트 흉내가 아니다.** 해석기가
//   - 지정된 자리에서 값을 읽는지
//   - 구조가 바뀌면 "못 읽었다"고 하는지 (비슷한 걸 골라서 진행하지 않는지)
// 만 확인하기 위한 표 형태의 테스트 픽스처다. 좌석 상태 문구도 실제 사이트의
// 것이 아니라 무의미한 값을 쓴다 -- 실제 문구는 사용자의 PC에서 캡처한
// 프로필에서만 온다.
//
// 이 테스트가 통과했다고 실제 사이트 연동이 검증된 것은 아니다.

const OVERLAY_SOURCE = readFileSync(new URL("../../agent/src/overlay.mjs", import.meta.url), "utf8");

/** overlay.mjs 에서 해석기 함수 본문만 꺼내 브라우저에 넣는다. */
function readRowsFnSource(): string {
  const marker = "export const READ_ROWS_BY_PROFILE = ";
  const start = OVERLAY_SOURCE.indexOf(marker);
  expect(start, "READ_ROWS_BY_PROFILE 를 찾지 못했다").toBeGreaterThan(-1);
  const body = OVERLAY_SOURCE.slice(start + marker.length);
  // 다음 export 앞까지가 함수 본문이다.
  const end = body.indexOf("\nexport ");
  return (end === -1 ? body : body.slice(0, end)).trim().replace(/;$/, "");
}

const FIXTURE = `
<table>
  <tbody>
    <tr>
      <td>AAA-100</td><td>08:05</td><td>10:31</td><td>상태문구가나</td><td>상태문구다라</td>
      <td><button>동작</button></td>
    </tr>
    <tr>
      <td>BBB-200</td><td>09:05</td><td>11:31</td><td>상태문구마바</td><td>상태문구사아</td>
      <td><button disabled>동작</button></td>
    </tr>
  </tbody>
</table>`;

const PROFILE_ROW = {
  containerTag: "tr",
  containerRole: "",
  cellCount: 6,
  fieldPaths: {
    trainNumber: { path: [0], cellIndex: 0, tag: "td", role: "", name: "" },
    departAt: { path: [1], cellIndex: 1, tag: "td", role: "", name: "" },
    arriveAt: { path: [2], cellIndex: 2, tag: "td", role: "", name: "" },
    standardSeat: { path: [3], cellIndex: 3, tag: "td", role: "", name: "" },
    firstSeat: { path: [4], cellIndex: 4, tag: "td", role: "", name: "" },
  },
};

async function readRows(page: import("@playwright/test").Page, html: string, profileRow: unknown) {
  await page.setContent(`<!doctype html><meta charset="utf-8">${html}`);
  return page.evaluate(
    ([fnSource, row]) => {
      const fn = eval(`(${fnSource})`) as (r: unknown) => unknown;
      return fn(row);
    },
    [readRowsFnSource(), profileRow] as const,
  );
}

test("지정한 자리에서 값을 읽는다", async ({ page }) => {
  const rows = (await readRows(page, FIXTURE, PROFILE_ROW)) as Array<{
    index: number;
    resolvedAll: boolean;
    fields: Record<string, string | null>;
    controls: Array<{ name: string; disabled: boolean }>;
  }>;

  expect(rows).toHaveLength(2);
  expect(rows[0].resolvedAll).toBe(true);
  expect(rows[0].fields.trainNumber).toBe("AAA-100");
  expect(rows[0].fields.departAt).toBe("08:05");
  expect(rows[0].fields.arriveAt).toBe("10:31");
  expect(rows[0].fields.standardSeat).toBe("상태문구가나");
  expect(rows[0].fields.firstSeat).toBe("상태문구다라");
  expect(rows[1].fields.trainNumber).toBe("BBB-200");
  // 행 안의 컨트롤과 비활성 여부도 함께 읽는다.
  expect(rows[1].controls[0]).toEqual({ name: "동작", disabled: true });
});

test("칸이 줄어 지정한 자리가 사라지면 '못 읽었다'가 된다", async ({ page }) => {
  const shrunk = `
<table><tbody>
  <tr><td>AAA-100</td><td>08:05</td></tr>
</tbody></table>`;
  const rows = (await readRows(page, shrunk, PROFILE_ROW)) as Array<{ resolvedAll: boolean; fields: Record<string, string | null> }>;
  expect(rows[0].resolvedAll).toBe(false);
  // 비슷한 칸을 대신 고르지 않는다.
  expect(rows[0].fields.standardSeat).toBeNull();
});

test("칸 순서가 바뀌면 엉뚱한 값을 읽지 않는다", async ({ page }) => {
  // 열차번호와 상태 칸의 위치가 뒤바뀐 화면.
  const reordered = `
<table><tbody>
  <tr><td>상태문구가나</td><td>08:05</td><td>10:31</td><td>AAA-100</td><td>상태문구다라</td><td><button>동작</button></td></tr>
</tbody></table>`;
  const rows = (await readRows(page, reordered, PROFILE_ROW)) as Array<{ fields: Record<string, string | null> }>;
  // 해석기는 지정된 자리를 그대로 읽는다. 그 결과 열차번호 자리에서 열차번호가
  // 나오지 않으므로, 상위(searchTrain)의 열차 대조가 실패해 중단된다.
  expect(rows[0].fields.trainNumber).toBe("상태문구가나");
  expect(rows[0].fields.trainNumber).not.toBe("AAA-100");
});

test("행 자체가 없으면 빈 결과다", async ({ page }) => {
  const rows = (await readRows(page, "<div>표가 없습니다</div>", PROFILE_ROW)) as unknown[];
  expect(rows).toHaveLength(0);
});

test("role 기반 표에서도 같은 방식으로 읽는다", async ({ page }) => {
  const ariaGrid = `
<div role="grid">
  <div role="row"><span role="cell">CCC-300</span><span role="cell">07:10</span><span role="cell">09:20</span><span role="cell">상태문구자차</span></div>
</div>`;
  const rows = (await readRows(page, ariaGrid, {
    containerTag: "",
    containerRole: "row",
    cellCount: 4,
    fieldPaths: {
      trainNumber: { path: [0], cellIndex: 0, tag: "span", role: "cell", name: "" },
      departAt: { path: [1], cellIndex: 1, tag: "span", role: "cell", name: "" },
      standardSeat: { path: [3], cellIndex: 3, tag: "span", role: "cell", name: "" },
    },
  })) as Array<{ resolvedAll: boolean; fields: Record<string, string | null> }>;
  expect(rows[0].resolvedAll).toBe(true);
  expect(rows[0].fields.trainNumber).toBe("CCC-300");
  expect(rows[0].fields.standardSeat).toBe("상태문구자차");
});
