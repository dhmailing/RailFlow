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

    // 배포용 서명. 키스토어는 저장소에 두지 않는다. CI 에서는 Secret 으로,
    // 로컬에서는 환경변수로 넘긴다. 값이 없으면 서명 설정을 만들지 않고
    // release 는 **서명되지 않은 APK** 로 나온다(설치 불가, 그대로 보고한다).
    val keystoreBase64 = System.getenv("RAILFLOW_KEYSTORE_BASE64")
    val keystorePassword = System.getenv("RAILFLOW_KEYSTORE_PASSWORD")
    val keyAlias = System.getenv("RAILFLOW_KEY_ALIAS")
    val keyPassword = System.getenv("RAILFLOW_KEY_PASSWORD")
    val hasSigningMaterial = !keystoreBase64.isNullOrBlank() &&
        !keystorePassword.isNullOrBlank() &&
        !keyAlias.isNullOrBlank() &&
        !keyPassword.isNullOrBlank()

    if (hasSigningMaterial) {
        signingConfigs {
            create("upload") {
                val decoded = layout.buildDirectory.file("upload-keystore.jks").get().asFile
                decoded.parentFile.mkdirs()
                decoded.writeBytes(java.util.Base64.getDecoder().decode(keystoreBase64))
                storeFile = decoded
                storePassword = keystorePassword
                this.keyAlias = keyAlias
                this.keyPassword = keyPassword
            }
        }
    }

    buildTypes {
        debug {
            // 개발용 디버그 빌드다. android:debuggable 이 true 로 들어간다.
            // 공식 문서는 배포 시 false 로 둘 것을 요구한다
            // (privacy-and-security/risks/android-debuggable).
            isMinifyEnabled = false
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
        release {
            // 설치·검토용 빌드. debuggable 이 false 다(기본값).
            isMinifyEnabled = false
            isDebuggable = false
            if (hasSigningMaterial) {
                signingConfig = signingConfigs.getByName("upload")
            }
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
