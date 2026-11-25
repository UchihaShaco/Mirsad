import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Optional build-time defaults so the APK comes pre-configured (file is not required).
//   android/scamshield.properties:
//     serverUrl=https://sync.example.com
//     deviceToken=....
val defaults = Properties().apply {
    val f = rootProject.file("scamshield.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun quoted(key: String) = "\"" + (defaults.getProperty(key) ?: "").replace("\"", "\\\"") + "\""

android {
    namespace = "com.scamshield.guard"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.scamshield.guard"
        minSdk = 26          // Android 8.0+
        targetSdk = 35       // S20 FE runs Android 13 (API 33); also fine on 14/15/16
        versionCode = 1
        versionName = "1.0"
        buildConfigField("String", "DEFAULT_SERVER_URL", quoted("serverUrl"))
        buildConfigField("String", "DEFAULT_DEVICE_TOKEN", quoted("deviceToken"))
    }

    buildFeatures { buildConfig = true }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideload-only demo app: sign release with the debug key so `assembleRelease` gives an installable APK.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.work:work-runtime-ktx:2.9.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.squareup.okhttp3:okhttp-dnsoverhttps:4.12.0")
}
