package com.railflow.android

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.map

private val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "railflow_state")

/**
 * 조건·후보를 기기 안에만 저장한다.
 *
 * 화면을 옮기거나 앱을 다시 켜도 값이 유지돼야 한다. 그래서 메모리가 아니라
 * DataStore 에 둔다. 외부로 보내지 않는다.
 */
class AppStateRepository(private val context: Context) {

    val state: Flow<AppState> = context.dataStore.data.map { preferences ->
        AppStateCodec.decode(preferences[STATE_KEY])
    }

    suspend fun save(state: AppState) {
        context.dataStore.edit { preferences ->
            preferences[STATE_KEY] = AppStateCodec.encode(state)
        }
    }

    suspend fun clear() {
        context.dataStore.edit { preferences -> preferences.clear() }
    }

    private companion object {
        val STATE_KEY = stringPreferencesKey("app_state_v1")
    }
}
