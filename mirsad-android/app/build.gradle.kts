import com.android.build.api.artifact.SingleArtifact

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
    alias(libs.plugins.ksp)
}

android {
    namespace = "app.mirsad.shield"
    compileSdk = 37

    defaultConfig {
        applicationId = "app.mirsad.shield"
        minSdk = 29
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        vectorDrawables.useSupportLibrary = true
    }

    buildTypes {
        debug {
            // Shrink (no obfuscation) so the debug APK in dist/ stays far under the 25 MB repo file cap.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        release {
            // Debug signing only for the hackathon prototype.
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = false
        checkReleaseBuilds = false
        disable += setOf("ObsoleteLintCustomCheck", "OldTargetApi", "GradleDependency", "AndroidGradlePluginVersion", "NewerVersionAvailable")
    }

    packaging {
        resources.excludes += setOf("META-INF/AL2.0", "META-INF/LGPL2.1", "META-INF/*.kotlin_module")
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(project(":core"))
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.activity.compose)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.ui.tooling.preview)
    implementation(libs.compose.material3)
    debugImplementation(libs.compose.ui.tooling)
    implementation(libs.room.runtime)
    implementation(libs.room.ktx)
    ksp(libs.room.compiler)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    testImplementation(libs.junit)
}

ksp {
    arg("room.schemaLocation", "$projectDir/schemas")
    arg("room.generateKotlin", "true")
}

// ---------------------------------------------------------------------------------------------
// Privacy gate: the merged manifest must never contain android.permission.INTERNET.
// The build fails before packaging if a dependency merges it in.
// ---------------------------------------------------------------------------------------------
abstract class CheckNoInternetPermissionTask : DefaultTask() {
    @get:InputFile
    abstract val mergedManifest: RegularFileProperty

    @get:OutputFile
    abstract val report: RegularFileProperty

    @TaskAction
    fun check() {
        val text = mergedManifest.get().asFile.readText()
        val forbidden = listOf("android.permission.INTERNET", "android.permission.ACCESS_NETWORK_STATE")
        val found = forbidden.filter { text.contains(it) }
        if (found.isNotEmpty()) {
            throw GradleException(
                "Mirsad must not hold network permissions, but the merged manifest contains: $found. " +
                    "Remove the dependency or add tools:node=\"remove\" for it."
            )
        }
        report.get().asFile.apply {
            parentFile.mkdirs()
            writeText("OK: merged manifest holds no INTERNET or ACCESS_NETWORK_STATE permission\n")
        }
    }
}

androidComponents {
    onVariants { variant ->
        val capName = variant.name.replaceFirstChar { it.uppercase() }
        val check = tasks.register<CheckNoInternetPermissionTask>("checkNoInternet$capName") {
            group = "verification"
            description = "Fails if the merged manifest of $capName contains the INTERNET permission"
            mergedManifest.set(variant.artifacts.get(SingleArtifact.MERGED_MANIFEST))
            report.set(layout.buildDirectory.file("reports/no-internet/$capName.txt"))
        }
        tasks.configureEach {
            if (name == "package$capName" || name == "assemble$capName" || name == "lint$capName") {
                dependsOn(check)
            }
        }
    }
}
