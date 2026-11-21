plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.unreel.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.unreel.app"
        minSdk = 26
        targetSdk = 35
        versionCode = 5
        versionName = "1.4"
    }

    // A fixed key committed to the repo, so every CI build can be installed over the last one.
    // Signed with every scheme so all Android versions and phone makers accept it.
    signingConfigs {
        create("unreel") {
            storeFile = file("unreel.keystore")
            storePassword = "unreel-app"
            keyAlias = "unreel"
            keyPassword = "unreel-app"
            enableV1Signing = true
            enableV2Signing = true
            enableV3Signing = true
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("unreel")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
}
