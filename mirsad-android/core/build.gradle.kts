plugins {
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvmToolchain(17)
}

// The canonical JSON/model assets live in app/src/main/assets so the APK ships them as
// assets. They are also exposed to core (and its unit tests) as classpath resources.
sourceSets {
    main {
        resources.srcDir("../app/src/main/assets")
    }
}

dependencies {
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.core)
    testImplementation(libs.junit)
    testImplementation(kotlin("test"))
}

tasks.withType<Test>().configureEach {
    useJUnit()
    testLogging {
        events("failed")
        showStandardStreams = true
    }
}

// Classifier trainer: pure Kotlin, no Python. Reads data/seed_messages.csv (+ synthetic rows),
// writes the model into the app assets. Owned by workstream B (ml.train package).
tasks.register<JavaExec>("trainModel") {
    group = "mirsad"
    description = "Train the hashed n-gram logistic regression model and write it to app assets"
    classpath = sourceSets.main.get().runtimeClasspath
    mainClass.set("app.mirsad.core.ml.train.TrainerMainKt")
    args(
        rootProject.file("data").absolutePath,
        rootProject.file("app/src/main/assets/model.bin").absolutePath,
    )
}
