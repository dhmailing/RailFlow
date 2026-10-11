plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "com.railflow.observer"
    compileSdk = 35

    defaultConfig {
        minSdk = 26
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    lint {
        abortOnError = true
        disable += setOf("MissingTranslation")
    }
}

dependencies {
    // :app 이 ObserverSession.state(StateFlow) 를 타입으로 쓰므로 api 로 노출한다.
    api(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
}
