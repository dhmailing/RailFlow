plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.railflow.android"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.railflow.android"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0-readonly"
    }

    buildTypes {
        debug {
            // 설치용 디버그 빌드다. 난독화·축소를 쓰지 않는다.
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            // 이번 단계에서는 release 서명 설정을 두지 않는다.
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        compose = true
        // SettingsScreen 이 BuildConfig.VERSION_NAME 을 읽는다.
        buildConfig = true
    }

    lint {
        abortOnError = true
        disable += setOf("MissingTranslation")
    }
}

dependencies {
    implementation(project(":observer"))

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.ui)
    implementation(libs.androidx.ui.graphics)
    implementation(libs.androidx.ui.tooling.preview)
    implementation(libs.androidx.material3)
    implementation(libs.androidx.datastore.preferences)
    implementation(libs.kotlinx.serialization.json)

    debugImplementation(libs.androidx.ui.tooling)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
