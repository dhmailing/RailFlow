package com.railflow.android

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json

/**
 * 저장 형식 변환만 담당한다. Context 를 받지 않으므로 Android 없이
 * 단위 테스트할 수 있다 -- 조건·후보가 정말 복원되는지 검증하는 자리다.
 */
object AppStateCodec {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    fun encode(state: AppState): String = json.encodeToString(AppState.serializer(), state)

    /**
     * 저장된 문자열을 복원한다. 비었거나 깨졌으면 기본 상태로 돌아간다.
     * 예외로 앱이 죽지 않게 하되, 잘못된 값을 그대로 쓰지도 않는다.
     */
    fun decode(encoded: String?): AppState {
        if (encoded.isNullOrBlank()) return AppState()
        return try {
            json.decodeFromString(AppState.serializer(), encoded)
        } catch (error: SerializationException) {
            AppState()
        } catch (error: IllegalArgumentException) {
            AppState()
        }
    }
}
