plugins { id("com.android.application"); id("org.jetbrains.kotlin.android") }
android {
    namespace = "house.rabbithole.nasa"
    compileSdk = 35
    defaultConfig {
        applicationId = "house.rabbithole.nasa"
        minSdk = 31
        targetSdk = 35
        versionCode = 2
        versionName = "0.2.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    buildFeatures { buildConfig = true }
    buildTypes { release { isMinifyEnabled = false } }
    packaging.resources.excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF")
}
dependencies {
    implementation("com.hierynomus:smbj:0.14.0")
    implementation("org.slf4j:slf4j-nop:2.0.17")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250107")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
}
