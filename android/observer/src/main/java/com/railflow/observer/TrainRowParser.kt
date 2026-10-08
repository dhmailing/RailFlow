package com.railflow.observer

/**
 * 검색 결과 화면에서 열차별 좌석 표시를 읽는다.
 *
 * **서로 다른 열차의 값을 섞지 않는 것이 이 파서의 핵심 제약이다.** 화면
 * 전체에서 "열차번호 목록"과 "좌석문구 목록"을 따로 모아 순서로 짝지으면
 * 한 줄만 어긋나도 전부 틀린다. 그래서 그렇게 하지 않는다.
 *
 * 대신 **열차번호를 포함하는 가장 작은 하위 트리**를 한 행으로 보고, 그 행
 * 안에서만 시각과 좌석 문구를 읽는다. 하위 트리에 열차번호가 두 개 이상
 * 있으면 그것은 행이 아니므로 더 내려간다.
 */
object TrainRowParser {

    private val TRAIN_TYPES = listOf(
        "KTX-산천", "KTX-이음", "KTX", "SRT", "ITX-새마을", "ITX-청춘", "ITX-마음",
        "새마을", "무궁화", "누리로",
    )

    /** "KTX 101", "SRT 357", "무궁화1234" 같은 형태. */
    private val TYPE_WITH_NUMBER = Regex(
        "^(" + TRAIN_TYPES.joinToString("|") { Regex.escape(it) } + ")\\s*제?\\s*(\\d{1,5})\\s*(호|열차)?$",
    )

    /** "제1234호", "1234호" 같은 형태. */
    private val NUMBER_WITH_SUFFIX = Regex("^제?\\s*(\\d{1,5})\\s*(호|열차)$")

    private val TIME = Regex("^(\\d{1,2}):(\\d{2})$")

    private val SEAT_WORDS = listOf(
        "일반실", "특실", "매진", "잔여", "예약", "좌석", "입석", "여유", "매표", "선택",
    )

    /** 이 문구가 열차 식별자인가. */
    fun isTrainLabel(text: String): Boolean {
        val normalized = text.trim()
        if (normalized.isEmpty()) return false
        return TYPE_WITH_NUMBER.matches(normalized) || NUMBER_WITH_SUFFIX.matches(normalized)
    }

    private fun trainLabelsIn(node: ObservedNode): List<String> =
        node.walk().flatMap { it.ownTexts().asSequence() }.filter { isTrainLabel(it) }.toList()

    /**
     * 열차번호를 **정확히 하나** 포함하는 가장 큰 하위 트리를 모은다.
     *
     * 위에서 내려오면서 열차번호가 둘 이상이면 자식으로 더 내려가고, 하나가
     * 되는 지점에서 멈춘다. 그 지점이 행이다 -- 부모에는 다른 열차가 섞여
     * 있었고, 이 노드 안에는 이 열차의 시각·좌석 문구가 함께 들어 있다.
     *
     * 더 내려가면 안 된다. 열차번호 TextView 하나만 남아 시각과 좌석 문구를
     * 잃는다. 반대로 더 올라가면 다른 열차의 문구가 섞인다.
     */
    fun findRows(root: ObservedNode): List<ObservedNode> {
        val rows = mutableListOf<ObservedNode>()

        fun visit(node: ObservedNode) {
            val labels = trainLabelsIn(node)
            when {
                labels.isEmpty() -> return
                labels.size == 1 -> rows.add(node)
                else -> node.children.forEach { visit(it) }
            }
        }

        visit(root)
        return rows
    }

    /** 행 하나를 열차 하나로 읽는다. 값이 없으면 null·UNKNOWN 으로 둔다. */
    fun parseRow(row: ObservedNode): ObservedTrain? {
        val texts = row.walk().flatMap { it.ownTexts().asSequence() }.toList()
        val label = texts.firstOrNull { isTrainLabel(it) } ?: return null
        val times = texts.filter { TIME.matches(it.trim()) }
        val seatLabels = texts.filter { text -> SEAT_WORDS.any { text.contains(it) } }

        return ObservedTrain(
            trainLabel = label.trim(),
            departAt = times.getOrNull(0)?.trim(),
            arriveAt = times.getOrNull(1)?.trim(),
            generalSeat = seatStateFor(seatLabels, "일반실"),
            specialSeat = seatStateFor(seatLabels, "특실"),
            seatLabels = seatLabels.map { it.trim() },
        )
    }

    /**
     * 좌석등급 한 종류의 상태.
     *
     * 해당 등급을 가리키는 문구가 없으면 UNKNOWN 이다. 다른 등급의 문구를
     * 끌어다 쓰지 않는다.
     */
    fun seatStateFor(seatLabels: List<String>, grade: String): SeatState {
        val forGrade = seatLabels.filter { it.contains(grade) }
        if (forGrade.isEmpty()) return SeatState.UNKNOWN
        val joined = forGrade.joinToString(" ")
        return when {
            joined.contains("매진") || joined.contains("좌석없음") || joined.contains("없음") ->
                SeatState.SOLD_OUT
            joined.contains("예약가능") || joined.contains("예약 가능") ||
                joined.contains("좌석있음") || joined.contains("잔여") ||
                joined.contains("여유") || Regex("\\d+\\s*석").containsMatchIn(joined) ->
                SeatState.AVAILABLE
            else -> SeatState.UNKNOWN
        }
    }

    /** 화면 하나를 읽는다. 읽을 것이 없으면 읽기 불가로 돌려준다. */
    fun parseScreen(root: ObservedNode, atMillis: Long, sourcePackage: String?): ObservationResult {
        if (ScreenGuard.isExcluded(root)) {
            return ObservationResult.notReadable(NotReadableReason.EXCLUDED_SCREEN, atMillis, sourcePackage)
        }
        val trains = findRows(root).mapNotNull { parseRow(it) }
        if (trains.isEmpty()) {
            return ObservationResult.notReadable(
                NotReadableReason.NO_TRAIN_INFO_IN_NODES,
                atMillis,
                sourcePackage,
            )
        }
        return ObservationResult.read(trains, atMillis, sourcePackage)
    }
}
